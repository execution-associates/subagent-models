// Canonical request -> pi-ai's Context, and pi-ai's stream events -> Anthropic events.
// The transport itself (HTTP, auth, every API family) is omp's.
import type { CImage, Canonical, CText } from "./canonical";
import { makeSignature, portableSchema } from "./canonical";
import type { Level } from "./config-core";
import type { OmpEvent, OmpModelInfo, OmpRuntime } from "./omp-types";
import { type AnthropicEvent, type ErrorClass, UpstreamError } from "./upstream";

const now = () => Date.now();

/** pi-ai Context for a canonical request. */
export function toOmpContext(c: Canonical, model: OmpModelInfo): { systemPrompt: string[]; messages: any[]; tools: any[] } {
  const images = model.input.includes("image");
  const img = (i: CImage): any => (i.data && images ? { type: "image", data: i.data, mimeType: i.mediaType } : { type: "text", text: i.url ? `[image at ${i.url} omitted]` : "[image omitted: this model takes text only]" });
  const parts = (bs: (CText | CImage)[]) => bs.map(b => (b.type === "text" ? { type: "text", text: b.text } : img(b)));
  const names = new Map<string, string>();
  const messages: any[] = [];
  const pushUser = (content: any[]) => {
    if (!content.length) return;
    const last = messages[messages.length - 1];
    if (last?.role === "user") last.content.push(...content);
    else messages.push({ role: "user", content, timestamp: now() });
  };
  for (const m of c.messages) {
    if (m.role === "system") {
      pushUser([{ type: "text", text: m.text.startsWith("<system-reminder>") ? m.text : `<system-reminder>\n${m.text}\n</system-reminder>` }]);
      continue;
    }
    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        messages.push({ role: "toolResult", toolCallId: b.toolUseId, toolName: names.get(b.toolUseId) ?? "", content: b.content.length ? parts(b.content) : [{ type: "text", text: "(no output)" }], isError: b.isError, timestamp: now() });
      }
      pushUser(m.content.flatMap(b => (b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "image" ? [img(b)] : [])));
      continue;
    }
    const content: any[] = [];
    for (const b of m.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "thinking" && b.thinking && b.origin) {
        // Thinking goes back to the model that produced it, with its own signature.
        content.push(b.origin === model.id && b.upstreamSignature ? { type: "thinking", thinking: b.thinking, thinkingSignature: b.upstreamSignature } : { type: "thinking", thinking: b.thinking });
      } else if (b.type === "tool_use") {
        names.set(b.id, b.name);
        content.push({ type: "toolCall", id: b.id, name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> });
      }
    }
    if (!content.length) content.push({ type: "text", text: "" });
    messages.push({
      role: "assistant", content, api: model.api, provider: model.provider, model: model.modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content.some(x => x.type === "toolCall") ? "toolUse" : "stop", timestamp: now(),
    });
  }
  return {
    systemPrompt: c.system.map(b => b.text).filter(Boolean),
    messages,
    tools: c.tools.map(t => ({ name: t.name, description: t.description, parameters: portableSchema(t.inputSchema) })),
  };
}

export function classifyOmpError(msg: { errorMessage?: string; errorStatus?: number }): ErrorClass {
  const s = msg.errorStatus;
  const text = msg.errorMessage ?? "";
  if (s === 429 || /rate.?limit|too many requests/i.test(text)) return "rate_limit";
  if (s === 401 || s === 403 || /unauthori[sz]ed|forbidden|no api key|invalid api key|authentication/i.test(text)) return "auth";
  if (s === 404 || /model .*not found|no such model/i.test(text)) return "not_found";
  if (/context.?(length|window)|maximum context|too many tokens|prompt is too long|input is too long/i.test(text)) return "context_length";
  if (s && s >= 400 && s < 500 && s !== 408) return "client";
  return "server";
}

/**
 * pi-ai events -> Anthropic events. Text and thinking stream as they arrive; a tool
 * call is emitted whole when pi-ai finishes it, because pi-ai interleaves the events
 * of parallel calls and Anthropic blocks cannot interleave.
 */
