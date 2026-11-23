// Resolves provider API keys from their sources and keeps them in memory only.
// Sources: `op://vault/item/field` (op read), `!shell command` (its trimmed stdout),
// or the name of an environment variable. A key is never logged: errors name the
// source kind and the exit status, never the output.
import { readFileSync } from "node:fs";
import type { Config, ProviderDef } from "./config";
import type { KeySource } from "./key-source";
export { scrub } from "./key-source";

type Entry = { key: string; at: number };

export class KeyStore implements KeySource {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Promise<string>>();
  constructor(private cfg: () => Config) {}

  /** The key for a provider, or null when the provider declares none. */
  async get(p: ProviderDef, { fresh = false } = {}): Promise<string | null> {
    if (!p.apiKey) return null;
    const src = p.apiKey;
    const ttl = this.cfg().secrets.keyCacheSeconds * 1000;
    const hit = this.cache.get(src);
    if (!fresh && hit && (ttl === 0 || Date.now() - hit.at < ttl)) return hit.key;
    let run = this.pending.get(src);
    if (!run) {
      run = this.resolve(src, p.name, fresh).finally(() => this.pending.delete(src));
      this.pending.set(src, run);
    }
    const key = await run;
    this.cache.set(src, { key, at: Date.now() });
    return key;
  }

  forget(p: ProviderDef) { if (p.apiKey) this.cache.delete(p.apiKey); }

  /** Every string worth scrubbing from text that might be logged. */
  known(): string[] { return [...this.cache.values()].map(e => e.key).filter(k => k.length >= 8); }

  private async resolve(src: string, provider: string, fresh: boolean): Promise<string> {
    if (src.startsWith("!")) return this.shell(src.slice(1), provider, `the !command for ${provider}`);
    if (src.startsWith("op://")) {
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      const tf = this.cfg().secrets.opServiceAccountTokenFile;
      if (tf) {
        try { env.OP_SERVICE_ACCOUNT_TOKEN = readFileSync(tf, "utf8").trim(); }
        catch (e) { throw new Error(`providers.${provider}.apiKey: cannot read secrets.opServiceAccountTokenFile (${(e as Error).message})`); }
      }
      if (fresh) env.OP_NO_CACHE = "1";
      return this.run(["op", "read", src], env, provider, `op read of providers.${provider}.apiKey`);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(src)) {
      const v = process.env[src];
      if (!v) throw new Error(`providers.${provider}.apiKey names the environment variable ${src}, which is not set in the gateway's environment`);
      return v.trim();
    }
    throw new Error(`providers.${provider}.apiKey: not an op:// reference, a !command or an environment variable name`);
  }

  private shell(cmd: string, provider: string, what: string) {
    return this.run(["sh", "-c", cmd], process.env as Record<string, string>, provider, what);
  }

  private async run(argv: string[], env: Record<string, string>, provider: string, what: string): Promise<string> {
    const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), 60_000);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    const key = out.trim();
    if (code !== 0 || !key) {
      // stderr can be shown: op and shells print errors there, not secrets. Cut it short anyway.
      const hint = err.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      throw new Error(`${what} failed (exit ${code}${key ? "" : ", no output"})${hint ? `: ${hint}` : ""}`);
    }
    return key;
  }
}
