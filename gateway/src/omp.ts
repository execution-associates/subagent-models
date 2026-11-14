// omp compatibility: import providers, models, fallback chains, timeouts and agents
// from an omp agent directory (~/.omp/agent), read-only.
//
// Only three files are read: models.yml, config.yml and agents/<name>.md. omp itself
// is never run, nothing under its directory is written, and its databases are never
// opened. What is imported is turned into this tool's own config shape; our own file
// is then laid over it key by key (see mergeOver), so anything we define wins.
//
// omp updates itself and its files may grow keys: unknown keys are ignored. Entries
// that cannot be routed here (an omp built-in provider, a provider not in the
// allow-list, an API this gateway does not speak) are skipped with a warning.
import { readFileSync, statSync } from "node:fs";
import { CLAUDE_PROVIDER, expandHome, parseRef } from "./config";

export type OmpBlock = {
  dir: string;
  providers: string[];
  /** Optional: only these <provider>/<model> ids are imported (default: every model of the listed providers). */
  models: string[] | null;
  fallbackChains: boolean;
  timeouts: boolean;
  agents: string[];
};

export type Origin = "ours" | "omp" | "ours over omp";
export type Source = { path: string; mtimeMs: number };

/** A skipped entry; `about` names the chain or agent it concerns, so a warning about something our own file overrides can be dropped. */
export type OmpWarning = { about?: string; text: string };

export type OmpImport = {
  /** A fragment in our config shape: providers, retry, timeouts, agents. */
  doc: Record<string, any>;
  warnings: OmpWarning[];
  /** Files read (and the ones looked for), for hot reload. */
  sources: Source[];
};

export class OmpError extends Error {}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID_OK = /^[A-Za-z0-9._\-\/]+$/;
const OPENAI_COMPAT_KEYS = ["reasoningEffortMap", "maxTokensField", "reasoningContentField", "supportsReasoningEffort", "supportsMultipleSystemMessages", "supportsUsageInStreaming", "supportsToolChoice", "extraBody"];
const LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function stat(path: string): Source {
  try { return { path, mtimeMs: statSync(path).mtimeMs }; } catch { return { path, mtimeMs: -1 }; }
}

function readYaml(path: string, what: string): unknown {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { throw new OmpError(`omp: cannot read ${what} ${path}: ${(e as Error).message}`); }
  try { return Bun.YAML.parse(text); }
  catch (e) { throw new OmpError(`omp: ${path} is not valid YAML: ${(e as Error).message}`); }
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

/** The omp block as written in our file, checked. Problems are config errors (our file). */
export function readOmpBlock(v: unknown, problems: string[]): OmpBlock | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) { problems.push("omp: must be a map"); return null; }
  for (const k of Object.keys(v)) if (!["dir", "providers", "models", "fallbackChains", "timeouts", "agents"].includes(k)) problems.push(`omp.${k}: unknown key (known: dir, providers, models, fallbackChains, timeouts, agents)`);
  const list = (x: unknown, at: string): string[] => {
    if (x === undefined || x === null) return [];
    if (!Array.isArray(x) || !x.every(s => typeof s === "string")) { problems.push(`${at}: must be a list of names`); return []; }
    return x as string[];
  };
  const bool = (x: unknown, at: string, d: boolean) => (x === undefined ? d : typeof x === "boolean" ? x : (problems.push(`${at}: must be true or false`), d));
  if (typeof v.dir !== "string" || !v.dir) problems.push("omp.dir: required, omp's agent directory (e.g. ~/.omp/agent)");
  const providers = list(v.providers, "omp.providers");
  if (v.providers === undefined) problems.push("omp.providers: required, the omp providers to import, by name (nothing is imported by default)");
  return {
    dir: expandHome(String(v.dir ?? "")).replace(/\/+$/, ""),
    providers,
    models: v.models === undefined || v.models === null ? null : list(v.models, "omp.models"),
    fallbackChains: bool(v.fallbackChains, "omp.fallbackChains", true),
    timeouts: bool(v.timeouts, "omp.timeouts", false),
    agents: list(v.agents, "omp.agents"),
  };
}

/**
 * Reads the omp files the block asks for and returns them in our config shape.
 * Throws OmpError when a file that is needed is missing or unparsable (the caller
 * then keeps its last good config).
 */
