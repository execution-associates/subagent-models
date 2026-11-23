// The engine's request, reduced to what any upstream can be asked for.
//
// Claude Code sends a Messages API body full of first-party extras: an attribution
// block in `system`, `role: "system"` entries mid-conversation, `tool_addition`
// blocks (tools loaded by ToolSearch), deferred tools, server tools, cache_control,
// context_management, thread, diagnostics, metadata (device and account ids),
// thinking blocks with signatures. Each is handled here, deliberately, once; the
// adapters (openai.ts, anthropic.ts) only translate this canonical form.
import type { Level } from "./config-core";

export type CText = { type: "text"; text: string; cache?: unknown };
export type CImage = { type: "image"; mediaType: string; data?: string; url?: string };
export type CToolResult = { type: "tool_result"; toolUseId: string; content: (CText | CImage)[]; isError: boolean };
export type CToolUse = { type: "tool_use"; id: string; name: string; input: unknown };
/** `origin` is the routed model id that produced it (our signature), or null for a Claude one. */
export type CThinking = { type: "thinking"; thinking: string; origin: string | null; upstreamSignature: string | null };
export type CBlock = CText | CImage | CToolResult | CToolUse | CThinking;
export type CMessage = { role: "user" | "assistant"; content: CBlock[] } | { role: "system"; text: string };
export type CTool = { name: string; description: string; inputSchema: Record<string, unknown>; cache?: unknown };

export type Canonical = {
  model: string;
  system: CText[];
  messages: CMessage[];
  tools: CTool[];
  toolChoice: { type: "auto" | "any" | "none" } | { type: "tool"; name: string } | null;
  disableParallelToolUse: boolean;
  maxTokens: number;
  stopSequences: string[];
  temperature: number | null;
  topP: number | null;
  /** Level the request asked for (effort or thinking budget); null = no preference. */
  level: Level | null;
  stream: boolean;
  /** What was dropped, for the access log. */
  dropped: string[];
};

export const SIG_PREFIX = "smg1.";

