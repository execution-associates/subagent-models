// Canonical request -> a plain Anthropic Messages body for a third-party
// Anthropic-compatible endpoint, and its stream back (thinking signatures wrapped,
// redacted thinking dropped, the model id rewritten to the one Claude Code asked for).
import type { Canonical, CBlock } from "./canonical";
import { makeSignature } from "./canonical";
import type { Level, ModelDef } from "./config-core";
import { type AnthropicEvent, type OpenCtx, UpstreamError, httpError, post, sse } from "./upstream";

export function toAnthropic(c: Canonical, model: ModelDef, level: Level): Record<string, unknown> {
  const compat = model.anthropic;
  const cache = (x: { cache?: unknown }) => (!compat.stripCacheControl && x.cache ? { cache_control: x.cache } : {});
  const images = model.input.includes("image");
  const messages: { role: string; content: unknown[] }[] = [];
  const push = (role: string, content: unknown[]) => {
    if (!content.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role && role === "user") last.content.push(...content);
    else messages.push({ role, content });
  };
  const block = (b: CBlock): unknown[] => {
    switch (b.type) {
      case "text": return [{ type: "text", text: b.text, ...cache(b) }];
      case "image":
        if (!images) return [{ type: "text", text: "[image omitted: this model takes text only]" }];
        return [{ type: "image", source: b.url ? { type: "url", url: b.url } : { type: "base64", media_type: b.mediaType, data: b.data } }];
      case "tool_use": return [{ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} }];
      case "tool_result":
        return [{
          type: "tool_result", tool_use_id: b.toolUseId, is_error: b.isError || undefined,
          content: b.content.map(x => x.type === "text" ? { type: "text", text: x.text } : images ? { type: "image", source: x.url ? { type: "url", url: x.url } : { type: "base64", media_type: x.mediaType, data: x.data } } : { type: "text", text: "[image omitted]" }),
        }];
      case "thinking":
        // Only this model's own thinking goes back, with the signature it gave.
        return b.origin === model.id ? [{ type: "thinking", thinking: b.thinking, signature: b.upstreamSignature ?? "" }] : [];
    }
  };
  for (const m of c.messages) {
    if (m.role === "system") {
      if (compat.supportsMidConversationSystem) messages.push({ role: "system", content: [{ type: "text", text: m.text }] });
      else push("user", [{ type: "text", text: m.text.startsWith("<system-reminder>") ? m.text : `<system-reminder>\n${m.text}\n</system-reminder>` }]);
    } else push(m.role, m.content.flatMap(block));
  }
  let maxTokens = Math.min(c.maxTokens, model.maxTokens);
  const body: Record<string, unknown> = {
    model: model.upstreamId,
    max_tokens: maxTokens,
    stream: true,
    messages,
  };
  if (c.system.length) body.system = c.system.map(b => ({ type: "text", text: b.text, ...cache(b) }));
  if (c.tools.length) {
    body.tools = c.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema, ...cache(t) }));
    if (c.toolChoice) body.tool_choice = { ...c.toolChoice, ...(c.disableParallelToolUse ? { disable_parallel_tool_use: true } : {}) };
    else if (c.disableParallelToolUse) body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }
  const thinking = model.reasoning && level !== "off" && compat.thinkingMode !== "none";
  if (thinking && compat.thinkingMode === "budget") {
    let budget = compat.thinkingBudgets[level as Exclude<Level, "off">];
    if (budget >= maxTokens) maxTokens = Math.min(model.maxTokens, budget + 8192);
    if (budget >= maxTokens) budget = Math.max(1024, maxTokens - 1024);
    body.max_tokens = maxTokens;
    body.thinking = { type: "enabled", budget_tokens: budget };
  } else if (thinking && compat.thinkingMode === "adaptive") {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: level === "minimal" ? "low" : level };
  }
  if (!thinking && c.temperature !== null) body.temperature = c.temperature;
  if (!thinking && c.topP !== null) body.top_p = c.topP;
  if (c.stopSequences.length) body.stop_sequences = c.stopSequences;
  return { ...body, ...compat.extraBody };
}

export async function* openAnthropic(ctx: OpenCtx): AsyncGenerator<AnthropicEvent> {
  const { provider, model } = ctx;
  const body = toAnthropic(ctx.req, model, ctx.level);
  ctx.capture?.(body);
  const who = `${provider.name} (${model.upstreamId})`;
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...provider.headers };
  if (ctx.key) {
    if (model.anthropic.authHeader === "bearer") headers.authorization = `Bearer ${ctx.key}`;
    else headers["x-api-key"] = ctx.key;
  }
  const res = await post(`${provider.baseUrl}/v1/messages`, headers, body, ctx.signal, who);
  if (!res.ok) throw await httpError(res, who);

  // Upstream block index -> ours (redacted thinking is dropped, so indexes shift).
  const map = new Map<number, number>();
  const sigs = new Map<number, string>();
  let next = 0;
  let finished = false;
  for await (const ev of sse(res, ctx.signal, who)) {
    let j: any;
    try { j = JSON.parse(ev.data); } catch { continue; }
    switch (j.type) {
      case "message_start":
        if (j.message) j.message.model = ctx.requested;
        yield j;
        break;
      case "content_block_start": {
        const cb = j.content_block ?? {};
        if (cb.type === "redacted_thinking") break;
        if (cb.type === "server_tool_use" || cb.type === "web_search_tool_result") break;
        map.set(j.index, next);
        if (cb.type === "thinking") { sigs.set(j.index, cb.signature ?? ""); cb.signature = ""; }
        yield { ...j, index: next++, content_block: cb };
        break;
      }
      case "content_block_delta": {
        const i = map.get(j.index);
        if (i === undefined) break;
        if (j.delta?.type === "signature_delta") { sigs.set(j.index, (sigs.get(j.index) ?? "") + (j.delta.signature ?? "")); break; }
        yield { ...j, index: i };
        break;
      }
      case "content_block_stop": {
        const i = map.get(j.index);
        if (i === undefined) break;
        if (sigs.has(j.index)) yield { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: makeSignature(model.id, sigs.get(j.index) || null) } };
        yield { ...j, index: i };
        break;
      }
      case "message_delta":
        yield j;
        break;
      case "message_stop":
        finished = true;
        yield j;
        break;
      case "ping":
        break;
      case "error": {
        const t = j.error?.type;
        const msg = `${who} stream error: ${j.error?.message ?? JSON.stringify(j.error)}`.slice(0, 500);
        throw new UpstreamError(t === "rate_limit_error" ? "rate_limit" : t === "invalid_request_error" ? "client" : "server", msg);
      }
    }
    if (finished) break;
  }
  if (!finished) throw new UpstreamError("incomplete", `${who}: the stream ended before message_stop`);
}
