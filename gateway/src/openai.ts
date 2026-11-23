// Canonical request -> OpenAI chat completions, and its stream -> Anthropic events.
import type { CBlock, CImage, CMessage, Canonical, CText } from "./canonical";
import { makeSignature, portableSchema } from "./canonical";
import type { Level, ModelDef } from "./config-core";
import { type AnthropicEvent, type OpenCtx, UpstreamError, httpError, post, sse } from "./upstream";

type OaiPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OaiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type OaiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OaiPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[]; [reasoning: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

/** OpenAI function names are [A-Za-z0-9_-]{1,64}; MCP names can be longer or use other characters. */
export class ToolNames {
  private toSafe = new Map<string, string>();
  private toOrig = new Map<string, string>();
  safe(name: string): string {
    let s = this.toSafe.get(name);
    if (s) return s;
    s = /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 55) + "_" + hash(name);
    while (this.toOrig.has(s) && this.toOrig.get(s) !== name) s = s.slice(0, 55) + "_" + hash(s + "x");
    this.toSafe.set(name, s);
    this.toOrig.set(s, name);
    return s;
  }
  orig(safe: string): string { return this.toOrig.get(safe) ?? safe; }
}
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36).padStart(7, "0").slice(0, 8);
}

const imageUrl = (i: CImage) => (i.url ? i.url : `data:${i.mediaType};base64,${i.data}`);
const textOf = (blocks: (CText | CImage)[], images: boolean) =>
  blocks.map(b => (b.type === "text" ? b.text : images ? "" : "[image omitted: this model takes text only]")).filter(Boolean).join("\n");

/** Translates a canonical request into a chat-completions body. */
export function toOpenAI(c: Canonical, model: ModelDef, level: Level, names: ToolNames): Record<string, unknown> {
  const compat = model.openai;
  const images = model.input.includes("image");
  const out: OaiMessage[] = [];
  const systemText = c.system.map(b => b.text).filter(Boolean).join("\n\n");
  if (systemText) out.push({ role: "system", content: systemText });

  const pushUser = (parts: OaiPart[]) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    // Consecutive user turns merge: some chat templates reject two in a row.
    if (last?.role === "user") {
      const prev: OaiPart[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      last.content = simplify([...prev, ...parts]);
    } else out.push({ role: "user", content: simplify(parts) });
  };

  for (const m of c.messages) {
    if (m.role === "system") {
      if (compat.supportsMultipleSystemMessages) out.push({ role: "system", content: m.text });
      else pushUser([{ type: "text", text: m.text.startsWith("<system-reminder>") ? m.text : `<system-reminder>\n${m.text}\n</system-reminder>` }]);
      continue;
    }
    if (m.role === "user") {
      // Tool results go first: each must directly follow the assistant turn that called it.
      const toolImages: OaiPart[] = [];
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const body = textOf(b.content, images) || (b.content.length ? "" : "(no output)");
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.isError ? `Error: ${body}` : body || "(see the image below)" });
        const imgs = b.content.filter((x): x is CImage => x.type === "image");
        if (imgs.length && images) {
          toolImages.push({ type: "text", text: `[image${imgs.length > 1 ? "s" : ""} returned by tool call ${b.toolUseId}]` });
          for (const i of imgs) toolImages.push({ type: "image_url", image_url: { url: imageUrl(i) } });
        }
      }
      const parts: OaiPart[] = [...toolImages];
      for (const b of m.content) {
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image") parts.push(images ? { type: "image_url", image_url: { url: imageUrl(b) } } : { type: "text", text: "[image omitted: this model takes text only]" });
      }
      pushUser(parts);
      continue;
    }
    // assistant
    const text: string[] = [];
    const reasoning: string[] = [];
    const calls: OaiToolCall[] = [];
    for (const b of m.content) {
      if (b.type === "text") text.push(b.text);
      else if (b.type === "thinking" && b.thinking) reasoning.push(b.thinking);
      else if (b.type === "tool_use") calls.push({ id: b.id, type: "function", function: { name: names.safe(b.name), arguments: JSON.stringify(b.input ?? {}) } });
    }
    const last = out[out.length - 1];
    let msg: Extract<OaiMessage, { role: "assistant" }>;
    if (last?.role === "assistant" && !last.tool_calls) {
      // Claude Code can store one response as several assistant rows: merge them.
      msg = last;
      if (text.length) msg.content = (msg.content ?? "") + text.join("");
    } else {
      msg = { role: "assistant", content: text.length ? text.join("") : null };
      out.push(msg);
    }
    if (calls.length) msg.tool_calls = [...(msg.tool_calls ?? []), ...calls];
    const replay = compat.replayReasoning === "all" || (compat.replayReasoning === "tool-calls" && msg.tool_calls?.length);
    if (reasoning.length && replay) msg[compat.reasoningContentField] = ((msg[compat.reasoningContentField] as string) ?? "") + reasoning.join("\n");
    if (msg.content === null && !msg.tool_calls?.length) msg.content = "";
  }

  const body: Record<string, unknown> = {
    model: model.upstreamId,
    messages: out,
    stream: true,
    [compat.maxTokensField]: Math.min(c.maxTokens, model.maxTokens),
  };
  if (compat.supportsUsageInStreaming) body.stream_options = { include_usage: true };
  if (c.tools.length) {
    body.tools = c.tools.map(t => ({ type: "function", function: { name: names.safe(t.name), description: t.description, parameters: cleanSchema(t.inputSchema) } }));
    if (compat.supportsToolChoice && c.toolChoice) {
      body.tool_choice = c.toolChoice.type === "auto" ? "auto" : c.toolChoice.type === "any" ? "required" : c.toolChoice.type === "none" ? "none" : { type: "function", function: { name: names.safe((c.toolChoice as { name: string }).name) } };
    }
    if (c.disableParallelToolUse) body.parallel_tool_calls = false;
  }
  if (model.reasoning && compat.supportsReasoningEffort) {
    const v = compat.reasoningEffortMap[level];
    if (v !== null && v !== undefined) body.reasoning_effort = v;
  }
  if (c.temperature !== null) body.temperature = c.temperature;
  if (c.topP !== null) body.top_p = c.topP;
  if (c.stopSequences.length) body.stop = c.stopSequences.slice(0, 4);
  return { ...body, ...compat.extraBody };
}

