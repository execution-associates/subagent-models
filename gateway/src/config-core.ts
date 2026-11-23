// The config's shape and its validation, with no file system, process or runtime
// API: the Bun gateway (config.ts) and the hosted service share it. Every error
// names the path of the offending key, so whoever edits the config can fix it from
// the message alone.
import type { OmpBlock, Origin, Source } from "./omp-types";
import type { OmpModelInfo, OmpRuntime } from "./omp-types";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];
export const APIS = ["openai-completions", "anthropic-messages", "openai-responses"] as const;
export type Api = (typeof APIS)[number];
/** The provider name that means "a real Claude model, served with the session's own credential". */
export const CLAUDE_PROVIDER = "anthropic";

export type OpenAICompat = {
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** Level -> the value sent as `reasoning_effort`; null means send none. */
  reasoningEffortMap: Record<Level, string | null>;
  supportsReasoningEffort: boolean;
  /** Field the upstream streams reasoning in, and the field reasoning is echoed back in. */
  reasoningContentField: "reasoning_content" | "reasoning";
  /** Which earlier assistant turns get their reasoning echoed back: DeepSeek needs `tool-calls`. */
  replayReasoning: "tool-calls" | "all" | "none";
  supportsMultipleSystemMessages: boolean;
  supportsUsageInStreaming: boolean;
  supportsToolChoice: boolean;
  /** Merged into every request body (after translation). */
  extraBody: Record<string, unknown>;
};

export type AnthropicCompat = {
  /** How the upstream is asked to think: `budget` (thinking.budget_tokens), `adaptive` (thinking.type adaptive + output_config.effort), or `none`. */
  thinkingMode: "budget" | "adaptive" | "none";
  thinkingBudgets: Record<Exclude<Level, "off">, number>;
  stripCacheControl: boolean;
  supportsMidConversationSystem: boolean;
  /** `x-api-key` (Anthropic style) or `bearer` (Authorization: Bearer). */
  authHeader: "x-api-key" | "bearer";
  extraBody: Record<string, unknown>;
};

export type Timeouts = {
  streamFirstEventTimeoutSeconds: number;
  streamIdleTimeoutSeconds: number;
  /** 0 = no limit. */
  totalTimeoutSeconds: number;
};

export type ModelDef = {
  /** `<provider>/<key>`: the id Claude Code sends. */
  id: string;
  provider: string;
  key: string;
  upstreamId: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  defaultLevel: Level;
  openai: OpenAICompat;
  anthropic: AnthropicCompat;
  timeouts: Timeouts;
};

export type ProviderDef = {
  name: string;
  api: Api;
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
};

/** One entry of a chain: a configured model or a Claude model, with an optional level. */
export type Target =
  | { kind: "model"; ref: string; model: ModelDef; level: Level | null }
  | { kind: "omp"; ref: string; model: OmpModelInfo; level: Level | null }
  | { kind: "claude"; ref: string; claudeModel: string; level: Level | null };

/** What validate() needs to resolve ids through omp (omp-native mode). */
export type OmpExt = { runtime: OmpRuntime; providers: Set<string> };

export type AgentDef = {
  name: string;
  /** Model id as Claude Code sends it (no level suffix). */
  model: string;
  effort: Level | null;
  description: string;
  prompt: string | null;
  /** Remaining AgentSpec fields, passed to $.agent.register as written. */
  extra: Record<string, unknown>;
};

