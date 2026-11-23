// omp-native mode: the `omp:` block of our config.
//
// Models, auth and transport are omp's own (see omp-runtime.ts): any
// `<provider>/<model>` omp can resolve is routable, with no list to keep. From omp's
// files this module reads only what omp keeps as plain configuration and the SDK
// does not serve: fallback chains (config.yml) and, opt-in by name, agents
// (agents/<name>.md). Our own file is laid over the import key by key.
import { readFileSync, statSync } from "node:fs";
import { expandHome } from "./config";
import { CLAUDE_PROVIDER, parseRef } from "./config-core";
import type { OmpRuntime } from "./omp-runtime";
import { ompResolves } from "./config-core";
export { ompResolves };

export type { OmpBlock, OmpWarning, Origin, Source } from "./omp-types";
import type { OmpBlock, OmpWarning, Origin, Source } from "./omp-types";

export type OmpImport = {
  /** A fragment in our config shape: retry (chains), agents. */
  doc: Record<string, any>;
  warnings: OmpWarning[];
  sources: Source[];
};

export class OmpError extends Error {}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function stat(path: string): Source {
  try { return { path, mtimeMs: statSync(path).mtimeMs }; } catch { return { path, mtimeMs: -1 }; }
}

/** Splits `---\nfrontmatter\n---\nbody` (omp's agent files). */
export function parseAgentFile(text: string, path: string): { front: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new OmpError(`omp: ${path} has no --- frontmatter --- block`);
  let front: unknown;
  try { front = Bun.YAML.parse(m[1]!); } catch (e) { throw new OmpError(`omp: ${path} frontmatter is not valid YAML: ${(e as Error).message}`); }
  if (!isObj(front)) throw new OmpError(`omp: ${path} frontmatter is not a map`);
  return { front, body: m[2]!.trim() };
}

const REMOVED: Record<string, string> = {
  models: "every model omp can resolve is routable; restrict with omp.providers",
  timeouts: "timeouts are always this file's (omp's apply to all its providers at once)",
};

/** The omp block as written in our file, checked. Problems are config errors (our file). */
export function readOmpBlock(v: unknown, problems: string[], warnings: OmpWarning[] = []): OmpBlock | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) { problems.push("omp: must be a map"); return null; }
  for (const k of Object.keys(v)) {
    if (REMOVED[k]) warnings.push({ text: `omp.${k} is ignored: ${REMOVED[k]}` });
    else if (!["dir", "providers", "fallbackChains", "agents", "versionCheck"].includes(k)) problems.push(`omp.${k}: unknown key (known: dir, providers, fallbackChains, agents, versionCheck)`);
  }
  const list = (x: unknown, at: string): string[] => {
    if (x === undefined || x === null) return [];
    if (!Array.isArray(x) || !x.every(s => typeof s === "string")) { problems.push(`${at}: must be a list of names`); return []; }
    return x as string[];
  };
  const bool = (x: unknown, at: string, d: boolean) => (x === undefined ? d : typeof x === "boolean" ? x : (problems.push(`${at}: must be true or false`), d));
  const vc = v.versionCheck ?? "warn";
  if (vc !== "exact" && vc !== "warn") problems.push("omp.versionCheck: must be exact or warn");
  return {
    dir: expandHome(typeof v.dir === "string" && v.dir ? v.dir : "~/.omp/agent").replace(/\/+$/, ""),
    providers: v.providers === undefined || v.providers === null ? null : list(v.providers, "omp.providers"),
    fallbackChains: bool(v.fallbackChains, "omp.fallbackChains", true),
    agents: list(v.agents, "omp.agents"),
    versionCheck: vc === "exact" ? "exact" : "warn",
  };
}

/** The omp providers that route here: omp's, the block's restriction applied, `anthropic` never. */
export function routableProviders(block: OmpBlock, rt: OmpRuntime, warnings: OmpWarning[]): string[] {
  const all = rt.providers();
  if (block.providers) for (const p of block.providers) if (!all.includes(p)) warnings.push({ text: `omp.providers: omp has no provider ${p}` });
  return (block.providers ?? all).filter(p => p !== CLAUDE_PROVIDER && all.includes(p));
}

