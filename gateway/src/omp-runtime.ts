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
import { currentSdkDir, installedOmp, readState, stateDir } from "./omp-sdk";
import { startSyncService } from "./service";

export type { OmpAssistantMessage, OmpEvent, OmpModelInfo, OmpRuntime, OmpStreamOptions } from "./omp-types";
import type { OmpModelInfo, OmpRuntime } from "./omp-types";

export class OmpRuntimeError extends Error {}

/** The SDK's version in a directory, or null when it is not installed there. */
export function installedSdkVersion(sdkDir: string): string | null {
  const p = `${sdkDir}/node_modules/@oh-my-pi/pi-coding-agent/package.json`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")).version ?? null; } catch { return null; }
}

let lastKick = 0;
/** Asks the service manager to run the SDK sync now (rate-limited; a no-op where the unit is absent). */
export function kickSync(reason: string, log: (m: string) => void = m => console.log(m)) {
  if (process.env.SUBAGENT_MODELS_NO_SYNC_KICK) return;
  if (Date.now() - lastKick < 60_000) return;
  lastKick = Date.now();
  try {
    startSyncService();
    log(`omp-sdk: started the omp SDK sync (${reason})`);
  } catch {}
}

const cache = new Map<string, Promise<OmpRuntime>>();

/**
 * Loads the SDK copy `current` points at (once per process and version directory),
 * for an omp agent directory. A version different from the installed omp is served
 * anyway with a warning (an older SDK reads a newer auth store) and a sync is
 * started; `versionCheck: exact` refuses it instead.
 */
export function loadOmpRuntime(agentDir: string, versionCheck: "exact" | "warn", warn: (m: string) => void, sdkDirOverride?: string): Promise<OmpRuntime> {
  const sdkDir = sdkDirOverride ?? currentSdkDir();
  if (!sdkDir) {
    kickSync("no omp SDK installed");
    return Promise.reject(new OmpRuntimeError(`omp: no omp SDK is installed yet in ${stateDir()}; the sync has been started (watch: subagent-models omp-sdk status; subagent-models logs sync)`));
  }
  const sdk = installedSdkVersion(sdkDir);
  const omp = installedOmp(agentDir).version;
  if (sdk && omp && omp !== sdk) {
    kickSync(`omp is ${omp}, SDK is ${sdk}`);
    // A failed sync must not read as progress. Its error stays out of the message: it
    // names a per-attempt staging path, and the mod shows each distinct warning once.
    const st = readState();
    const failed = st.phase === "failed" && st.target === omp && st.lastError;
    const msg = failed
      ? `omp: the installed omp is ${omp} but the omp SDK in use is ${sdk}; serving with ${sdk} because the ${omp} SDK failed to install or load; the sync retries, and takes the next omp release (why: subagent-models omp-sdk status)`
      : `omp: the installed omp is ${omp} but the omp SDK in use is ${sdk}; serving with ${sdk} while the matching SDK is synced`;
    if (versionCheck === "exact") return Promise.reject(new OmpRuntimeError(`${msg.split(";")[0]}; omp.versionCheck is exact, so omp-routed models are refused until the sync finishes`));
    warn(msg);
  }
  let p = cache.get(sdkDir);
  if (!p) {
    p = load(agentDir, sdkDir);
    cache.set(sdkDir, p);
    p.catch(() => cache.delete(sdkDir));
  }
  return p;
}

async function load(agentDir: string, sdkDir: string): Promise<OmpRuntime> {
  const sdk = installedSdkVersion(sdkDir);
  if (!sdk) throw new OmpRuntimeError(`omp: ${sdkDir} holds no omp SDK; run: subagent-models omp-sdk sync`);
  // Each SDK copy extracts its native addon into a cache of its own: never omp's
  // ~/.omp/natives, which omp prunes on update (and which an SDK would prune).
  process.env.PI_NATIVES_DIR = `${sdkDir}/natives`;
  // The SDK reads PI_CODING_AGENT_DIR to find omp's directory, as omp does.
  if (agentDir) process.env.PI_CODING_AGENT_DIR ??= agentDir;
  let agent: any, ai: any;
  try {
    agent = await import(`${sdkDir}/node_modules/@oh-my-pi/pi-coding-agent/src/index.ts`);
    ai = await import(`${sdkDir}/node_modules/@oh-my-pi/pi-ai/src/index.ts`);
  } catch (e) {
    throw new OmpRuntimeError(`omp: the SDK in ${sdkDir} did not load (${(e as Error).message}); roll back with: subagent-models omp-sdk rollback`);
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
    dir: sdkDir,
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