export type Config = {
  path: string;
  mtimeMs: number;
  gateway: { socket: string; listen: { host: string; port: number } | null; accessLog: string; captureDir: string | null; pingIntervalSeconds: number };
  secrets: { opServiceAccountTokenFile: string | null; keyCacheSeconds: number };
  timeouts: Timeouts;
  retry: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    rateLimitWalksChain: boolean;
    cooldownSeconds: number;
    walkOnClientErrors: boolean;
  };
  providers: Record<string, ProviderDef>;
  models: Record<string, ModelDef>;
  /** Routed id -> [primary, ...fallbacks]. */
  chains: Record<string, Target[]>;
  agents: AgentDef[];
  /** The omp block, or null when the file has none (then no omp file is read). */
  omp: OmpBlock | null;
  /** Where each provider, model, chain, agent and imported setting came from. */
  origins: Record<string, Origin>;
  /** Imported entries that were skipped, and why. */
  warnings: string[];
  /** Every file this config was built from (ours first), for hot reload. */
  sources: Source[];
  /** omp-native mode: the runtime, and the provider names whose ids route to it. */
  ompRuntime: OmpRuntime | null;
  ompProviders: string[];
  /** omp models the config names (agents, chains), resolved. */
  ompModels: Record<string, OmpModelInfo>;
};

export class ConfigError extends Error {
  constructor(public problems: string[], public file: string) {
    super(`${file}: ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Where validate() takes paths from: the Bun gateway expands ~ and $VARS and has a socket; the hosted service has neither. */
export type ValidateHost = { defaultSocket: () => string; expand: (p: string) => string };
const NO_HOST: ValidateHost = { defaultSocket: () => "", expand: p => p };

export type ValidateOptions = {
  host?: ValidateHost;
  /**
   * The hosted service: keys are literal (decrypted from its store, never written in
   * a file), base URLs must be public https, and there is no socket, log or capture.
   */
  hosted?: boolean;
  /**
   * Hosted only: base URLs exempt from the public-https rule. For a test's local
   * fake upstream; a deployed service passes nothing.
   */
  allowBaseUrl?: (url: string) => boolean;
};

const DEFAULT_EFFORT_MAP: Record<Level, string | null> = {
  off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};
const DEFAULT_OPENAI: OpenAICompat = {
  maxTokensField: "max_tokens",
  reasoningEffortMap: DEFAULT_EFFORT_MAP,
  supportsReasoningEffort: true,
  reasoningContentField: "reasoning_content",
  replayReasoning: "tool-calls",
  supportsMultipleSystemMessages: false,
  supportsUsageInStreaming: true,
  supportsToolChoice: true,
  extraBody: {},
};
const DEFAULT_ANTHROPIC: AnthropicCompat = {
  thinkingMode: "budget",
  thinkingBudgets: { minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 32768, max: 63999 },
  stripCacheControl: false,
  supportsMidConversationSystem: false,
  authHeader: "x-api-key",
  extraBody: {},
};
const DEFAULT_TIMEOUTS: Timeouts = { streamFirstEventTimeoutSeconds: 30, streamIdleTimeoutSeconds: 90, totalTimeoutSeconds: 0 };

/** Splits `provider/model[:level]` into its id and level. */
export function parseRef(ref: string): { id: string; level: Level | null } {
  const i = ref.lastIndexOf(":");
  if (i > 0 && (LEVELS as readonly string[]).includes(ref.slice(i + 1))) return { id: ref.slice(0, i), level: ref.slice(i + 1) as Level };
  return { id: ref, level: null };
}

// ---- small validation helpers: each pushes a message naming the key path ----
export type P = string[];
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function known(o: Record<string, unknown>, keys: string[], at: string, problems: P) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${at}.${k}: unknown key (known: ${keys.join(", ")})`);
}
function num(v: unknown, at: string, problems: P, d: number, min = 0): number {
  if (v === undefined || v === null) return d;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) { problems.push(`${at}: must be a number >= ${min}, got ${JSON.stringify(v)}`); return d; }
  return v;
}
function bool(v: unknown, at: string, problems: P, d: boolean): boolean {
  if (v === undefined || v === null) return d;
  if (typeof v !== "boolean") { problems.push(`${at}: must be true or false, got ${JSON.stringify(v)}`); return d; }
  return v;
}
function str(v: unknown, at: string, problems: P, d: string | null, required = false): string | null {
  if (v === undefined || v === null) { if (required) problems.push(`${at}: required`); return d; }
  if (typeof v !== "string") { problems.push(`${at}: must be a string, got ${JSON.stringify(v)}`); return d; }
  return v;
}
function oneOf<T extends string>(v: unknown, choices: readonly T[], at: string, problems: P, d: T): T {
  if (v === undefined || v === null) return d;
  if (!choices.includes(v as T)) { problems.push(`${at}: must be one of ${choices.join(", ")}, got ${JSON.stringify(v)}`); return d; }
  return v as T;
}
function strMap(v: unknown, at: string, problems: P): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) { problems.push(`${at}: must be a map of strings`); return {}; }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) typeof x === "string" ? (out[k] = x) : problems.push(`${at}.${k}: must be a string`);
  return out;
}