function simplify(parts: OaiPart[]): string | OaiPart[] {
  return parts.every(p => p.type === "text") ? parts.map(p => (p as { text: string }).text).join("\n\n") : parts;
}

function cleanSchema(s: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _, ...rest } = portableSchema(s);
  return rest.type ? rest : { type: "object", ...rest };
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

/** OpenAI counts cached tokens inside prompt_tokens; Anthropic's input_tokens excludes them. */
export function mapUsage(u: any): Usage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

export function mapStop(finish: string | null, hadTools: boolean): string {
  if (hadTools) return "tool_use";
  switch (finish) {
    case "length": return "max_tokens";
    case "content_filter": return "refusal";
    case "tool_calls": case "function_call": return "tool_use";
    default: return "end_turn";
  }
}

/**
 * Turns chat-completion chunks into Anthropic stream events. Blocks are strictly
 * sequential (Anthropic never interleaves them): a change of kind closes the open
 * block. Parallel tool calls arrive one after another and each becomes a block.
 */
export class OpenAIStream {
  private started = false;
  private index = -1;
  private open: null | { kind: "text" } | { kind: "thinking" } | { kind: "tool"; oai: number } = null;
  private toolBlocks = new Map<number, { id: string; name: string; announced: boolean; pending: string; closed: boolean }>();
  private finish: string | null = null;
  private usage: Usage | null = null;
  private hadTools = false;
  done = false;

