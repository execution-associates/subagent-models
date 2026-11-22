// The gateway daemon: Anthropic Messages API on a Unix socket (and, with
// gateway.listen, loopback TCP for a gated tunnel), served from the configured
// upstreams. Only the Claude Code mod talks to it.
import { appendFile, mkdir, chmod, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BadRequest, estimateTokens, normalize } from "./canonical";
import { type Config, ConfigError, loadConfig, modView, sourcesStamp } from "./config";
import { type AttemptLog, type ChainResult, type Committed, Cooldowns, type Deps, chainFor, runChain } from "./chain";
import { KeyStore, scrub } from "./keys";
import { type AnthropicEvent, UpstreamError } from "./upstream";
import { describe as describeSdk, readState } from "./omp-sdk";

export const FALLBACK_HEADER = "x-subagent-models-claude-fallback";
export const EFFORT_HEADER = "x-subagent-models-effort";

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type Entry = {
  ts: string; id: string; agentId?: string; compaction?: string; requested: string; stream: boolean; servedBy?: string; level?: string;
  status: number; outcome: string; attempts: AttemptLog[]; ttfbMs?: number; durationMs: number;
  usage?: Usage; stopReason?: string; error?: string; dropped?: string[];
};

export class Gateway {
  cfg: Config;
  keys: KeyStore;
  cooldowns = new Cooldowns();
  recent: Entry[] = [];
  private watcher?: ReturnType<typeof setInterval>;
  private reloadError: string | null = null;
  private overrides: Partial<Deps>;

  /** Passed to loadConfig on reload (tests inject a fake omp runtime). */
  loadOpts: Parameters<typeof loadConfig>[1] = {};

  constructor(cfg: Config, overrides: Partial<Deps> = {}) {
    this.cfg = cfg;
    this.keys = new KeyStore(() => this.cfg);
    this.overrides = overrides;
  }

  /** Re-reads the config when any of its files changes (ours, and omp's when imported); a broken edit keeps the last good config. */
  watch(intervalMs = 2000) {
    let stamp = sourcesStamp(this.cfg.sources);
    let busy = false;
    this.watcher = setInterval(async () => {
      if (busy) return;
      const now = sourcesStamp(this.cfg.sources);
      if (now === stamp) return;
      stamp = now;
      busy = true;
      try {
        const next = await loadConfig(this.cfg.path, this.loadOpts);
        if (next.gateway.socket !== this.cfg.gateway.socket) console.log(`config: gateway.socket changed; restart the gateway to move it`);
        if (JSON.stringify(next.gateway.listen) !== JSON.stringify(this.cfg.gateway.listen)) console.log(`config: gateway.listen changed; restart the gateway to move it`);
        this.cfg = next;
        stamp = sourcesStamp(next.sources);
        this.reloadError = null;
        console.log(`config: reloaded ${this.cfg.path} (${Object.keys(next.models).length} models of ours, ${next.agents.length} agents${next.omp ? `, omp-native: ${next.ompProviders.length} omp providers via SDK ${next.ompRuntime?.version}` : ""})`);
        for (const w of next.warnings) console.log(`config: warning: ${w}`);
        if (next.omp) for (const l of describeSdk(readState())) console.log(l);
      } catch (e) {
        this.reloadError = (e as Error).message;
        console.error(`config: reload failed, keeping the previous config:\n${this.reloadError}`);
      } finally { busy = false; }
    }, intervalMs);
  }
  stop() { if (this.watcher) clearInterval(this.watcher); }