function timeouts(v: unknown, at: string, problems: P, base: Timeouts): Timeouts {
  if (v === undefined || v === null) return base;
  if (!isObj(v)) { problems.push(`${at}: must be a map`); return base; }
  known(v, Object.keys(DEFAULT_TIMEOUTS), at, problems);
  return {
    streamFirstEventTimeoutSeconds: num(v.streamFirstEventTimeoutSeconds, `${at}.streamFirstEventTimeoutSeconds`, problems, base.streamFirstEventTimeoutSeconds, 1),
    streamIdleTimeoutSeconds: num(v.streamIdleTimeoutSeconds, `${at}.streamIdleTimeoutSeconds`, problems, base.streamIdleTimeoutSeconds, 1),
    totalTimeoutSeconds: num(v.totalTimeoutSeconds, `${at}.totalTimeoutSeconds`, problems, base.totalTimeoutSeconds, 0),
  };
}

function openaiCompat(v: Record<string, unknown>, at: string, problems: P, base: OpenAICompat): OpenAICompat {
  const map = { ...base.reasoningEffortMap };
  if (v.reasoningEffortMap !== undefined) {
    if (!isObj(v.reasoningEffortMap)) problems.push(`${at}.reasoningEffortMap: must be a map of level -> value`);
    else for (const [k, x] of Object.entries(v.reasoningEffortMap)) {
      if (!(LEVELS as readonly string[]).includes(k)) problems.push(`${at}.reasoningEffortMap.${k}: not a level (levels: ${LEVELS.join(", ")})`);
      else if (x !== null && typeof x !== "string") problems.push(`${at}.reasoningEffortMap.${k}: must be a string or null`);
      else map[k as Level] = x as string | null;
    }
  }
  return {
    maxTokensField: oneOf(v.maxTokensField, ["max_tokens", "max_completion_tokens"] as const, `${at}.maxTokensField`, problems, base.maxTokensField),
    reasoningEffortMap: map,
    supportsReasoningEffort: bool(v.supportsReasoningEffort, `${at}.supportsReasoningEffort`, problems, base.supportsReasoningEffort),
    reasoningContentField: oneOf(v.reasoningContentField, ["reasoning_content", "reasoning"] as const, `${at}.reasoningContentField`, problems, base.reasoningContentField),
    replayReasoning: oneOf(v.replayReasoning, ["tool-calls", "all", "none"] as const, `${at}.replayReasoning`, problems, base.replayReasoning),
    supportsMultipleSystemMessages: bool(v.supportsMultipleSystemMessages, `${at}.supportsMultipleSystemMessages`, problems, base.supportsMultipleSystemMessages),
    supportsUsageInStreaming: bool(v.supportsUsageInStreaming, `${at}.supportsUsageInStreaming`, problems, base.supportsUsageInStreaming),
    supportsToolChoice: bool(v.supportsToolChoice, `${at}.supportsToolChoice`, problems, base.supportsToolChoice),
    extraBody: v.extraBody === undefined ? base.extraBody : isObj(v.extraBody) ? { ...base.extraBody, ...v.extraBody } : (problems.push(`${at}.extraBody: must be a map`), base.extraBody),
  };
}
const OPENAI_KEYS = Object.keys(DEFAULT_OPENAI);

