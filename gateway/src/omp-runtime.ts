// omp's own machinery, loaded only when the config has an `omp:` block.
//
// The gateway does not re-implement omp: it uses omp's published SDK
// (@oh-my-pi/pi-coding-agent and @oh-my-pi/pi-ai, installed in gateway/omp-sdk,
// pinned to the installed omp's version) for three things:
//   - the catalogue: omp's ModelRegistry (built-in providers, models.yml, discovered models)
//   - auth: omp's AuthStorage over its own agent.db (API keys, !command keys, OAuth
//     logins with refresh; refresh is lease-guarded across processes, so running omp
//     sessions and the gateway can share it)
//   - transport: pi-ai's streamSimple, i.e. every API family omp speaks.
// Nothing else of omp is used, and nothing outside the SDK touches omp's files.
//
// Everything the rest of the gateway needs goes through the OmpRuntime interface, so
// tests use a fake and a gateway without the block never loads the SDK.
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** What the gateway knows about one omp model. */
export type OmpModelInfo = {
  /** `<provider>/<model id>`, the id Claude Code sends. */
  id: string;
  provider: string;
  modelId: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  /** A subscription login (ChatGPT, Claude, ...) rather than an API key. */
  subscription: boolean;
  hasAuth: boolean;
};

/** pi-ai's streaming events, as far as the gateway reads them. */
export type OmpEvent =
  | { type: "start" }
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_end"; contentIndex: number; content: string; partial?: { content?: any[] } }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: OmpAssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: OmpAssistantMessage }
  | { type: string; [k: string]: unknown };

export type OmpAssistantMessage = {
  content: any[];
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
  errorMessage?: string;
  errorStatus?: number;
};

export type OmpStreamOptions = {
  signal: AbortSignal;
  reasoning?: string;
  disableReasoning?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  sessionId?: string;
};

export interface OmpRuntime {
  readonly version: string;
  /** Every provider omp has a model for. */
  providers(): string[];
  find(provider: string, modelId: string): OmpModelInfo | undefined;
  /** Streams one model call. `context` is pi-ai's Context (see omp-transport.ts). */
  stream(model: OmpModelInfo, context: unknown, options: OmpStreamOptions): AsyncIterable<OmpEvent>;
}

export class OmpRuntimeError extends Error {}

export const SDK_DIR = `${dirname(import.meta.dir)}/omp-sdk`;

/** The SDK's version as installed in gateway/omp-sdk, or null when it is not installed. */
export function installedSdkVersion(sdkDir = SDK_DIR): string | null {
  const p = `${sdkDir}/node_modules/@oh-my-pi/pi-coding-agent/package.json`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")).version ?? null; } catch { return null; }
}

/** The version of the omp that last ran from this agent directory (omp writes it on start). */
export function installedOmpVersion(agentDir: string): string | null {
  try { return readFileSync(`${agentDir}/last-changelog-version`, "utf8").trim() || null; } catch { return null; }
}

const cache = new Map<string, Promise<OmpRuntime>>();

/**
 * Loads the SDK for an omp agent directory (once per process and directory).
 * `versionCheck: exact` refuses an SDK whose version differs from the installed omp,
 * because omp's auth store migrates its schema forward and an SDK that is older than
 * the store only warns and carries on.
 */
export function loadOmpRuntime(agentDir: string, versionCheck: "exact" | "warn", warn: (m: string) => void, sdkDir = SDK_DIR): Promise<OmpRuntime> {
  const key = `${agentDir}|${sdkDir}`;
  let p = cache.get(key);
  if (!p) {
    p = load(agentDir, versionCheck, warn, sdkDir);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

async function load(agentDir: string, versionCheck: "exact" | "warn", warn: (m: string) => void, sdkDir: string): Promise<OmpRuntime> {
  const sdk = installedSdkVersion(sdkDir);
  if (!sdk) {
    throw new OmpRuntimeError(`omp: the config has an omp: block, but omp's SDK is not installed in ${sdkDir}. Install it with ${dirname(dirname(sdkDir))}/scripts/install-omp-sdk.sh (or remove the omp: block)`);
  }
  const omp = installedOmpVersion(agentDir);
  if (!omp) warn(`omp: cannot tell which omp version uses ${agentDir} (no last-changelog-version); using SDK ${sdk} unchecked`);
  else if (omp !== sdk) {
    const msg = `omp: the installed omp is ${omp} but the gateway's omp SDK is ${sdk}. Re-pin it with scripts/install-omp-sdk.sh ${omp}`;
    if (versionCheck === "exact") throw new OmpRuntimeError(`${msg} (or set omp.versionCheck: warn to run anyway)`);
    warn(msg);
  }
  // The SDK reads PI_CODING_AGENT_DIR to find omp's directory, as omp does.
  if (agentDir) process.env.PI_CODING_AGENT_DIR ??= agentDir;
  let agent: any, ai: any;
  try {
    agent = await import(`${sdkDir}/node_modules/@oh-my-pi/pi-coding-agent/src/index.ts`);
    ai = await import(`${sdkDir}/node_modules/@oh-my-pi/pi-ai/src/index.ts`);
  } catch (e) {
    throw new OmpRuntimeError(`omp: the SDK in ${sdkDir} did not load (${(e as Error).message}); reinstall it with scripts/install-omp-sdk.sh`);
  }
  for (const [name, v] of [["discoverAuthStorage", agent.discoverAuthStorage], ["ModelRegistry", agent.ModelRegistry], ["streamSimple", ai.streamSimple]] as const) {
    if (typeof v !== "function") throw new OmpRuntimeError(`omp: SDK ${sdk} has no ${name}; this gateway was written against 18.20.x`);
  }
  const auth = await agent.discoverAuthStorage(agentDir);
  const registry = new agent.ModelRegistry(auth);
  // Offline: catalogues from omp's cache and config only. Discovery is omp's own job.
  await registry.refresh("offline");
  const models = new Map<string, any>();
  const info = (m: any): OmpModelInfo => ({
    id: `${m.provider}/${m.id}`,
    provider: m.provider,
    modelId: m.id,
    name: m.name ?? m.id,
    api: m.api,
    contextWindow: m.contextWindow ?? 200000,
    maxTokens: m.maxTokens ?? 32000,
    reasoning: m.reasoning !== false,
    input: Array.isArray(m.input) ? m.input.filter((x: string) => x === "text" || x === "image") : ["text"],
    subscription: safe(() => registry.isUsingSubscription(m), false),
    hasAuth: safe(() => registry.hasConcreteAuth(m.provider), false),
  });
  return {
    version: sdk,
    providers: () => [...new Set<string>(registry.getAll("all").map((m: any) => m.provider))].sort(),
    find(provider, modelId) {
      const m = registry.find(provider, modelId);
      if (!m) return undefined;
      const i = info(m);
      models.set(i.id, m);
      return i;
    },
    stream(model, context, o) {
      const m = models.get(model.id) ?? registry.find(model.provider, model.modelId);
      if (!m) throw new OmpRuntimeError(`omp has no model ${model.id}`);
      return ai.streamSimple(m, context, {
        apiKey: registry.resolver(m, o.sessionId),
        signal: o.signal,
        reasoning: o.reasoning,
        disableReasoning: o.disableReasoning,
        maxTokens: o.maxTokens,
        temperature: o.temperature,
        topP: o.topP,
        stopSequences: o.stopSequences,
        // One attempt: the gateway's own retries, timeouts and fallback chains apply.
        maxHttpAttempts: 1,
      });
    },
  };
}

function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
