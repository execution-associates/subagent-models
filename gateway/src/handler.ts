// The Anthropic Messages request path, shared by the Bun gateway (server.ts) and
// the hosted service: normalize, walk the chain, stream or aggregate the answer,
// hand a Claude entry back to the mod. Web APIs only (fetch, streams, timers); the
// caller supplies the config, keys, cooldowns and where a finished request is recorded.
import { BadRequest, estimateTokens, normalize } from "./canonical";
import { type AttemptLog, type ChainResult, type Committed, type Deps, chainFor, runChain } from "./chain";
import { scrub } from "./key-source";
import { type AnthropicEvent, UpstreamError } from "./upstream";

export const FALLBACK_HEADER = "x-subagent-models-claude-fallback";
export const EFFORT_HEADER = "x-subagent-models-effort";

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
/** One finished request, as the access log and telemetry see it. Holds no prompt or response text. */
export type Entry = {
  ts: string; id: string; agentId?: string; compaction?: string; requested: string; stream: boolean; servedBy?: string; level?: string;
  status: number; outcome: string; attempts: AttemptLog[]; ttfbMs?: number; durationMs: number;
  usage?: Usage; stopReason?: string; error?: string; dropped?: string[];
};

export type HandlerDeps = Deps & {
  /** Called once per request when it ends, its error already scrubbed of keys. */
  record: (e: Entry) => void;
  /** The engine's raw request, for gateway.captureDir (Bun only). */
  captureRequest?: (started: number, headers: Headers, body: unknown) => void;
};
type Finish = (s: number, o: string, x?: Partial<Entry>) => void;

function record(deps: HandlerDeps, e: Entry) {
  e.error &&= scrub(e.error, deps.keys.known());
  try { deps.record(e); } catch {}
}

/** POST /v1/messages/count_tokens: estimated locally (no upstream has the Anthropic count). */
export async function handleCountTokens(req: Request): Promise<Response> {
  try { return Response.json({ input_tokens: estimateTokens((await req.json()) as Record<string, any>) }); }
  catch { return errorResponse(400, "invalid_request_error", "subagent-models: count_tokens body is not JSON"); }
}

export async function handleMessages(req: Request, deps: HandlerDeps): Promise<Response> {
  const started = Date.now();
  const entry: Entry = { ts: new Date(started).toISOString(), id: `r${started.toString(36)}${Math.random().toString(36).slice(2, 6)}`, agentId: req.headers.get("x-claude-code-agent-id") ?? undefined, compaction: req.headers.get("x-claude-code-compaction") ?? undefined, requested: "?", stream: false, status: 0, outcome: "", attempts: [], durationMs: 0 };
  let canon;
  try {
    const raw = await req.json();
    deps.captureRequest?.(started, req.headers, raw);
    if (raw && typeof raw === "object" && "thread" in raw && (raw as { thread?: unknown }).thread) {
      // Claude Code's message-threads beta keeps the conversation on Anthropic's
      // side and sends only new messages. The gateway keeps no threads: this
      // refusal (the error code Claude Code recognises) makes it resend the turn
      // whole and stay stateless on this model for the rest of the session.
      Object.assign(entry, { requested: String((raw as { model?: unknown }).model ?? "?"), status: 400, outcome: "thread_refused", durationMs: Date.now() - started });
      record(deps, entry);
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thread_unsupported_request: subagent-models keeps no server-side message threads; send the whole conversation", details: { error_code: "thread_unsupported_request" } } }), {
        status: 400,
        headers: { "content-type": "application/json", "x-should-retry": "false" },
      });
    }
    canon = normalize(raw);
  } catch (e) {
    const msg = e instanceof BadRequest ? e.message : "the body is not JSON";
    Object.assign(entry, { status: 400, outcome: "bad_request", error: msg, durationMs: Date.now() - started });
    record(deps, entry);
    return errorResponse(400, "invalid_request_error", `subagent-models: ${msg}`);
  }
  entry.requested = canon.model;
  entry.stream = canon.stream;
  entry.dropped = canon.dropped.length ? canon.dropped : undefined;
  const signal = req.signal;
  const finish = (status: number, outcome: string, extra: Partial<Entry> = {}) => {
    Object.assign(entry, { status, outcome, durationMs: Date.now() - started }, extra);
    record(deps, entry);
  };

  if (!canon.stream) return nonStreaming(canon, deps, signal, entry, finish);

  const result = await runChain(canon, deps, signal, entry.attempts, started, entry.agentId);
  if (result.kind !== "stream") return notStreamed(result, deps, finish);
  entry.servedBy = result.target.model.id;
  entry.level = result.level;
  entry.ttfbMs = Date.now() - started;
  return streamResponse(result, deps, finish);
}