/** Our thinking signature: the routed model that produced the block, plus the upstream's own signature. */
export function makeSignature(origin: string, upstreamSignature?: string | null): string {
  const json = JSON.stringify(upstreamSignature ? { m: origin, s: upstreamSignature } : { m: origin });
  return SIG_PREFIX + toBase64Url(json);
}
export function readSignature(sig: unknown): { origin: string; upstreamSignature: string | null } | null {
  if (typeof sig !== "string" || !sig.startsWith(SIG_PREFIX)) return null;
  try {
    const j = JSON.parse(fromBase64Url(sig.slice(SIG_PREFIX.length)));
    return typeof j.m === "string" ? { origin: j.m, upstreamSignature: typeof j.s === "string" ? j.s : null } : null;
  } catch { return null; }
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function levelOf(body: Record<string, any>): Level | null {
  const effort = body.output_config?.effort;
  if (typeof effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(effort)) return effort as Level;
  const t = body.thinking;
  if (!isObj(t) || t.type === "disabled") return "off";
  if (t.type === "enabled" && typeof t.budget_tokens === "number") {
    const b = t.budget_tokens;
    return b <= 2048 ? "low" : b <= 8192 ? "medium" : b <= 24000 ? "high" : "max";
  }
  return null;
}

function imageOf(b: Record<string, any>): CImage | null {
  const s = b.source;
  if (!isObj(s)) return null;
  if (s.type === "base64" && typeof s.data === "string") return { type: "image", mediaType: s.media_type || "image/png", data: s.data };
  if (s.type === "url" && typeof s.url === "string") return { type: "image", mediaType: "", url: s.url };
  return null;
}

/** A document block as text: plain-text sources keep their text, anything else becomes a note. */
function documentText(b: Record<string, any>): string {
  const s = b.source;
  const title = typeof b.title === "string" ? ` "${b.title}"` : "";
  if (isObj(s) && s.type === "text" && typeof s.data === "string") return `[document${title}]\n${s.data}`;
  if (isObj(s) && s.type === "content" && Array.isArray(s.content)) return `[document${title}]\n${s.content.map((x: any) => x?.text ?? "").join("\n")}`;
  return `[document${title} (${s?.media_type ?? s?.type ?? "unknown"}) omitted: this model is not sent documents]`;
}

export function normalize(raw: unknown): Canonical {
  if (!isObj(raw)) throw new BadRequest("the body must be a JSON object");
  const body = raw;
  if (typeof body.model !== "string") throw new BadRequest("model: required");
  if (!Array.isArray(body.messages)) throw new BadRequest("messages: required");
  const dropped = new Set<string>();

  // system: a string or text blocks. The attribution block is Claude Code's, for
  // Anthropic's own billing; it changes every prompt and would defeat upstream caching.
  const system: CText[] = [];
  const sys = typeof body.system === "string" ? [{ type: "text", text: body.system }] : Array.isArray(body.system) ? body.system : [];
  for (const b of sys) {
    if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") continue;
    if (b.text.startsWith("x-anthropic-billing-header:")) { dropped.add("attribution block"); continue; }
    system.push({ type: "text", text: b.text, ...(b.cache_control ? { cache: b.cache_control } : {}) });
  }

  // tools: custom tools keep; deferred ones are held until a tool_reference loads
  // them; server tools (web search, advisor, ...) run on Anthropic's side and are dropped.
  const tools = new Map<string, CTool>();
  const deferred = new Map<string, CTool>();
  const addTool = (t: Record<string, any>, into: Map<string, CTool>) => {
    if (typeof t.name !== "string") return;
    into.set(t.name, {
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: isObj(t.input_schema) ? t.input_schema : { type: "object", properties: {} },
      ...(t.cache_control ? { cache: t.cache_control } : {}),
    });
  };
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (!isObj(t)) continue;
    if (t.type && t.type !== "custom") { dropped.add(`server tool ${t.type}`); continue; }
    if (t.name === "DeferredToolPlaceholder") continue;
    addTool(t, t.defer_loading ? deferred : tools);
  }
  const loadReferenced = (name: string) => {
    const d = deferred.get(name);
    if (d && !tools.has(name)) tools.set(name, d);
  };

  const messages: CMessage[] = [];
  for (const m of body.messages) {
    if (!isObj(m)) continue;
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === "system") {
      // Mid-conversation system entries carry reminders and tool_addition blocks
      // (tools ToolSearch loaded). An entry with no blocks only carries per-turn effort.
      const texts: string[] = [];
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text) texts.push(b.text);
        else if (b.type === "tool_addition" && isObj(b.tool)) {
          const def = isObj(b.tool.definition) ? b.tool.definition : b.tool;
          addTool(def, tools);
        } else if (b.type === "tool_removal" && isObj(b.tool) && typeof b.tool.name === "string") tools.delete(b.tool.name);
        else if (b.type !== "text") dropped.add(`system block ${b.type}`);
      }
      if (texts.length) messages.push({ role: "system", text: texts.join("\n\n") });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const out: CBlock[] = [];
    for (const b of content) {
      if (!isObj(b)) continue;
      switch (b.type) {
        case "text":
          if (typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text, ...(b.cache_control ? { cache: b.cache_control } : {}) });
          break;
        case "image": {
          const img = imageOf(b);
          if (img) out.push(img);
          break;
        }
        case "document":
          out.push({ type: "text", text: documentText(b) });
          break;
        case "tool_use":
        case "server_tool_use":
          if (b.type === "server_tool_use") { dropped.add("server_tool_use"); break; }
          out.push({ type: "tool_use", id: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input ?? {} });
          break;
        case "tool_result": {
          const parts: (CText | CImage)[] = [];
          const c = typeof b.content === "string" ? [{ type: "text", text: b.content }] : Array.isArray(b.content) ? b.content : [];
          for (const x of c) {
            if (!isObj(x)) continue;
            if (x.type === "text" && typeof x.text === "string") parts.push({ type: "text", text: x.text });
            else if (x.type === "image") { const img = imageOf(x); if (img) parts.push(img); }
            else if (x.type === "tool_reference" && typeof x.tool_name === "string") {
              loadReferenced(x.tool_name);
              parts.push({ type: "text", text: `Tool loaded: ${x.tool_name}` });
            } else if (x.type === "document") parts.push({ type: "text", text: documentText(x) });
            else if (x.type === "search_result") parts.push({ type: "text", text: `${x.title ?? ""} ${x.source ?? ""}\n${(x.content ?? []).map((y: any) => y?.text ?? "").join("\n")}` });
          }
          out.push({ type: "tool_result", toolUseId: String(b.tool_use_id ?? ""), content: parts, isError: b.is_error === true });
          break;
        }
        case "thinking": {
          const ours = readSignature(b.signature);
          out.push({ type: "thinking", thinking: typeof b.thinking === "string" ? b.thinking : "", origin: ours?.origin ?? null, upstreamSignature: ours?.upstreamSignature ?? null });
          break;
        }
        case "redacted_thinking":
          dropped.add("redacted_thinking");
          break;
        default:
          dropped.add(`block ${b.type}`);
      }
    }
    messages.push({ role: m.role, content: out });
  }

  let toolChoice: Canonical["toolChoice"] = null;
  let disableParallelToolUse = false;
  if (isObj(body.tool_choice)) {
    const tc = body.tool_choice;
    disableParallelToolUse = tc.disable_parallel_tool_use === true;
    if (tc.type === "tool" && typeof tc.name === "string") toolChoice = { type: "tool", name: tc.name };
    else if (tc.type === "auto" || tc.type === "any" || tc.type === "none") toolChoice = { type: tc.type };
  }

  for (const k of ["context_management", "thread", "diagnostics", "metadata", "container", "mcp_servers", "service_tier"]) if (k in body) dropped.add(k);

  return {
    model: body.model,
    system,
    messages,
    tools: [...tools.values()],
    toolChoice,
    disableParallelToolUse,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : 32000,
    stopSequences: Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s: unknown) => typeof s === "string") : [],
    temperature: typeof body.temperature === "number" ? body.temperature : null,
    topP: typeof body.top_p === "number" ? body.top_p : null,
    level: levelOf(body),
    stream: body.stream === true,
    dropped: [...dropped],
  };
}

