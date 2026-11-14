// What every upstream adapter shares: the event type it yields (Anthropic
// streaming events), the error it throws (classified for the fallback logic),
// an SSE reader, and the dispatch from `api` to an adapter.
//
// Adding an API (openai-responses): write `async function* openX(ctx)` that
// yields AnthropicEvent and throws UpstreamError, and add it to `adapterFor` in
// chain.ts.
import type { Canonical } from "./canonical";
import type { Level, ModelDef, ProviderDef } from "./config";

export type AnthropicEvent = { type: string; [k: string]: unknown };

export type ErrorClass =
  | "connect"        // could not reach the upstream, or the connection dropped
  | "server"         // 5xx / 529 / an error event the upstream calls overloaded
  | "rate_limit"     // 429
  | "auth"           // 401 / 403
  | "not_found"      // 404 (wrong model id or URL)
  | "context_length" // the prompt does not fit the model
  | "client"         // any other 4xx: the request itself was refused
  | "first_event_timeout"
  | "idle_timeout"
  | "total_timeout"
  | "incomplete"     // the stream ended before it said it was done
  | "aborted";       // the client went away

export class UpstreamError extends Error {
  constructor(
    public cls: ErrorClass,
    message: string,
    public status?: number,
    public retryAfterMs?: number,
  ) { super(message); }
}

export type OpenCtx = {
  provider: ProviderDef;
  model: ModelDef;
  /** Routed id the client asked for (written into message_start). */
  requested: string;
  req: Canonical;
  level: Level;
  key: string | null;
  signal: AbortSignal;
  /** Called with the exact upstream body, for gateway.captureDir. */
  capture?: (body: unknown) => void;
};

const CONTEXT_RE = /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|exceeds? the (model'?s? )?(maximum|max)/i;

export function retryAfterMs(h: Headers): number | undefined {
  const v = h.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/** Turns a non-2xx upstream response into a classified error. */
export async function httpError(res: Response, who: string): Promise<UpstreamError> {
  let text = "";
  try { text = (await res.text()).slice(0, 2000); } catch {}
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message ?? j?.message ?? j?.detail ?? text;
    if (typeof msg !== "string") msg = JSON.stringify(msg);
  } catch {}
  msg = msg.replace(/\s+/g, " ").trim().slice(0, 500);
  const s = res.status;
  const cls: ErrorClass =
    s === 429 ? "rate_limit"
    : s === 401 || s === 403 ? "auth"
    : s === 404 ? "not_found"
    : s === 408 ? "server"
    : s >= 500 ? "server"
    : CONTEXT_RE.test(msg) ? "context_length"
    : "client";
  return new UpstreamError(cls, `${who} answered HTTP ${s}${msg ? `: ${msg}` : ""}`, s, retryAfterMs(res.headers));
}

export async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, who: string): Promise<Response> {
  try {
    return await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal.aborted) throw new UpstreamError("aborted", "aborted");
    throw new UpstreamError("connect", `cannot reach ${who}: ${(e as Error).message}`);
  }
}

/** Yields `{ event, data }` for each server-sent event of a response body. */
export async function* sse(res: Response, signal: AbortSignal, who: string): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) throw new UpstreamError("incomplete", `${who} sent no body`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "", data: string[] = [];
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch (e) {
        if (signal.aborted) throw new UpstreamError("aborted", "aborted");
        throw new UpstreamError("connect", `${who} dropped the connection: ${(e as Error).message}`);
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          event = ""; data = [];
        } else if (line.startsWith(":")) continue;
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length) yield { event: event || "message", data: data.join("\n") };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export type Adapter = (ctx: OpenCtx) => AsyncGenerator<AnthropicEvent>;