function notStreamed(result: Exclude<ChainResult, Committed>, deps: HandlerDeps, finish: Finish): Response {
  if (result.kind === "aborted") { finish(499, "aborted"); return new Response(null, { status: 499 }); }
  if (result.kind === "claude") {
    finish(409, "claude_fallback", { servedBy: `anthropic/${result.model}`, level: result.level ?? undefined });
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `subagent-models: the chain reached the Claude fallback ${result.model}, which only the Claude Code mod can serve; this response means the mod did not pick it up` } }), {
      status: 409,
      headers: { "content-type": "application/json", "x-should-retry": "false", [FALLBACK_HEADER]: result.model, ...(result.level ? { [EFFORT_HEADER]: result.level } : {}) },
    });
  }
  finish(result.status, "error", { error: result.message });
  return errorResponse(result.status, result.errorType, scrub(result.message, deps.keys.known()));
}

function streamResponse(c: Committed, deps: HandlerDeps, finish: Finish): Response {
  const enc = new TextEncoder();
  const cfg = deps.cfg;
  const model = c.target.model;
  const idleMs = ("timeouts" in model ? model.timeouts : cfg.timeouts).streamIdleTimeoutSeconds * 1000;
  const pingMs = cfg.gateway.pingIntervalSeconds * 1000;
  const keys = deps.keys;
  let usage: Usage | undefined, stopReason: string | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const write = (ev: AnthropicEvent) => { if (!closed) ctl.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)); };
      const note = (ev: AnthropicEvent) => {
        if (ev.type === "message_delta") {
          usage = { ...(usage ?? {}), ...((ev.usage as Usage) ?? {}) };
          stopReason = (ev.delta as { stop_reason?: string })?.stop_reason ?? stopReason;
        } else if (ev.type === "message_start") usage = ((ev.message as { usage?: Usage })?.usage) ?? usage;
      };
      note(c.first);
      write(c.first);
      let pending: Promise<IteratorResult<AnthropicEvent>> = c.rest.next();
      let lastData = Date.now();
      let outcome = "ok";
      let error: string | undefined;
      try {
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const wait = Math.max(1, Math.min(pingMs, idleMs - (Date.now() - lastData)));
          const tick = new Promise<"tick">(r => { timer = setTimeout(() => r("tick"), wait); });
          const r = await Promise.race([pending, tick]);
          clearTimeout(timer);
          if (r === "tick") {
            if (Date.now() - lastData >= idleMs) throw new UpstreamError("idle_timeout", `no data from ${model.id} for ${idleMs / 1000}s mid-stream`);
            ctl.enqueue(enc.encode(`event: ping\ndata: {"type": "ping"}\n\n`));
            continue;
          }
          if (r.done) break;
          lastData = Date.now();
          note(r.value);
          write(r.value);
          pending = c.rest.next();
        }
      } catch (e) {
        pending.catch(() => {});
        const err = e instanceof UpstreamError ? e : new UpstreamError("server", String((e as Error)?.message ?? e));
        c.abort();
        if (err.cls === "aborted" || closed) outcome = "aborted";
        else {
          // Committed: the model cannot be switched under the client. The model sits
          // out its cooldown and the client gets an overloaded error, which Claude Code
          // retries; the retry walks the chain past this model.
          outcome = `mid_stream_${err.cls}`;
          error = scrub(err.message, keys.known());
          deps.cooldowns.set(model.id, deps.cfg.retry.cooldownSeconds * 1000, `mid-stream ${err.cls}`);
          write({ type: "error", error: { type: "overloaded_error", message: `subagent-models: ${model.id} failed mid-stream (${error}); retrying walks the fallback chain` } });
        }
      }
      if (!closed) { closed = true; try { ctl.close(); } catch {} }
      finish(200, outcome, { usage, stopReason, error });
    },
    cancel() {
      closed = true;
      c.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-subagent-models-served-by": model.id },
  });
}