  private deps(): Deps {
    const capture = this.cfg.gateway.captureDir
      ? (target: string, body: unknown) => {
          const f = `${this.cfg.gateway.captureDir}/${Date.now()}-${target.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
          mkdir(dirname(f), { recursive: true }).then(() => writeFile(f, JSON.stringify(body, null, 1))).catch(() => {});
        }
      : undefined;
    return { cfg: this.cfg, keys: this.keys, cooldowns: this.cooldowns, capture, ...this.overrides };
  }

  private async record(e: Entry) {
    e.error &&= scrub(e.error, this.keys.known());
    this.recent.push(e);
    if (this.recent.length > 200) this.recent.shift();
    const served = e.servedBy ? ` -> ${e.servedBy}${e.level ? `:${e.level}` : ""}` : "";
    const u = e.usage ? ` in=${e.usage.input_tokens ?? 0} cache=${e.usage.cache_read_input_tokens ?? 0} out=${e.usage.output_tokens ?? 0}` : "";
    console.log(`${e.id} ${e.agentId ?? "-"}${e.compaction ? ` compaction=${e.compaction}` : ""} ${e.requested}${served} ${e.status} ${e.outcome} ${e.durationMs}ms${e.ttfbMs !== undefined ? ` ttfb=${e.ttfbMs}ms` : ""}${u}${e.stopReason ? ` stop=${e.stopReason}` : ""}${e.error ? ` error=${e.error.slice(0, 300)}` : ""}`);
    try {
      await mkdir(dirname(this.cfg.gateway.accessLog), { recursive: true });
      await appendFile(this.cfg.gateway.accessLog, JSON.stringify(e) + "\n");
    } catch (err) { console.error(`access log: ${(err as Error).message}`); }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, config: this.cfg.path, reloadError: this.reloadError });
    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({
        config: this.cfg.path, reloadError: this.reloadError,
        omp: this.cfg.omp?.dir ?? null, ompSdk: this.cfg.omp ? { inUse: this.cfg.ompRuntime?.version ?? null, ...readState() } : null,
        warnings: this.cfg.warnings, origins: this.cfg.origins,
        models: Object.keys(this.cfg.models),
        ompProviders: this.cfg.ompProviders,
        chains: Object.fromEntries(Object.entries(this.cfg.chains).map(([k, v]) => [k, v.map(t => t.ref)])),
        cooldowns: this.cooldowns.list(),
        recent: this.recent.slice(-20),
      });
    }
    // The routing table a remote mod (SUBAGENT_MODELS_URL) loads instead of running mod-config locally.
    if (req.method === "GET" && url.pathname === "/mod-config") return Response.json({ ok: true, config: modView(this.cfg), reloadError: this.reloadError });
    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      try { return Response.json({ input_tokens: estimateTokens((await req.json()) as Record<string, any>) }); }
      catch { return errorResponse(400, "invalid_request_error", "subagent-models: count_tokens body is not JSON"); }
    }
    if (req.method === "POST" && url.pathname === "/v1/messages") return this.messages(req);
    return errorResponse(404, "not_found_error", `subagent-models: no route ${req.method} ${url.pathname}`);
  }

  private async messages(req: Request): Promise<Response> {
    const started = Date.now();
    const entry: Entry = { ts: new Date(started).toISOString(), id: `r${started.toString(36)}${Math.random().toString(36).slice(2, 6)}`, agentId: req.headers.get("x-claude-code-agent-id") ?? undefined, compaction: req.headers.get("x-claude-code-compaction") ?? undefined, requested: "?", stream: false, status: 0, outcome: "", attempts: [], durationMs: 0 };
    let canon;
    try {
      const raw = await req.json();
      if (this.cfg.gateway.captureDir) {
        const f = `${this.cfg.gateway.captureDir}/${started}-engine.json`;
        mkdir(dirname(f), { recursive: true }).then(() => writeFile(f, JSON.stringify({ headers: Object.fromEntries(req.headers), body: raw }, null, 1))).catch(() => {});
      }
      if (raw && typeof raw === "object" && "thread" in raw && (raw as { thread?: unknown }).thread) {
        // Claude Code's message-threads beta keeps the conversation on Anthropic's
        // side and sends only new messages. The gateway keeps no threads: this
        // refusal (the error code Claude Code recognises) makes it resend the turn
        // whole and stay stateless on this model for the rest of the session.
        Object.assign(entry, { requested: String((raw as { model?: unknown }).model ?? "?"), status: 400, outcome: "thread_refused", durationMs: Date.now() - started });
        void this.record(entry);
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thread_unsupported_request: subagent-models keeps no server-side message threads; send the whole conversation", details: { error_code: "thread_unsupported_request" } } }), {
          status: 400,
          headers: { "content-type": "application/json", "x-should-retry": "false" },
        });
      }
      canon = normalize(raw);
    } catch (e) {
      const msg = e instanceof BadRequest ? e.message : "the body is not JSON";
      Object.assign(entry, { status: 400, outcome: "bad_request", error: msg, durationMs: Date.now() - started });
      void this.record(entry);
      return errorResponse(400, "invalid_request_error", `subagent-models: ${msg}`);
    }
    entry.requested = canon.model;
    entry.stream = canon.stream;
    entry.dropped = canon.dropped.length ? canon.dropped : undefined;
    const signal = req.signal;
    const deps = this.deps();
    const finish = (status: number, outcome: string, extra: Partial<Entry> = {}) => {
      Object.assign(entry, { status, outcome, durationMs: Date.now() - started }, extra);
      void this.record(entry);
    };

    if (!canon.stream) return this.nonStreaming(canon, deps, signal, entry, finish);

    const result = await runChain(canon, deps, signal, entry.attempts, started, entry.agentId);
    if (result.kind !== "stream") return this.notStreamed(result, finish);
    entry.servedBy = result.target.model.id;
    entry.level = result.level;
    entry.ttfbMs = Date.now() - started;
    return this.streamResponse(result, deps, finish);
  }

  private notStreamed(result: Exclude<ChainResult, Committed>, finish: (s: number, o: string, x?: Partial<Entry>) => void): Response {
    if (result.kind === "aborted") { finish(499, "aborted"); return new Response(null, { status: 499 }); }
    if (result.kind === "claude") {
      finish(409, "claude_fallback", { servedBy: `anthropic/${result.model}`, level: result.level ?? undefined });
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `subagent-models: the chain reached the Claude fallback ${result.model}, which only the Claude Code mod can serve; this response means the mod did not pick it up` } }), {
        status: 409,
        headers: { "content-type": "application/json", "x-should-retry": "false", [FALLBACK_HEADER]: result.model, ...(result.level ? { [EFFORT_HEADER]: result.level } : {}) },
      });
    }
    finish(result.status, "error", { error: result.message });
    return errorResponse(result.status, result.errorType, scrub(result.message, this.keys.known()));
  }

  private streamResponse(c: Committed, deps: Deps, finish: (s: number, o: string, x?: Partial<Entry>) => void): Response {
    const enc = new TextEncoder();
    const cfg = this.cfg;
    const model = c.target.model;
    const idleMs = ("timeouts" in model ? model.timeouts : cfg.timeouts).streamIdleTimeoutSeconds * 1000;
    const pingMs = cfg.gateway.pingIntervalSeconds * 1000;
    const keys = this.keys;
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
  private async nonStreaming(canon: ReturnType<typeof normalize>, deps: Deps, signal: AbortSignal, entry: Entry, finish: (s: number, o: string, x?: Partial<Entry>) => void): Promise<Response> {
    const chainLen = chainFor(deps.cfg, canon.model)?.length ?? 1;
    for (let round = 0; round < chainLen; round++) {
      const result = await runChain(canon, deps, signal, entry.attempts, Date.parse(entry.ts), entry.agentId);
      if (result.kind !== "stream") return this.notStreamed(result, finish);
      try {
        const tm = "timeouts" in result.target.model ? result.target.model.timeouts : deps.cfg.timeouts;
        const msg = await aggregate(result, tm.streamIdleTimeoutSeconds * 1000);
        finish(200, "ok", { servedBy: result.target.model.id, level: result.level, usage: msg.usage, stopReason: msg.stop_reason });
        return Response.json(msg, { headers: { "x-subagent-models-served-by": result.target.model.id } });
      } catch (e) {
        result.abort();
        const err = e instanceof UpstreamError ? e : new UpstreamError("server", String(e));
        entry.attempts.push({ target: result.target.ref, outcome: `mid_stream_${err.cls}`, ms: 0 });
        if (err.cls === "aborted") return this.notStreamed({ kind: "aborted" }, finish);
        deps.cooldowns.set(result.target.model.id, deps.cfg.retry.cooldownSeconds * 1000, `mid-stream ${err.cls}`);
      }
    }
    return this.notStreamed({ kind: "error", status: 503, errorType: "api_error", message: `subagent-models: every model in the chain for ${canon.model} failed mid-response` }, finish);
  }

  async listen(): Promise<ReturnType<typeof Bun.serve>[]> {
    const sock = this.cfg.gateway.socket;
    await mkdir(dirname(sock), { recursive: true, mode: 0o700 });
    await chmod(dirname(sock), 0o700).catch(() => {});
    await unlink(sock).catch(() => {});
    // idleTimeout 0: a response may wait on the upstream (first event, retries) longer than Bun's 10s default.
    const server = Bun.serve({ unix: sock, fetch: (r: Request) => this.fetch(r), idleTimeout: 0 } as unknown as Parameters<typeof Bun.serve>[0]);
    await chmod(sock, 0o600).catch(() => {});
    const servers = [server];
    const tcp = this.cfg.gateway.listen;
    if (tcp) servers.push(Bun.serve({ hostname: tcp.host, port: tcp.port, fetch: (r: Request) => this.fetch(r), idleTimeout: 0 } as unknown as Parameters<typeof Bun.serve>[0]));
    return servers;
  }
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

export async function main(configPath?: string) {
  let cfg: Config;
  try { cfg = await loadConfig(configPath); }
  catch (e) { console.error(e instanceof ConfigError ? e.message : String(e)); process.exit(78); }
  const gw = new Gateway(cfg);
  gw.watch();
  const servers = await gw.listen();
  for (const w of cfg.warnings) console.log(`config: warning: ${w}`);
  if (cfg.omp) for (const l of describeSdk(readState())) console.log(l);
  console.log(`subagent-models gateway listening on ${cfg.gateway.socket}${cfg.gateway.listen ? ` and ${cfg.gateway.listen.host}:${cfg.gateway.listen.port}` : ""} (config ${cfg.path}; models of ours: ${Object.keys(cfg.models).join(", ") || "none"}${cfg.omp ? `; omp-native: ${cfg.ompProviders.length} omp providers via SDK ${cfg.ompRuntime?.version}` : ""})`);
  const stop = () => { console.log("stopping"); gw.stop(); for (const s of servers) s.stop(true); unlink(cfg.gateway.socket).catch(() => {}).finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