function anthropicCompat(v: Record<string, unknown>, at: string, problems: P, base: AnthropicCompat): AnthropicCompat {
  const budgets = { ...base.thinkingBudgets };
  if (v.thinkingBudgets !== undefined) {
    if (!isObj(v.thinkingBudgets)) problems.push(`${at}.thinkingBudgets: must be a map of level -> tokens`);
    else for (const [k, x] of Object.entries(v.thinkingBudgets)) {
      if (!(LEVELS as readonly string[]).includes(k) || k === "off") problems.push(`${at}.thinkingBudgets.${k}: not a level`);
      else budgets[k as Exclude<Level, "off">] = num(x, `${at}.thinkingBudgets.${k}`, problems, 1024, 1024);
    }
  }
  return {
    thinkingMode: oneOf(v.thinkingMode, ["budget", "adaptive", "none"] as const, `${at}.thinkingMode`, problems, base.thinkingMode),
    thinkingBudgets: budgets,
    stripCacheControl: bool(v.stripCacheControl, `${at}.stripCacheControl`, problems, base.stripCacheControl),
    supportsMidConversationSystem: bool(v.supportsMidConversationSystem, `${at}.supportsMidConversationSystem`, problems, base.supportsMidConversationSystem),
    authHeader: oneOf(v.authHeader, ["x-api-key", "bearer"] as const, `${at}.authHeader`, problems, base.authHeader),
    extraBody: v.extraBody === undefined ? base.extraBody : isObj(v.extraBody) ? { ...base.extraBody, ...v.extraBody } : (problems.push(`${at}.extraBody: must be a map`), base.extraBody),
  };
}
const ANTHROPIC_KEYS = Object.keys(DEFAULT_ANTHROPIC);

function compat(v: unknown, at: string, api: Api, problems: P, bo: OpenAICompat, ba: AnthropicCompat) {
  if (v === undefined || v === null) return { openai: bo, anthropic: ba };
  if (!isObj(v)) { problems.push(`${at}: must be a map`); return { openai: bo, anthropic: ba }; }
  known(v, api === "anthropic-messages" ? ANTHROPIC_KEYS : OPENAI_KEYS, at, problems);
  return api === "anthropic-messages"
    ? { openai: bo, anthropic: anthropicCompat(v, at, problems, ba) }
    : { openai: openaiCompat(v, at, problems, bo), anthropic: ba };
}

const ID_OK = /^[A-Za-z0-9._\-\/]+$/;

