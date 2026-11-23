// Where the request path gets provider API keys. The Bun gateway resolves them from
// op://, !commands and the environment (keys.ts); the hosted service holds them
// decrypted in memory for one user (StaticKeys). Keys are never logged: anything
// that might be is scrubbed of every key this source knows.
import type { ProviderDef } from "./config-core";

export interface KeySource {
  /** The key for a provider, or null when the provider declares none. */
  get(p: ProviderDef, opts?: { fresh?: boolean }): Promise<string | null>;
  /** Drops a cached key (the upstream refused it); the next get() fetches it again. */
  forget(p: ProviderDef): void;
  /** Every string worth scrubbing from text that might be logged. */
  known(): string[];
}

/** Keys given as values, by provider name: the hosted service's, decrypted for one request. */
export class StaticKeys implements KeySource {
  constructor(private keys: Record<string, string>) {}
  async get(p: ProviderDef) { return this.keys[p.name] ?? null; }
  forget() {}
  known() { return Object.values(this.keys).filter(k => k.length >= 8); }
}

/** Replaces every known secret in `s` with [redacted]. */
export function scrub(s: string, secrets: string[]): string {
  for (const k of secrets) if (k) s = s.split(k).join("[redacted]");
  return s;
}