/** omp's fallback chains and opt-in agents, in our shape, keeping only what resolves. */
export function importOmp(block: OmpBlock, rt: OmpRuntime, providers: Set<string>, ourModels: Set<string>): OmpImport {
  const warnings: OmpWarning[] = [];
  const sources: Source[] = [];
  const doc: Record<string, any> = {};
  const routable = (ref: string) => {
    const { id } = parseRef(ref);
    if (id.startsWith(`${CLAUDE_PROVIDER}/`)) return /^anthropic\/claude-[a-z0-9.\-]+$/.test(id);
    return ourModels.has(id) || ompResolves(id, providers, rt);
  };

  if (block.fallbackChains) {
    const path = `${block.dir}/config.yml`;
    sources.push(stat(path));
    let cfg: unknown;
    try { cfg = Bun.YAML.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new OmpError(`omp: cannot read ${path}: ${(e as Error).message}`); }
    if (!isObj(cfg)) throw new OmpError(`omp: ${path} is not a YAML map`);
    if (isObj(cfg.retry)) {
      const r = cfg.retry;
      const retry: Record<string, any> = {};
      if (typeof r.maxRetries === "number" && r.maxRetries >= 0) retry.maxRetries = r.maxRetries;
      if (typeof r.rateLimitWalksChain === "boolean") retry.rateLimitWalksChain = r.rateLimitWalksChain;
      const chains: Record<string, string[]> = {};
      if (isObj(r.fallbackChains)) for (const [key, list] of Object.entries(r.fallbackChains)) {
        const { id } = parseRef(key);
        if (id.startsWith(`${CLAUDE_PROVIDER}/`) || !routable(id)) { warnings.push({ about: `chain ${id}`, text: `omp chain ${key}: ${id} does not resolve here; chain skipped` }); continue; }
        if (!Array.isArray(list)) continue;
        const kept: string[] = [];
        for (const e of list) {
          if (typeof e !== "string") continue;
          if (routable(e)) kept.push(e);
          else warnings.push({ about: `chain ${id}`, text: `omp chain ${key}: entry ${e} does not resolve here (no such omp model, or its provider is restricted); skipped` });
        }
        chains[id] = kept;
      }
      if (Object.keys(chains).length) retry.fallbackChains = chains;
      if (Object.keys(retry).length) doc.retry = retry;
    }
  }

  if (block.agents.length) {
    const agents: Record<string, any> = {};
    for (const name of block.agents) {
      const path = `${block.dir}/agents/${name}.md`;
      sources.push(stat(path));
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) { warnings.push({ text: `omp.agents: ${name} is not a valid agent name; skipped` }); continue; }
      let text: string;
      try { text = readFileSync(path, "utf8"); }
      catch { warnings.push({ about: `agent ${name}`, text: `omp.agents: ${path} not found; skipped` }); continue; }
      const { front, body } = parseAgentFile(text, path);
      if (typeof front.model !== "string" || parseRef(front.model).id.startsWith(`${CLAUDE_PROVIDER}/`) || !routable(front.model)) {
        warnings.push({ about: `agent ${name}`, text: `omp agent ${name}: model ${JSON.stringify(front.model)} does not resolve here; skipped` });
        continue;
      }
      const a: Record<string, any> = { model: front.model, description: typeof front.description === "string" ? front.description : `omp agent ${name}` };
      if (body) a.prompt = body;
      agents[name] = a;
    }
    if (Object.keys(agents).length) doc.agents = agents;
  }
  return { doc, warnings, sources };
}

/**
 * Our document laid over the imported one: a chain, an agent and a retry setting
 * defined here replace omp's. Returns the merged document and where each came from.
 */
export function mergeOver(imported: Record<string, any>, ours: Record<string, any>) {
  const origins: Record<string, Origin> = {};
  const tag = (key: string, inOmp: boolean, inOurs: boolean) => { origins[key] = inOurs && inOmp ? "ours over omp" : inOurs ? "ours" : "omp"; };
  const merged: Record<string, any> = { ...ours };
  delete merged.omp;

  const ir = imported.retry ?? {}, or = isObj(ours.retry) ? ours.retry : {};
  const retry: Record<string, any> = { ...ir, ...or };
  for (const k of ["maxRetries", "rateLimitWalksChain"]) if (k in retry) tag(`retry.${k}`, k in ir, k in or);
  const ic = ir.fallbackChains ?? {}, oc = isObj(or.fallbackChains) ? or.fallbackChains : {};
  const chains = { ...ic, ...oc };
  for (const k of Object.keys(chains)) tag(`chain ${k}`, k in ic, k in oc);
  if (Object.keys(chains).length) retry.fallbackChains = chains;
  if (Object.keys(retry).length) merged.retry = retry;

  const ia = imported.agents ?? {}, oa = isObj(ours.agents) ? ours.agents : {};
  const agents = { ...ia, ...oa };
  for (const k of Object.keys(agents)) tag(`agent ${k}`, k in ia, k in oa);
  if (Object.keys(agents).length) merged.agents = agents;

  return { merged, origins };
}