/** Validates a parsed YAML document. Pure: no file system, no network. */
export function validate(doc: unknown, file = "config.yml", mtimeMs = 0, omp?: OmpExt, opts: ValidateOptions = {}): Config {
  const problems: P = [];
  const host = opts.host ?? NO_HOST;
  const hosted = opts.hosted === true;
  const expandPath = host.expand;
  if (!isObj(doc)) throw new ConfigError(["the file must be a YAML map at the top level"], file);
  known(doc, ["gateway", "secrets", "timeouts", "retry", "providers", "agents", "omp"], "(top level)", problems);
  if (hosted) for (const k of ["secrets", "omp"]) if (doc[k] !== undefined) problems.push(`${k}: not available on the hosted service`);

  const g = isObj(doc.gateway) ? doc.gateway : doc.gateway === undefined ? {} : (problems.push("gateway: must be a map"), {});
  known(g, ["socket", "listen", "accessLog", "captureDir", "pingIntervalSeconds"], "gateway", problems);
  const gateway = {
    socket: hosted ? "" : expandPath(str(g.socket, "gateway.socket", problems, null) ?? host.defaultSocket()),
    listen: parseListen(g.listen, problems),
    accessLog: hosted ? "" : expandPath(str(g.accessLog, "gateway.accessLog", problems, null) ?? "~/.local/state/subagent-models/access.jsonl"),
    captureDir: hosted ? null : ((c) => (c ? expandPath(c) : null))(str(g.captureDir, "gateway.captureDir", problems, null)),
    pingIntervalSeconds: num(g.pingIntervalSeconds, "gateway.pingIntervalSeconds", problems, 15, 1),
  };
  if (hosted && (g.socket !== undefined || g.listen !== undefined || g.accessLog !== undefined || g.captureDir !== undefined)) problems.push("gateway: the hosted service takes only pingIntervalSeconds here");
  if (new TextEncoder().encode(gateway.socket).length > 100) problems.push(`gateway.socket: ${gateway.socket} is longer than 100 bytes, too long for a Unix socket`);

  const s = isObj(doc.secrets) ? doc.secrets : doc.secrets === undefined ? {} : (problems.push("secrets: must be a map"), {});
  known(s, ["opServiceAccountTokenFile", "keyCacheSeconds"], "secrets", problems);
  const secrets = {
    opServiceAccountTokenFile: hosted ? null : ((t) => (t ? expandPath(t) : null))(str(s.opServiceAccountTokenFile, "secrets.opServiceAccountTokenFile", problems, null)),
    keyCacheSeconds: num(s.keyCacheSeconds, "secrets.keyCacheSeconds", problems, 3600, 0),
  };

  const globalTimeouts = timeouts(doc.timeouts, "timeouts", problems, DEFAULT_TIMEOUTS);

  const r = isObj(doc.retry) ? doc.retry : doc.retry === undefined ? {} : (problems.push("retry: must be a map"), {});
  known(r, ["maxRetries", "baseDelayMs", "maxDelayMs", "rateLimitWalksChain", "cooldownSeconds", "walkOnClientErrors", "fallbackChains"], "retry", problems);
  const retry = {
    maxRetries: num(r.maxRetries, "retry.maxRetries", problems, 2, 0),
    baseDelayMs: num(r.baseDelayMs, "retry.baseDelayMs", problems, 500, 0),
    maxDelayMs: num(r.maxDelayMs, "retry.maxDelayMs", problems, 20000, 0),
    rateLimitWalksChain: bool(r.rateLimitWalksChain, "retry.rateLimitWalksChain", problems, true),
    cooldownSeconds: num(r.cooldownSeconds, "retry.cooldownSeconds", problems, 300, 0),
    walkOnClientErrors: bool(r.walkOnClientErrors, "retry.walkOnClientErrors", problems, false),
  };

  const providers: Record<string, ProviderDef> = {};
  const models: Record<string, ModelDef> = {};
  if (!isObj(doc.providers)) {
    if (!omp) problems.push("providers: required, a map of provider name -> provider (or an omp: block)");
    else if (doc.providers !== undefined && doc.providers !== null) problems.push("providers: must be a map");
  }
  else for (const [pname, pv] of Object.entries(doc.providers)) {
    const at = `providers.${pname}`;
    if (pname === CLAUDE_PROVIDER) { problems.push(`${at}: "${CLAUDE_PROVIDER}" is reserved for real Claude models (served with the session's own login); use it only in fallback chains, as ${CLAUDE_PROVIDER}/<claude-model-id>`); continue; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(pname)) { problems.push(`${at}: provider names are lowercase letters, digits, - and _`); continue; }
    if (!isObj(pv)) { problems.push(`${at}: must be a map`); continue; }
    known(pv, ["api", "baseUrl", "apiKey", "headers", "compat", "timeouts", "models"], at, problems);
    const api = oneOf(pv.api, APIS, `${at}.api`, problems, "openai-completions");
    if (pv.api === undefined) problems.push(`${at}.api: required (one of ${APIS.join(", ")})`);
    if (api === "openai-responses") problems.push(`${at}.api: openai-responses is not implemented yet (the seam is gateway/src/upstream.ts); use openai-completions`);
    const baseUrl = (str(pv.baseUrl, `${at}.baseUrl`, problems, "", true) ?? "").replace(/\/+$/, "");
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) problems.push(`${at}.baseUrl: must start with http:// or https://`);
    else if (baseUrl && hosted && !opts.allowBaseUrl?.(baseUrl)) { const why = hostedUrlProblem(baseUrl); if (why) problems.push(`${at}.baseUrl: ${why}`); }
    const apiKey = str(pv.apiKey, `${at}.apiKey`, problems, null);
    if (apiKey && !hosted && /^(sk-|sk_|ey[A-Za-z0-9])/.test(apiKey)) problems.push(`${at}.apiKey: looks like a literal key; use an op:// reference, a !command, or the name of an environment variable`);
    providers[pname] = { name: pname, api, baseUrl, apiKey, headers: strMap(pv.headers, `${at}.headers`, problems) };
    const pc = compat(pv.compat, `${at}.compat`, api, problems, DEFAULT_OPENAI, DEFAULT_ANTHROPIC);
    const pt = timeouts(pv.timeouts, `${at}.timeouts`, problems, globalTimeouts);
    if (!isObj(pv.models) || Object.keys(pv.models).length === 0) { problems.push(`${at}.models: required, a map of model key -> model`); continue; }
    for (const [mkey, mv] of Object.entries(pv.models)) {
      const mat = `${at}.models.${mkey}`;
      const id = `${pname}/${mkey}`;
      if (!ID_OK.test(mkey)) { problems.push(`${mat}: model keys use letters, digits, . _ - and /`); continue; }
      if (/(^|\/)claude-/.test(id) || id.startsWith("claude")) problems.push(`${mat}: the id ${id} contains a Claude model name; Claude Code would treat it as that Claude model. Pick another key and set upstreamId`);
      const m = mv === null || mv === undefined ? {} : mv;
      if (!isObj(m)) { problems.push(`${mat}: must be a map`); continue; }
      known(m, ["upstreamId", "name", "reasoning", "input", "contextWindow", "maxTokens", "defaultLevel", "compat", "timeouts"], mat, problems);
      let input: ("text" | "image")[] = ["text"];
      if (m.input !== undefined) {
        if (!Array.isArray(m.input) || !m.input.every(x => x === "text" || x === "image")) problems.push(`${mat}.input: must be a list of text and/or image`);
        else input = m.input as ("text" | "image")[];
      }
      const mc = compat(m.compat, `${mat}.compat`, api, problems, pc.openai, pc.anthropic);
      models[id] = {
        id, provider: pname, key: mkey,
        upstreamId: str(m.upstreamId, `${mat}.upstreamId`, problems, mkey) ?? mkey,
        name: str(m.name, `${mat}.name`, problems, mkey) ?? mkey,
        reasoning: bool(m.reasoning, `${mat}.reasoning`, problems, true),
        input,
        contextWindow: num(m.contextWindow, `${mat}.contextWindow`, problems, 200000, 1000),
        maxTokens: num(m.maxTokens, `${mat}.maxTokens`, problems, 32000, 1),
        defaultLevel: oneOf(m.defaultLevel, LEVELS, `${mat}.defaultLevel`, problems, "high"),
        openai: mc.openai, anthropic: mc.anthropic,
        timeouts: timeouts(m.timeouts, `${mat}.timeouts`, problems, pt),
      };
    }
  }

  const ompModels: Record<string, OmpModelInfo> = {};
  const ompModel = (id: string): OmpModelInfo | undefined => {
    if (!omp || !ompResolves(id, omp.providers, omp.runtime)) return undefined;
    const slash = id.indexOf("/");
    const m = omp.runtime.find(id.slice(0, slash), id.slice(slash + 1));
    if (m) ompModels[id] = m;
    return m;
  };
  const target = (ref: unknown, at: string): Target | null => {
    if (typeof ref !== "string") { problems.push(`${at}: must be a string like provider/model or provider/model:high`); return null; }
    const { id, level } = parseRef(ref);
    if (id.startsWith(`${CLAUDE_PROVIDER}/`)) {
      const claudeModel = id.slice(CLAUDE_PROVIDER.length + 1);
      if (!/^claude-[a-z0-9.\-]+$/.test(claudeModel)) { problems.push(`${at}: ${ref}: a Claude entry is ${CLAUDE_PROVIDER}/claude-<model>, e.g. ${CLAUDE_PROVIDER}/claude-sonnet-5-5`); return null; }
      return { kind: "claude", ref, claudeModel, level };
    }
    const model = models[id];
    if (model) return { kind: "model", ref, model, level };
    const om = ompModel(id);
    if (om) return { kind: "omp", ref, model: om, level };
    problems.push(`${at}: ${ref}: no such model (configured: ${Object.keys(models).join(", ") || "none"}${omp ? "; and omp resolves no such model" : ""})`);
    return null;
  };

  const chains: Record<string, Target[]> = {};
  for (const id of Object.keys(models)) chains[id] = [{ kind: "model", ref: id, model: models[id]!, level: null }];
  if (r.fallbackChains !== undefined) {
    if (!isObj(r.fallbackChains)) problems.push("retry.fallbackChains: must be a map of model id -> list of fallbacks");
    else for (const [ref, list] of Object.entries(r.fallbackChains)) {
      const at = `retry.fallbackChains.${ref}`;
      const { id, level } = parseRef(ref);
      const head = models[id] ? { kind: "model" as const, ref: id, model: models[id]!, level: null } : ompModel(id) ? { kind: "omp" as const, ref: id, model: ompModel(id)!, level: null } : null;
      if (!head) { problems.push(`${at}: no such model ${id} (a chain is keyed by a model id${omp ? " this file or omp resolves" : " configured here"})`); continue; }
      chains[id] ??= [head];
      if (level) problems.push(`${at}: the chain key takes no level; put levels on the entries`);
      if (!Array.isArray(list)) { problems.push(`${at}: must be a list`); continue; }
      list.forEach((e, i) => { const t = target(e, `${at}[${i}]`); if (t) chains[id]!.push(t); });
      const seen = new Set<string>();
      for (const t of chains[id]!) { const k = t.kind === "claude" ? `claude:${t.claudeModel}` : t.model.id; if (seen.has(k)) problems.push(`${at}: ${t.ref} appears twice in the chain`); seen.add(k); }
    }
  }

  const agents: AgentDef[] = [];
  if (doc.agents !== undefined && doc.agents !== null) {
    if (!isObj(doc.agents)) problems.push("agents: must be a map of agent name -> agent");
    else for (const [name, av] of Object.entries(doc.agents)) {
      const at = `agents.${name}`;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) { problems.push(`${at}: agent names are letters, digits, _ and -, up to 64`); continue; }
      if (!isObj(av)) { problems.push(`${at}: must be a map`); continue; }
      const { model: mref, description, prompt, effort, ...extra } = av;
      if (typeof mref !== "string") { problems.push(`${at}.model: required, a configured model id (optionally with :level)`); continue; }
      const { id, level } = parseRef(mref);
      if (!models[id] && !ompModel(id)) { problems.push(`${at}.model: ${mref}: no such model (configured: ${Object.keys(models).join(", ")}${omp ? "; and omp resolves no such model" : ""})`); continue; }
      if (typeof description !== "string" || !description.trim()) problems.push(`${at}.description: required (the line the main agent reads when choosing an agent)`);
      if (prompt !== undefined && typeof prompt !== "string") problems.push(`${at}.prompt: must be a string`);
      const eff = effort === undefined ? null : oneOf(effort, LEVELS, `${at}.effort`, problems, "high");
      for (const k of ["name", "hooks"]) if (k in extra) problems.push(`${at}.${k}: not allowed here`);
      agents.push({ name, model: id, effort: eff ?? level, description: String(description ?? ""), prompt: (prompt as string) ?? null, extra });
    }
  }

  if (problems.length) throw new ConfigError(problems, file);
  return { path: file, mtimeMs, gateway, secrets, timeouts: globalTimeouts, retry, providers, models, chains, agents, omp: null, origins: {}, warnings: [], sources: [{ path: file, mtimeMs }], ompRuntime: null, ompProviders: [], ompModels };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * `gateway.listen`: an extra TCP listener, `host:port` or a bare port (127.0.0.1).
 * Loopback only: the gateway has no auth of its own, so whatever publishes it
 * (a cloudflared tunnel behind Cloudflare Access) must be the gate.
 */