/** stream:false — nothing reaches the client until the end, so a mid-stream failure can still walk the chain. */
async function nonStreaming(canon: ReturnType<typeof normalize>, deps: HandlerDeps, signal: AbortSignal, entry: Entry, finish: Finish): Promise<Response> {
  const chainLen = chainFor(deps.cfg, canon.model)?.length ?? 1;
  for (let round = 0; round < chainLen; round++) {
    const result = await runChain(canon, deps, signal, entry.attempts, Date.parse(entry.ts), entry.agentId);
    if (result.kind !== "stream") return notStreamed(result, deps, finish);
    try {
      const tm = "timeouts" in result.target.model ? result.target.model.timeouts : deps.cfg.timeouts;
      const msg = await aggregate(result, tm.streamIdleTimeoutSeconds * 1000);
      finish(200, "ok", { servedBy: result.target.model.id, level: result.level, usage: msg.usage, stopReason: msg.stop_reason });
      return Response.json(msg, { headers: { "x-subagent-models-served-by": result.target.model.id } });
    } catch (e) {
      result.abort();
      const err = e instanceof UpstreamError ? e : new UpstreamError("server", String(e));
      entry.attempts.push({ target: result.target.ref, outcome: `mid_stream_${err.cls}`, ms: 0 });
      if (err.cls === "aborted") return notStreamed({ kind: "aborted" }, deps, finish);
      deps.cooldowns.set(result.target.model.id, deps.cfg.retry.cooldownSeconds * 1000, `mid-stream ${err.cls}`);
    }
  }
  return notStreamed({ kind: "error", status: 503, errorType: "api_error", message: `subagent-models: every model in the chain for ${canon.model} failed mid-response` }, deps, finish);
}

/** Collects a stream into one Messages API response. */
export async function aggregate(c: Committed, idleMs: number) {
  const msg: any = { ...(c.first as any).message, content: [] };
  const blocks: any[] = [];
  const partial = new Map<number, string>();
  const apply = (ev: any) => {
    switch (ev.type) {
      case "content_block_start": blocks[ev.index] = { ...ev.content_block }; break;
      case "content_block_delta": {
        const b = blocks[ev.index]; const d = ev.delta;
        if (!b || !d) break;
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
        else if (d.type === "input_json_delta") partial.set(ev.index, (partial.get(ev.index) ?? "") + d.partial_json);
        break;
      }
      case "message_delta":
        msg.stop_reason = ev.delta?.stop_reason ?? msg.stop_reason;
        msg.usage = { ...msg.usage, ...ev.usage };
        break;
    }
  };
  apply(c.first);
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([c.rest.next(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new UpstreamError("idle_timeout", `no data for ${idleMs / 1000}s`)), idleMs); })]);
    clearTimeout(timer);
    if (r.done) break;
    apply(r.value);
  }
  for (const [i, s] of partial) { try { blocks[i].input = JSON.parse(s || "{}"); } catch { blocks[i].input = {}; } }
  msg.content = blocks.filter(Boolean);
  return msg;
}

export function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    // The gateway already retried and walked the chain: Claude Code must not retry it again.
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
}