export function importOmp(block: OmpBlock): OmpImport {
  const warnings: OmpWarning[] = [];
  const sources: Source[] = [];
  const doc: Record<string, any> = {};
  const modelsPath = `${block.dir}/models.yml`;
  const configPath = `${block.dir}/config.yml`;

  sources.push(stat(modelsPath));
  const models = readYaml(modelsPath, "models.yml");
  if (!isObj(models) || !isObj(models.providers)) throw new OmpError(`omp: ${modelsPath} has no providers map (its shape changed?)`);

  const providers: Record<string, any> = {};
  for (const name of block.providers) {
    const p = models.providers[name];
    if (name === CLAUDE_PROVIDER) { warnings.push({ text: `omp.providers: ${name} is reserved for Claude fallbacks and is not imported` }); continue; }
    if (!isObj(p)) { warnings.push({ text: `omp.providers: ${name} is not defined in ${modelsPath} (only providers defined there can be imported)` }); continue; }
    if (p.api !== "openai-completions" && p.api !== "anthropic-messages") { warnings.push({ text: `omp provider ${name}: api ${JSON.stringify(p.api)} is not one this gateway speaks; skipped` }); continue; }
    if (typeof p.baseUrl !== "string") { warnings.push({ text: `omp provider ${name}: no baseUrl; skipped` }); continue; }
    const out: Record<string, any> = { api: p.api, baseUrl: p.baseUrl };
    if (typeof p.apiKey === "string" && p.apiKey) out.apiKey = p.apiKey; // a !command, env name or op:// ref; never logged
    if (isObj(p.headers)) out.headers = Object.fromEntries(Object.entries(p.headers).filter(([, v]) => typeof v === "string"));
    const pc = compatOf(p.compat, p.api);
    if (pc) out.compat = pc;
    const ms: Record<string, any> = {};
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (!isObj(m) || typeof m.id !== "string") continue;
      const id = `${name}/${m.id}`;
      if (block.models && !block.models.includes(id)) continue;
      if (!ID_OK.test(m.id)) { warnings.push({ text: `omp model ${id}: id has characters model ids cannot carry; skipped` }); continue; }
      if (/(^|\/)claude-/.test(id)) { warnings.push({ text: `omp model ${id}: contains a Claude model name, which Claude Code would treat as that model; skipped` }); continue; }
      const mm: Record<string, any> = {};
      if (typeof m.name === "string") mm.name = m.name;
      if (typeof m.reasoning === "boolean") mm.reasoning = m.reasoning;
      if (Array.isArray(m.input)) mm.input = m.input.filter((x: unknown) => x === "text" || x === "image");
      if (typeof m.contextWindow === "number") mm.contextWindow = m.contextWindow;
      if (typeof m.maxTokens === "number") mm.maxTokens = m.maxTokens;
      const mc = compatOf(m.compat, p.api);
      if (mc) mm.compat = mc;
      if (block.timeouts && isObj(m.compat)) {
        const t: Record<string, number> = {};
        if (typeof m.compat.streamFirstEventTimeoutMs === "number" && m.compat.streamFirstEventTimeoutMs > 0) t.streamFirstEventTimeoutSeconds = Math.ceil(m.compat.streamFirstEventTimeoutMs / 1000);
        if (typeof m.compat.streamIdleTimeoutMs === "number" && m.compat.streamIdleTimeoutMs > 0) t.streamIdleTimeoutSeconds = Math.ceil(m.compat.streamIdleTimeoutMs / 1000);
        if (Object.keys(t).length) mm.timeouts = t;
      }
      ms[m.id] = mm;
    }
    if (!Object.keys(ms).length) { warnings.push({ text: `omp provider ${name}: no usable models; skipped` }); continue; }
    out.models = ms;
    providers[name] = out;
  }
  doc.providers = providers;
  for (const id of block.models ?? []) {
    const slash = id.indexOf("/");
    if (slash < 0 || !providers[id.slice(0, slash)]?.models?.[id.slice(slash + 1)]) warnings.push({ text: `omp.models: ${id} is not a model of an imported provider; skipped` });
  }
  const routable = (ref: string) => {
    const { id } = parseRef(ref);
    if (id.startsWith(`${CLAUDE_PROVIDER}/`)) return /^anthropic\/claude-[a-z0-9.\-]+$/.test(id);
    const slash = id.indexOf("/");
    return slash > 0 && providers[id.slice(0, slash)]?.models?.[id.slice(slash + 1)] !== undefined;
  };

  if (block.fallbackChains || block.timeouts) {
    sources.push(stat(configPath));
    const cfg = readYaml(configPath, "config.yml");
    if (!isObj(cfg)) throw new OmpError(`omp: ${configPath} is not a YAML map`);
    if (block.fallbackChains && isObj(cfg.retry)) {
      const r = cfg.retry;
      const retry: Record<string, any> = {};
      if (typeof r.maxRetries === "number" && r.maxRetries >= 0) retry.maxRetries = r.maxRetries;
      if (typeof r.rateLimitWalksChain === "boolean") retry.rateLimitWalksChain = r.rateLimitWalksChain;
      const chains: Record<string, string[]> = {};
      if (isObj(r.fallbackChains)) for (const [key, list] of Object.entries(r.fallbackChains)) {
        const { id } = parseRef(key);
        if (!routable(id) || id.startsWith(`${CLAUDE_PROVIDER}/`)) { warnings.push({ about: `chain ${id}`, text: `omp chain ${key}: ${id} is not an imported model; chain skipped` }); continue; }
        if (!Array.isArray(list)) continue;
        const kept: string[] = [];
        for (const e of list) {
          if (typeof e !== "string") continue;
          if (routable(e)) kept.push(e);
          else warnings.push({ about: `chain ${id}`, text: `omp chain ${key}: entry ${e} is not routable here (an omp built-in provider, or a provider not in omp.providers); skipped` });
        }
        chains[id] = kept;
      }
      if (Object.keys(chains).length) retry.fallbackChains = chains;
      if (Object.keys(retry).length) doc.retry = retry;
    }
    if (block.timeouts && isObj(cfg.providers)) {
      // omp: -1 = its own default (5 minutes), 0 = no watchdog, >0 = seconds, for every provider.
      const t: Record<string, number> = {};
      for (const k of ["streamFirstEventTimeoutSeconds", "streamIdleTimeoutSeconds"]) {
        const v = cfg.providers[k];
        if (typeof v !== "number" || v < 0) continue;
        if (v === 0) { warnings.push({ text: `omp providers.${k} is 0 (watchdog off); not imported, ours needs at least 1 second` }); continue; }
        t[k] = v;
      }
      if (Object.keys(t).length) doc.timeouts = t;
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
      catch { warnings.push({ text: `omp.agents: ${path} not found; skipped` }); continue; }
      const { front, body } = parseAgentFile(text, path);
      if (typeof front.model !== "string" || !routable(front.model) || parseRef(front.model).id.startsWith(`${CLAUDE_PROVIDER}/`)) {
        warnings.push({ about: `agent ${name}`, text: `omp agent ${name}: model ${JSON.stringify(front.model)} is not an imported model; skipped` });
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

function compatOf(c: unknown, api: string): Record<string, any> | null {
  if (!isObj(c) || api !== "openai-completions") return null;
  const out: Record<string, any> = {};
  for (const k of OPENAI_COMPAT_KEYS) if (k in c) out[k] = c[k];
  if (isObj(out.reasoningEffortMap)) out.reasoningEffortMap = Object.fromEntries(Object.entries(out.reasoningEffortMap).filter(([k]) => LEVEL_KEYS.includes(k)));
  if (out.maxTokensField !== undefined && out.maxTokensField !== "max_tokens" && out.maxTokensField !== "max_completion_tokens") delete out.maxTokensField;
  if (out.reasoningContentField !== undefined && out.reasoningContentField !== "reasoning_content" && out.reasoningContentField !== "reasoning") delete out.reasoningContentField;
  return Object.keys(out).length ? out : null;
}

/** Deep merge for maps; `over` wins key by key; lists and scalars replace. */
function deep(base: any, over: any): any {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deep(base[k], v) : v;
  return out;
}

/**
 * Our document laid over the imported one. Providers and their models merge key by
 * key; a chain, an agent and a single timeout or retry setting are replaced whole.
 * Returns the merged document and where each item came from.
 */
export function mergeOver(imported: Record<string, any>, ours: Record<string, any>) {
  const origins: Record<string, Origin> = {};
  const tag = (key: string, inOmp: boolean, inOurs: boolean) => { origins[key] = inOurs && inOmp ? "ours over omp" : inOurs ? "ours" : "omp"; };
  const merged: Record<string, any> = { ...ours };
  delete merged.omp;

  const ip = imported.providers ?? {}, op = isObj(ours.providers) ? ours.providers : {};
  const providers: Record<string, any> = {};
  for (const name of new Set([...Object.keys(ip), ...Object.keys(op)])) {
    providers[name] = deep(ip[name], op[name]);
    tag(`provider ${name}`, name in ip, name in op);
    const im = ip[name]?.models ?? {}, om = isObj(op[name]?.models) ? op[name].models : {};
    for (const m of new Set([...Object.keys(im), ...Object.keys(om)])) tag(`model ${name}/${m}`, m in im, m in om);
  }
  if (Object.keys(providers).length || "providers" in ours) merged.providers = providers;

  const ir = imported.retry ?? {}, or = isObj(ours.retry) ? ours.retry : {};
  const retry: Record<string, any> = { ...ir, ...or };
  for (const k of ["maxRetries", "rateLimitWalksChain"]) if (k in retry) tag(`retry.${k}`, k in ir, k in or);
  const ic = ir.fallbackChains ?? {}, oc = isObj(or.fallbackChains) ? or.fallbackChains : {};
  const chains = { ...ic, ...oc };
  for (const k of Object.keys(chains)) tag(`chain ${k}`, k in ic, k in oc);
  if (Object.keys(chains).length) retry.fallbackChains = chains;
  if (Object.keys(retry).length) merged.retry = retry;

  const it = imported.timeouts ?? {}, ot = isObj(ours.timeouts) ? ours.timeouts : {};
  const timeouts = { ...it, ...ot };
  for (const k of Object.keys(timeouts)) tag(`timeouts.${k}`, k in it, k in ot);
  if (Object.keys(timeouts).length) merged.timeouts = timeouts;

  const ia = imported.agents ?? {}, oa = isObj(ours.agents) ? ours.agents : {};
  const agents = { ...ia, ...oa };
  for (const k of Object.keys(agents)) tag(`agent ${k}`, k in ia, k in oa);
  if (Object.keys(agents).length) merged.agents = agents;

  return { merged, origins };
}
