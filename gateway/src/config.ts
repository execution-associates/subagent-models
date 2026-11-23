// Loads ~/.config/subagent-models/config.yml for the Bun gateway: the file, omp's
// runtime and the paths. The config's shape and validation are in config-core.ts.
import { homedir } from "node:os";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { type OmpWarning, OmpError, importOmp, mergeOver, readOmpBlock, routableProviders } from "./omp";
import { type OmpRuntime, OmpRuntimeError, loadOmpRuntime } from "./omp-runtime";
import { ompBinaryPath, stateDir } from "./omp-sdk";
import { type Config, type OmpExt, type P, type ValidateOptions, ConfigError, isObj, validate as validateCore } from "./config-core";
import type { OmpBlock, Source } from "./omp";

export * from "./config-core";

export function defaultConfigPath(): string {
  return process.env.SUBAGENT_MODELS_CONFIG || `${process.env.XDG_CONFIG_HOME || `${homedir()}/.config`}/subagent-models/config.yml`;
}

export function defaultSocketPath(): string {
  if (process.env.XDG_RUNTIME_DIR) return `${process.env.XDG_RUNTIME_DIR}/subagent-models/gateway.sock`;
  // macOS has no per-user runtime directory; the state directory is per user and short enough for a socket path.
  if (process.platform === "darwin") return `${homedir()}/.local/state/subagent-models/gateway.sock`;
  return `/run/user/${process.getuid?.() ?? 1000}/subagent-models/gateway.sock`;
}

export const expandHome = (p: string) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);
const expandVars = (p: string) =>
  p.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => process.env[a || b] ?? "");
const expandPath = (p: string) => expandHome(expandVars(p));

const nodeHost = { defaultSocket: defaultSocketPath, expand: expandPath };

/** validate() with this machine's paths: ~ and $VARS expanded, the socket default. */
export function validate(doc: unknown, file = "config.yml", mtimeMs = 0, omp?: OmpExt, opts: ValidateOptions = {}): Config {
  return validateCore(doc, file, mtimeMs, omp, { host: nodeHost, ...opts });
}

export type ResolveOptions = {
  /** Loads omp's runtime (tests pass a fake). Default: the SDK in gateway/omp-sdk. */
  loadRuntime?: (block: OmpBlock, warn: (m: string) => void) => Promise<OmpRuntime>;
};

/**
 * Our parsed document, resolved. With an `omp:` block, omp's runtime (its model
 * registry and auth) is loaded, omp's chains and opt-in agents are imported, our
 * document is laid over them, and ids are resolved through omp too. Without the
 * block this is validate() alone: no omp file or package is touched.
 */
export async function resolve(doc: unknown, file = "config.yml", mtimeMs = 0, opts: ResolveOptions = {}): Promise<Config> {
  if (!isObj(doc) || doc.omp === undefined || doc.omp === null) {
    const c = validate(doc, file, mtimeMs);
    for (const id of Object.keys(c.models)) c.origins[`model ${id}`] = "ours";
    return c;
  }
  const problems: P = [];
  const warn: OmpWarning[] = [];
  const block = readOmpBlock(doc.omp, problems, warn);
  if (problems.length || !block) throw new ConfigError(problems, file);
  const rtWarnings: string[] = [];
  let runtime: OmpRuntime;
  try { runtime = await (opts.loadRuntime ?? ((b, w) => loadOmpRuntime(b.dir, b.versionCheck, w)))(block, m => rtWarnings.push(m)); }
  catch (e) { if (e instanceof OmpRuntimeError) throw new ConfigError([e.message], file); throw e; }
  let d: Record<string, any> = doc;
  // A provider entry with neither baseUrl nor models only tweaked omp's (compat);
  // omp's transport serves that provider now, so the entry is set aside.
  if (isObj(d.providers)) {
    const kept: Record<string, unknown> = {};
    for (const [p, pv] of Object.entries(d.providers)) {
      if (isObj(pv) && pv.baseUrl === undefined && pv.models === undefined && runtime.providers().includes(p)) warn.push({ text: `providers.${p} is ignored: it defines no baseUrl or models, and omp serves ${p} with its own settings` });
      else kept[p] = pv;
    }
    d = { ...d, providers: kept };
  }
  // Our own providers shadow omp's of the same name entirely.
  const ours = new Set(isObj(d.providers) ? Object.keys(d.providers) : []);
  const providers = routableProviders(block, runtime, warn).filter(p => !ours.has(p));
  const ourModelIds = new Set<string>();
  if (isObj(d.providers)) for (const [p, pv] of Object.entries(d.providers)) if (isObj(pv) && isObj(pv.models)) for (const k of Object.keys(pv.models)) ourModelIds.add(`${p}/${k}`);
  let imported;
  try { imported = importOmp(block, runtime, new Set(providers), ourModelIds); }
  catch (e) { if (e instanceof OmpError) throw new ConfigError([e.message], file); throw e; }
  const { merged, origins } = mergeOver(imported.doc, d);
  const c = validate(merged, file, mtimeMs, { runtime, providers: new Set(providers) });
  for (const id of Object.keys(c.models)) origins[`model ${id}`] ??= "ours";
  for (const id of Object.keys(c.ompModels)) origins[`model ${id}`] = "omp";
  for (const p of ours) if (runtime.providers().includes(p)) origins[`provider ${p}`] = "ours over omp";
  // A warning about an omp chain or agent our own file replaces is noise: drop it.
  const warnings = [...rtWarnings, ...[...warn, ...imported.warnings].filter(w => !w.about || !origins[w.about] || origins[w.about] === "omp").map(w => w.text)];
  // Reload when the SDK in use is switched, when omp is updated, or when the test override changes.
  const sdkSources = [`${stateDir()}/current`, ompBinaryPath(), `${stateDir()}/installed-version.override`].map(path => ({ path, mtimeMs: 0 }));
  return { ...c, omp: block, origins, warnings, sources: [{ path: file, mtimeMs }, ...imported.sources, ...sdkSources], ompRuntime: runtime, ompProviders: providers };
}

/** A string that changes when any source file changes (or appears, or goes). */
export function sourcesStamp(sources: Source[]): string {
  return sources.map(s => {
    let m = -1, link = "";
    try { m = statSync(s.path).mtimeMs; } catch {}
    try { link = readlinkSync(s.path); } catch {}
    return `${s.path}@${m}${link ? `->${link}` : ""}`;
  }).join("|");
}

export function parseYaml(text: string, file: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch (e) {
    throw new ConfigError([`not valid YAML: ${(e as Error).message}`], file);
  }
}

export async function loadConfig(file = defaultConfigPath(), opts: ResolveOptions = {}): Promise<Config> {
  let text: string, mtimeMs: number;
  try {
    text = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch (e) {
    throw new ConfigError([`cannot read the file: ${(e as Error).message}. Copy config.example.yml there to start`], file);
  }
  return resolve(parseYaml(text, file), file, mtimeMs, opts);
}
