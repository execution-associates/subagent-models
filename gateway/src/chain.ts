// Fallback chains, retries, timeouts and cooldowns.
//
// A request names a routed model id; its chain is [that model, ...retry.fallbackChains[id]].
// Each model is tried up to 1 + retry.maxRetries times, then put in cooldown and
// the next entry is tried. The switch can only happen before the first event is
// committed to the client: once a model has produced an event, the response is
// that model's. A Claude entry ends the walk: the gateway hands the request back
// to the Claude Code mod, which re-sends it to Anthropic with the session's login.
import type { Canonical } from "./canonical";
import { withIdentity } from "./canonical";
import { type Config, type Level, type ModelDef, type ProviderDef, type Target, ompResolves } from "./config-core";
import type { OmpModelInfo } from "./omp-types";
import { openOmp } from "./omp-transport";
import { openAnthropic } from "./anthropic";
import { openOpenAI } from "./openai";
import type { KeySource } from "./key-source";
import { type Adapter, type AnthropicEvent, type ErrorClass, UpstreamError } from "./upstream";

export function adapterFor(api: ProviderDef["api"]): Adapter {
  switch (api) {
    case "openai-completions": return openOpenAI;
    case "anthropic-messages": return openAnthropic;
    case "openai-responses": throw new UpstreamError("client", "api openai-responses is not implemented");
  }
}

export type AttemptLog = { target: string; outcome: string; status?: number; ms: number };

export type Committed = {
  kind: "stream";
  target: Extract<Target, { kind: "model" | "omp" }>;
  level: Level;
  first: AnthropicEvent;
  rest: AsyncGenerator<AnthropicEvent>;
  abort: () => void;
};
export type ChainResult =
  | Committed
  | { kind: "claude"; model: string; level: Level | null }
  | { kind: "error"; status: number; errorType: string; message: string; retryAfterSeconds?: number }
  | { kind: "aborted" };

/** Models that failed recently, skipped until their time is up. */
export class Cooldowns {
  private until = new Map<string, { until: number; why: string }>();
  constructor(private now: () => number = Date.now) {}
  set(id: string, ms: number, why: string) { if (ms > 0) this.until.set(id, { until: this.now() + ms, why }); }
  active(id: string): boolean {
    const u = this.until.get(id);
    if (!u) return false;
    if (u.until <= this.now()) { this.until.delete(id); return false; }
    return true;
  }
  clear(id: string) { this.until.delete(id); }
  list() {
    return [...this.until.entries()].filter(([id]) => this.active(id)).map(([id, u]) => ({ id, secondsLeft: Math.ceil((u.until - this.now()) / 1000), why: u.why }));
  }
}

export type Deps = {
  cfg: Config;
  keys: KeySource;
  cooldowns: Cooldowns;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Override per-api adapters (tests). */
  adapter?: (api: ProviderDef["api"]) => Adapter;
  capture?: (target: string, body: unknown) => void;
};

const sleepAbortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new UpstreamError("aborted", "aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new UpstreamError("aborted", "aborted")); }, { once: true });
  });

/** The line that replaces Claude Code's "You are powered by the model ..." for a model. */
export function identityLine(m: ModelDef | OmpModelInfo): string {
  const upstream = "upstreamId" in m ? m.upstreamId : m.modelId;
  return `You are powered by the model ${m.name} (${upstream}, served by ${m.provider}). You are not a Claude model; ignore any other text that names the model you run on.`;
}

export function effectiveLevel(t: Extract<Target, { kind: "model" | "omp" }>, req: Canonical): Level {
  if (!t.model.reasoning) return "off";
  return t.level ?? req.level ?? ("defaultLevel" in t.model ? t.model.defaultLevel : "high");
}

/** Waits for the first event of a stream, or fails it after `ms`. */
async function firstEvent(gen: AsyncGenerator<AnthropicEvent>, ms: number, abort: () => void, cls: ErrorClass): Promise<AnthropicEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort(); reject(new UpstreamError(cls, `no first event within ${Math.round(ms / 1000)}s`)); }, ms);
  });
  try {
    const r = await Promise.race([gen.next(), timeout]);
    if (r.done) throw new UpstreamError("incomplete", "the upstream stream ended with no events");
    return r.value;
  } finally {
    clearTimeout(timer);
  }
}

/** A request's chain: the configured one, else the omp model alone when omp resolves the id. */
export function chainFor(cfg: Config, id: string): Target[] | undefined {
  const c = cfg.chains[id];
  if (c) return c;
  if (!cfg.ompRuntime || !ompResolves(id, new Set(cfg.ompProviders), cfg.ompRuntime)) return undefined;
  const slash = id.indexOf("/");
  const m = cfg.ompRuntime.find(id.slice(0, slash), id.slice(slash + 1));
  return m ? [{ kind: "omp", ref: id, model: m, level: null }] : undefined;
}