  constructor(private requested: string, private origin: string, private names: ToolNames, private reasoningField: string, private msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`) {}

  private start(out: AnthropicEvent[]) {
    if (this.started) return;
    this.started = true;
    out.push({ type: "message_start", message: { id: this.msgId, type: "message", role: "assistant", model: this.requested, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  }

  private close(out: AnthropicEvent[]) {
    if (!this.open) return;
    if (this.open.kind === "thinking") out.push({ type: "content_block_delta", index: this.index, delta: { type: "signature_delta", signature: makeSignature(this.origin) } });
    if (this.open.kind === "tool") {
      const t = this.toolBlocks.get(this.open.oai)!;
      t.closed = true;
    }
    out.push({ type: "content_block_stop", index: this.index });
    this.open = null;
  }

  private openBlock(out: AnthropicEvent[], block: Record<string, unknown>, open: NonNullable<OpenAIStream["open"]>) {
    this.close(out);
    this.index++;
    this.open = open;
    out.push({ type: "content_block_start", index: this.index, content_block: block });
  }

  push(chunk: any): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];
    if (chunk?.error) {
      const e = chunk.error;
      const msg = typeof e === "string" ? e : e.message ?? JSON.stringify(e);
      const code = Number(e.code ?? e.status);
      throw new UpstreamError(code === 429 ? "rate_limit" : code >= 400 && code < 500 ? "client" : "server", `upstream stream error: ${String(msg).slice(0, 400)}`, Number.isFinite(code) ? code : undefined);
    }
    this.start(out);
    if (chunk?.usage) this.usage = mapUsage(chunk.usage);
    const choice = chunk?.choices?.[0];
    if (!choice) return out;
    const d = choice.delta ?? {};
    const r = d[this.reasoningField] ?? d.reasoning_content ?? d.reasoning;
    if (typeof r === "string" && r) {
      if (this.open?.kind !== "thinking") this.openBlock(out, { type: "thinking", thinking: "", signature: "" }, { kind: "thinking" });
      out.push({ type: "content_block_delta", index: this.index, delta: { type: "thinking_delta", thinking: r } });
    }
    if (typeof d.content === "string" && d.content) {
      if (this.open?.kind !== "text") this.openBlock(out, { type: "text", text: "" }, { kind: "text" });
      out.push({ type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: d.content } });
    }
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const i: number = typeof tc.index === "number" ? tc.index : 0;
      let t = this.toolBlocks.get(i);
      if (!t) { t = { id: "", name: "", announced: false, pending: "", closed: false }; this.toolBlocks.set(i, t); }
      if (tc.id) t.id = String(tc.id);
      if (tc.function?.name) t.name += tc.function.name;
      const args: string = tc.function?.arguments ?? "";
      if (!t.announced && t.name) {
        t.announced = true;
        this.hadTools = true;
        const id = /^[A-Za-z0-9_-]+$/.test(t.id) ? t.id : `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        t.id = id;
        this.openBlock(out, { type: "tool_use", id, name: this.names.orig(t.name), input: {} }, { kind: "tool", oai: i });
        if (t.pending) { out.push({ type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: t.pending } }); t.pending = ""; }
      }
      if (args) {
        if (!t.announced) t.pending += args;
        else if (this.open?.kind === "tool" && this.open.oai === i) out.push({ type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: args } });
        else throw new UpstreamError("server", `upstream interleaved arguments of tool call ${i} after it ended; cannot be expressed as Anthropic blocks`);
      }
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  /** Called when the upstream says [DONE] or its body ends. */
  end(sawDone: boolean): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];
    if (!sawDone && !this.finish) throw new UpstreamError("incomplete", "the upstream stream ended before it finished");
    this.start(out);
    this.close(out);
    out.push({ type: "message_delta", delta: { stop_reason: mapStop(this.finish, this.hadTools), stop_sequence: null }, usage: this.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    out.push({ type: "message_stop" });
    this.done = true;
    return out;
  }
}

export async function* openOpenAI(ctx: OpenCtx): AsyncGenerator<AnthropicEvent> {
  const { provider, model } = ctx;
  const names = new ToolNames();
  const body = toOpenAI(ctx.req, model, ctx.level, names);
  ctx.capture?.(body);
  const who = `${provider.name} (${model.upstreamId})`;
  const headers: Record<string, string> = { ...provider.headers };
  if (ctx.key) headers.authorization = `Bearer ${ctx.key}`;
  const res = await post(`${provider.baseUrl}/chat/completions`, headers, body, ctx.signal, who);
  if (!res.ok) throw await httpError(res, who);
  const conv = new OpenAIStream(ctx.requested, model.id, names, model.openai.reasoningContentField);
  let sawDone = false;
  for await (const ev of sse(res, ctx.signal, who)) {
    if (ev.data === "[DONE]") { sawDone = true; break; }
    let j: unknown;
    try { j = JSON.parse(ev.data); } catch { continue; }
    for (const e of conv.push(j)) yield e;
  }
  for (const e of conv.end(sawDone)) yield e;
}

export type { CBlock, CMessage };