export class BadRequest extends Error {}

const IDENTITY = /You are powered by the model\b[^\n]*/g;
const HARNESS = /You are a Claude agent, built on Anthropic's Claude Agent SDK\./g;

/**
 * Tells the model what it really is. Claude Code writes "You are powered by the model
 * <id>." (and for Claude, its name and knowledge cutoff); that line is replaced in the
 * system prompt and in every user text block.
 */
export function withIdentity(c: Canonical, identity: string): Canonical {
  const fix = (s: string) => s.replace(IDENTITY, identity).replace(HARNESS, "You are an agent running in Claude Code, Anthropic's agent harness.");
  return {
    ...c,
    system: c.system.map(b => ({ ...b, text: fix(b.text) })),
    messages: c.messages.map(m =>
      m.role === "system" ? { ...m, text: fix(m.text) }
      : m.role === "user" ? { ...m, content: m.content.map(b => (b.type === "text" ? { ...b, text: fix(b.text) } : b)) }
      : m),
  };
}

/** Rough token estimate (count_tokens has no exact answer for a foreign model). */
export function estimateTokens(raw: Record<string, any>): number {
  let chars = 0, images = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (v.type === "image") { images++; return; }
      for (const [k, x] of Object.entries(v)) if (k !== "cache_control" && k !== "signature") walk(x);
    }
  };
  walk(raw.system); walk(raw.messages); walk(raw.tools);
  return Math.ceil(chars / 3.6) + images * 1600;
}

// Sub-keywords whose values are maps from a NAME to a schema; a property called
// "pattern" lives here and is not the keyword.
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/** A regex only JavaScript-flavoured engines take: \0 and other digit escapes, lookaround, or one JS itself refuses. */
function nonPortablePattern(p: string): boolean {
  if (/\\[0-9]/.test(p) || /\(\?<?[=!]/.test(p)) return true;
  try { new RegExp(p); return false; } catch { return true; }
}

/**
 * A tool schema for an upstream that is not Anthropic. Providers compile `pattern` with their
 * own regex engine and refuse the whole request over one they cannot parse (`^[^\0]*$`), so
 * those patterns are dropped; Claude Code still validates the tool input itself.
 */
export function portableSchema<T>(schema: T, names = false): T {
  if (Array.isArray(schema)) return schema.map(v => portableSchema(v)) as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!names && k === "pattern" && typeof v === "string" && nonPortablePattern(v)) continue;
    out[k] = names ? portableSchema(v) : portableSchema(v, NAME_MAPS.has(k));
  }
  return out as T;
}

// base64url of UTF-8 text, with web APIs only (the hosted Worker has no Buffer).
function toBase64Url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