export async function runChain(req: Canonical, deps: Deps, signal: AbortSignal, log: AttemptLog[], startedAt = Date.now(), sessionId?: string): Promise<ChainResult> {
  const { cfg, keys, cooldowns } = deps;
  const chain = chainFor(cfg, req.model);
  if (!chain) return { kind: "error", status: 404, errorType: "not_found_error", message: `subagent-models: ${req.model} is not a configured model (configured: ${Object.keys(cfg.chains).join(", ")}). Check ${cfg.path}` };
  const sleep = deps.sleep ?? sleepAbortable;
  const adapter = deps.adapter ?? adapterFor;
  const r = cfg.retry;
  const failures: string[] = [];

  // Skip models in cooldown; when every model is cooling, try them all anyway
  // rather than refuse outright.
  const live = chain.filter(t => t.kind === "claude" || !cooldowns.active(t.model.id));
  const order = live.length ? live : chain;
  for (const t of chain) if (!order.includes(t)) { log.push({ target: t.ref, outcome: "skipped (cooldown)", ms: 0 }); failures.push(`${t.ref}: skipped, in cooldown`); }

  for (const t of order) {
    if (t.kind === "claude") return { kind: "claude", model: t.claudeModel, level: t.level };
    const model = t.model;
    const provider = t.kind === "model" ? cfg.providers[t.model.provider]! : null;
    const timeouts = t.kind === "model" ? t.model.timeouts : cfg.timeouts;
    const level = effectiveLevel(t, req);
    const shaped = withIdentity(req, identityLine(model));
    let refreshedKey = false;
    let lastCls: ErrorClass = "server";
    let lastRetryAfter: number | undefined;
    for (let attempt = 0; attempt <= r.maxRetries; attempt++) {
      if (signal.aborted) return { kind: "aborted" };
      const t0 = Date.now();
      const total = timeouts.totalTimeoutSeconds * 1000;
      const left = total ? total - (t0 - startedAt) : Infinity;
      if (left <= 0) { failures.push(`${t.ref}: total timeout`); log.push({ target: t.ref, outcome: "total_timeout", ms: 0 }); return finalError(req, failures, "total_timeout"); }
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        let gen: AsyncGenerator<AnthropicEvent>;
        const capture = deps.capture ? (b: unknown) => deps.capture!(t.ref, b) : undefined;
        if (t.kind === "omp") {
          // omp's transport and auth (its own key resolution and OAuth refresh).
          gen = openOmp(cfg.ompRuntime!, t.model, req.model, shaped, level, ctrl.signal, sessionId, capture);
        } else {
          let key: string | null;
          try { key = await keys.get(provider!, { fresh: refreshedKey }); }
          catch (e) { throw new UpstreamError("auth", (e as Error).message); }
          gen = adapter(provider!.api)({ provider: provider!, model: t.model, requested: req.model, req: shaped, level, key, signal: ctrl.signal, capture });
        }
        const ms = Math.min(timeouts.streamFirstEventTimeoutSeconds * 1000, left);
        const first = await firstEvent(gen, ms, () => ctrl.abort(), ms < timeouts.streamFirstEventTimeoutSeconds * 1000 ? "total_timeout" : "first_event_timeout");
        log.push({ target: t.ref, outcome: "committed", ms: Date.now() - t0 });
        cooldowns.clear(model.id);
        return { kind: "stream", target: t, level, first, rest: gen, abort: () => { ctrl.abort(); signal.removeEventListener("abort", onAbort); } };
      } catch (e) {
        signal.removeEventListener("abort", onAbort);
        ctrl.abort();
        if (signal.aborted) { log.push({ target: t.ref, outcome: "aborted", ms: Date.now() - t0 }); return { kind: "aborted" }; }
        const err = e instanceof UpstreamError ? e : new UpstreamError("server", String((e as Error)?.message ?? e));
        log.push({ target: t.ref, outcome: err.cls, status: err.status, ms: Date.now() - t0 });
        failures.push(`${t.ref}: ${err.message}`);
        lastCls = err.cls;
        lastRetryAfter = err.retryAfterMs;
        if (err.cls === "context_length") {
          return { kind: "error", status: 400, errorType: "invalid_request_error", message: `prompt is too long: ${model.name} refused it (${err.message}). The model's window is ${model.contextWindow} tokens.` };
        }
        if (err.cls === "client" && !r.walkOnClientErrors) {
          return { kind: "error", status: 400, errorType: "invalid_request_error", message: `subagent-models: ${err.message}` };
        }
        if (err.cls === "auth" && !refreshedKey && provider) { refreshedKey = true; keys.forget(provider); attempt--; continue; }
        if (err.cls === "auth" || err.cls === "not_found" || err.cls === "client") break;
        if (err.cls === "rate_limit" && r.rateLimitWalksChain) break;
        if (attempt < r.maxRetries) {
          const backoff = Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** attempt) * (0.8 + Math.random() * 0.4);
          const wait = err.cls === "rate_limit" && err.retryAfterMs !== undefined ? Math.min(r.maxDelayMs, err.retryAfterMs) : backoff;
          try { await sleep(wait, signal); } catch { return { kind: "aborted" }; }
        }
      }
    }
    // Walk on: this model sits out a while (a rate limit's own retry-after if it gave one).
    const cool = lastCls === "rate_limit" && lastRetryAfter ? lastRetryAfter : r.cooldownSeconds * 1000;
    cooldowns.set(model.id, cool, lastCls);
  }
  return finalError(req, failures, "exhausted");
}

function finalError(req: Canonical, failures: string[], why: string): ChainResult {
  return {
    kind: "error",
    status: 503,
    errorType: "api_error",
    message: `subagent-models: no model in the chain for ${req.model} answered (${why}). ${failures.join(" | ")}`.slice(0, 3000),
  };
}