export class OmpStream {
  private started = false;
  private index = -1;
  private open: null | { kind: "text" | "thinking"; ci: number } = null;
  private thinkingSig = new Map<number, string>();
  private hadTools = false;
  done = false;
  constructor(private requested: string, private origin: string, private msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`) {}

  private start(out: AnthropicEvent[]) {
    if (this.started) return;
    this.started = true;
    out.push({ type: "message_start", message: { id: this.msgId, type: "message", role: "assistant", model: this.requested, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  }
  private close(out: AnthropicEvent[]) {
    if (!this.open) return;
    if (this.open.kind === "thinking") out.push({ type: "content_block_delta", index: this.index, delta: { type: "signature_delta", signature: makeSignature(this.origin, this.thinkingSig.get(this.open.ci) ?? null) } });
    out.push({ type: "content_block_stop", index: this.index });
    this.open = null;
  }
  private openBlock(out: AnthropicEvent[], kind: "text" | "thinking", ci: number) {
    this.close(out);
    this.index++;
    this.open = { kind, ci };
    out.push({ type: "content_block_start", index: this.index, content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" } });
  }

  push(ev: OmpEvent): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];
    switch (ev.type) {
      case "start": case "text_start": case "thinking_start": case "toolcall_start": case "toolcall_delta": case "text_end":
        return out; // message_start waits for content: the first-event timeout measures real output
      case "text_delta": case "thinking_delta": {
        const e = ev as { contentIndex: number; delta: string };
        if (!e.delta) return out;
        this.start(out);
        const kind = ev.type === "text_delta" ? "text" : "thinking";
        if (this.open?.kind !== kind || this.open.ci !== e.contentIndex) this.openBlock(out, kind, e.contentIndex);
        out.push({ type: "content_block_delta", index: this.index, delta: kind === "text" ? { type: "text_delta", text: e.delta } : { type: "thinking_delta", thinking: e.delta } });
        return out;
      }
      case "thinking_end": {
        const e = ev as { contentIndex: number; partial?: { content?: any[] } };
        const sig = e.partial?.content?.[e.contentIndex]?.thinkingSignature;
        if (typeof sig === "string" && sig) this.thinkingSig.set(e.contentIndex, sig);
        return out;
      }
      case "toolcall_end": {
        const tc = (ev as { toolCall: { id: string; name: string; arguments: Record<string, unknown> } }).toolCall;
        this.start(out);
        this.close(out);
        this.index++;
        this.hadTools = true;
        const id = /^[A-Za-z0-9_-]+$/.test(tc.id) ? tc.id : `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        out.push({ type: "content_block_start", index: this.index, content_block: { type: "tool_use", id, name: tc.name, input: {} } });
        out.push({ type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.arguments ?? {}) } });
        out.push({ type: "content_block_stop", index: this.index });
        return out;
      }
      case "done": {
        const e = ev as { reason: string; message: { usage?: any; content?: any[] } };
        // Signatures pi-ai only sets on the final message (thinking item ids, etc.).
        e.message.content?.forEach((c: any, i: number) => { if (c?.type === "thinking" && c.thinkingSignature && !this.thinkingSig.has(i)) this.thinkingSig.set(i, c.thinkingSignature); });
        this.start(out);
        this.close(out);
        const u = e.message.usage ?? {};
        out.push({
          type: "message_delta",
          delta: { stop_reason: this.hadTools || e.reason === "toolUse" ? "tool_use" : e.reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null },
          usage: { input_tokens: u.input ?? 0, output_tokens: u.output ?? 0, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0 },
        });
        out.push({ type: "message_stop" });
        this.done = true;
        return out;
      }
      case "error": {
        const e = ev as { reason: string; error: { errorMessage?: string; errorStatus?: number } };
        if (e.reason === "aborted") throw new UpstreamError("aborted", "aborted");
        const msg = (e.error?.errorMessage ?? "omp transport error").replace(/\s+/g, " ").slice(0, 500);
        throw new UpstreamError(classifyOmpError(e.error ?? {}), `omp ${this.origin}: ${e.error?.errorStatus ? `HTTP ${e.error.errorStatus}: ` : ""}${msg}`, e.error?.errorStatus);
      }
      default:
        return out;
    }
  }
}

/** The adapter: one model call through omp's transport, as Anthropic events. */
export async function* openOmp(rt: OmpRuntime, model: OmpModelInfo, requested: string, req: Canonical, level: Level, signal: AbortSignal, sessionId?: string, capture?: (b: unknown) => void): AsyncGenerator<AnthropicEvent> {
  const ctx = toOmpContext(req, model);
  capture?.({ model: model.id, level, context: ctx });
  const thinking = model.reasoning && level !== "off";
  let it: AsyncIterable<OmpEvent>;
  try {
    it = rt.stream(model, ctx, {
      signal,
      reasoning: thinking ? level : undefined,
      disableReasoning: !thinking,
      maxTokens: Math.min(req.maxTokens, model.maxTokens),
      temperature: thinking ? undefined : req.temperature ?? undefined,
      topP: thinking ? undefined : req.topP ?? undefined,
      stopSequences: req.stopSequences.length ? req.stopSequences : undefined,
      sessionId,
    });
  } catch (e) {
    throw new UpstreamError("server", `omp ${model.id}: ${(e as Error).message}`);
  }
  const conv = new OmpStream(requested, model.id);
  try {
    for await (const ev of it) {
      for (const a of conv.push(ev)) yield a;
      if (conv.done) return;
    }
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (signal.aborted) throw new UpstreamError("aborted", "aborted");
    throw new UpstreamError("connect", `omp ${model.id}: ${(e as Error).message}`);
  }
  if (!conv.done) throw new UpstreamError("incomplete", `omp ${model.id}: the stream ended before it finished`);
}
