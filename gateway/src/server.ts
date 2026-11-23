// The gateway daemon: Anthropic Messages API on a Unix socket (and, with
// gateway.listen, loopback TCP for a gated tunnel), served from the configured
// upstreams. Only the Claude Code mod talks to it.
import { appendFile, mkdir, chmod, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Config, ConfigError, loadConfig, modView, sourcesStamp } from "./config";
import { Cooldowns, type Deps } from "./chain";
import { type Entry, errorResponse, handleCountTokens, handleMessages } from "./handler";
import type { KeySource } from "./key-source";
import { KeyStore } from "./keys";
import { describe as describeSdk, readState } from "./omp-sdk";

export { EFFORT_HEADER, FALLBACK_HEADER, aggregate, errorResponse } from "./handler";

export class Gateway {
  cfg: Config;
  keys: KeySource;
  cooldowns = new Cooldowns();
  recent: Entry[] = [];
  private watcher?: ReturnType<typeof setInterval>;
  private reloadError: string | null = null;
  private overrides: Partial<Deps>;

  /** Passed to loadConfig on reload (tests inject a fake omp runtime). */
  loadOpts: Parameters<typeof loadConfig>[1] = {};

  constructor(cfg: Config, overrides: Partial<Deps> = {}) {
    this.cfg = cfg;
    this.keys = overrides.keys ?? new KeyStore(() => this.cfg);
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
    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") return handleCountTokens(req);
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const captureDir = this.cfg.gateway.captureDir;
      return handleMessages(req, {
        ...this.deps(),
        record: e => { void this.record(e); },
        captureRequest: captureDir
          ? (started, headers, body) => {
              const f = `${captureDir}/${started}-engine.json`;
              mkdir(dirname(f), { recursive: true }).then(() => writeFile(f, JSON.stringify({ headers: Object.fromEntries(headers), body }, null, 1))).catch(() => {});
            }
          : undefined,
      });
    }
    return errorResponse(404, "not_found_error", `subagent-models: no route ${req.method} ${url.pathname}`);
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