function parseListen(v: unknown, problems: string[]): { host: string; port: number } | null {
  if (v === undefined || v === null) return null;
  const raw = typeof v === "number" ? `127.0.0.1:${v}` : typeof v === "string" ? v : null;
  if (raw === null) { problems.push("gateway.listen: must be host:port or a port number"); return null; }
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(raw.includes(":") ? raw : `127.0.0.1:${raw}`);
  const port = m ? Number(m[3]) : NaN;
  if (!m || !(port >= 1 && port <= 65535)) { problems.push(`gateway.listen: ${raw} is not host:port`); return null; }
  const host = (m[1] ?? m[2])!;
  if (!LOOPBACK.has(host)) { problems.push(`gateway.listen: ${host} is not a loopback address (127.0.0.1, ::1, localhost); the gateway has no auth, so publish it through a tunnel with its own gate`); return null; }
  return { host, port };
}

/** What the mod needs, as plain JSON (no keys: apiKey sources are not included). */
export function modView(c: Config) {
  return {
    path: c.path,
    mtimeMs: c.mtimeMs,
    socket: c.gateway.socket,
    models: Object.fromEntries([...Object.values(c.models), ...Object.values(c.ompModels)].map(m => [m.id, { name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input }])),
    /** Provider names whose `<provider>/<model>` ids route to the gateway: ours, then omp's. */
    providers: [...Object.keys(c.providers), ...c.ompProviders],
    /** Routed id -> Claude models its chain may hand back to the session. */
    claudeFallbacks: Object.fromEntries(Object.entries(c.chains).map(([id, ts]) => [id, ts.filter(t => t.kind === "claude").map(t => (t as { claudeModel: string }).claudeModel)])),
    agents: c.agents.map(a => ({ name: a.name, model: a.model, effort: a.effort, description: a.description, prompt: a.prompt, extra: a.extra })),
    /** Every file the config was built from: the mod re-reads when any changes. */
    sources: c.sources.map(s => s.path),
    warnings: c.warnings,
  };
}
export type ModView = ReturnType<typeof modView>;

/** Whether `ref` (with or without a level) names a model omp resolves among `providers`. */
export function ompResolves(ref: string, providers: Set<string>, rt: OmpRuntime): boolean {
  const { id } = parseRef(ref);
  const slash = id.indexOf("/");
  // An id naming a Claude model would be taken by Claude Code for that model: never routed.
  if (slash <= 0 || /(^|\/)claude-/.test(id)) return false;
  const p = id.slice(0, slash);
  return providers.has(p) && rt.find(p, id.slice(slash + 1)) !== undefined;
}

/**
 * Why a hosted provider's base URL is refused, or null. The service fetches what
 * its users give it, so only public https hosts by name: no IP literals, no
 * loopback, private or link-local names (server-side request forgery).
 */
export function hostedUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "is not a URL"; }
  if (u.protocol !== "https:") return "must be an https:// URL";
  if (u.username || u.password) return "must not carry a user name or password";
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") || /^[0-9.]+$/.test(h) || /^0x/i.test(h)) return "must name a host, not an IP address";
  if (!h.includes(".")) return "must be a public host name";
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(h)) return "must be a public host name";
  return null;
}
