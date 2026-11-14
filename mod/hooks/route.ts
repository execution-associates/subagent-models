// Pure routing logic for the mod (no `$`), so tests can run it directly.

export const FALLBACK_HEADER = "x-subagent-models-claude-fallback";
export const EFFORT_HEADER = "x-subagent-models-effort";
export const SIG_PREFIX = "smg1.";

/** What the mod needs from the YAML config (the gateway's `mod-config` output). */
export type ModView = {
  path: string;
  mtimeMs: number;
  socket: string;
  models: Record<string, { name: string; contextWindow: number; maxTokens: number; input: string[] }>;
  claudeFallbacks: Record<string, string[]>;
  agents: { name: string; model: string; effort: string | null; description: string; prompt: string | null; extra: Record<string, unknown> }[];
  /** Every file the config is built from (ours, and omp's when imported). */
  sources?: string[];
  /** omp entries that were skipped, and why. */
  warnings?: string[];
};

/** `/v1/messages` or `/v1/messages/count_tokens` with its query, or null for any other URL. */
export function messagesPath(url: string): string | null {
  const m = /^https?:\/\/[^/]+(\/v1\/messages(?:\/count_tokens)?)(\?.*)?$/.exec(url);
  return m ? m[1]! + (m[2] ?? "") : null;
}

/**
 * The routed model a request body names, or null. A cheap text test first: a JSON
 * string value cannot hold an unescaped `"model":"`, so only the top-level field
 * (or a nested one, which the parse rules out) can match.
 */
export function routedModel(body: string, ids: Iterable<string>): string | null {
  let hit = false;
  for (const id of ids) if (body.includes(`"model":${JSON.stringify(id)}`)) { hit = true; break; }
  if (!hit) return null;
  try {
    const m = JSON.parse(body)?.model;
    for (const id of ids) if (id === m) return id;
  } catch {}
  return null;
}

/** Headers for the gateway: everything but credentials (the gateway never gets a Claude login). */
export function gatewayHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const l = k.toLowerCase();
    if (v === "[redacted]" || l === "authorization" || l === "x-api-key" || l === "cookie" || l === "proxy-authorization") continue;
    out[k] = v;
  }
  return out;
}

const IDENTITY = /You are powered by the model\b[^\n]*/g;

/**
 * The engine's original request, re-aimed at a real Claude model: the model and effort
 * swapped, thinking blocks a foreign model produced (our signature) removed, and the
 * identity line naming the Claude model that now answers.
 */
export function claudeBody(original: string, claudeModel: string, level: string | null): string {
  const j = JSON.parse(original);
  j.model = claudeModel;
  if (level) {
    const effort = level === "off" || level === "minimal" ? "low" : level;
    j.output_config = { ...(j.output_config ?? {}), effort };
  }
  const fixText = (b: any) => (b && b.type === "text" && typeof b.text === "string" ? { ...b, text: b.text.replace(IDENTITY, `You are powered by the model ${claudeModel}.`) } : b);
  if (Array.isArray(j.system)) j.system = j.system.map(fixText);
  if (Array.isArray(j.messages)) {
    j.messages = j.messages.map((m: any) => {
      if (!m || !Array.isArray(m.content)) return m;
      let content = m.content
        .filter((b: any) => !(b && (b.type === "thinking" || b.type === "redacted_thinking") && (typeof b.signature !== "string" || b.signature.startsWith(SIG_PREFIX) || b.signature === "")))
        .map(fixText);
      if (m.role === "assistant" && content.length === 0) content = [{ type: "text", text: "(no content)" }];
      return { ...m, content };
    });
  }
  return JSON.stringify(j);
}

/** A response the mod answers itself: the engine reads it as an API error. */
export function errorValue(status: number, message: string) {
  return {
    value: {
      status,
      ok: false,
      headers: { "content-type": "application/json", "x-should-retry": "false" },
      text: JSON.stringify({ type: "error", error: { type: status === 404 ? "not_found_error" : "api_error", message } }),
    },
  };
}

/** The general-purpose agent's prompt, for configured agents that give none. */
export const GENERAL_PURPOSE_PROMPT = `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

const ENGINE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The `$.agent.register` spec for a configured agent. */
export function agentSpec(a: ModView["agents"][number], view: ModView): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    name: a.name,
    description: a.description,
    prompt: a.prompt ?? GENERAL_PURPOSE_PROMPT,
    model: a.model,
  };
  if (a.effort) spec.effort = ENGINE_EFFORTS.includes(a.effort) ? a.effort : "low";
  // A subagent on an id Claude Code does not know gets a 1M window (it logs
  // effectiveWindow=980000). autoCompactWindow can only lower that, so a model with a
  // smaller window compacts at its own size (Claude Code takes 100K at least).
  const win = view.models[a.model]?.contextWindow;
  if (win && win < 1_000_000) spec.autoCompactWindow = Math.max(100_000, win);
  return { ...spec, ...a.extra };
}

type FetchEvent = { url: string; init?: { headers?: Record<string, string>; body?: unknown; compress?: unknown; socketPath?: string; auth?: string; method?: string } };
type FetchResult = { value: { status: number; headers: Record<string, string> } & Record<string, unknown> } | { deny: string } | Record<string, unknown>;

/**
 * The http.fetch decision, with `send` standing for the hook's `next`:
 * a request for a configured model goes to the gateway; a Claude hand-back the
 * config names is re-sent as the original request with the model swapped; every
 * failure to reach the gateway is a loud error; everything else goes on as it came.
 */
export async function routeFetch<E extends FetchEvent>(e: E, view: ModView, send: (e: E) => Promise<any>, log: (m: string) => void = () => {}): Promise<any> {
  const body = e.init?.body;
  if (typeof body !== "string") return send(e);
  const path = messagesPath(e.url);
  if (!path) return send(e);
  const model = routedModel(body, Object.keys(view.models));
  if (!model) return send(e);

  const socket = view.socket;
  const { compress: _c, socketPath: _s, auth: _a, ...init } = e.init ?? {};
  let res: FetchResult;
  try {
    res = await send({ ...e, url: `http://subagent-models${path}`, init: { ...init, headers: gatewayHeaders(e.init?.headers), body, socketPath: socket } });
  } catch (err) {
    return errorValue(503, `subagent-models: the gateway is not answering on ${socket} (${(err as Error)?.message ?? err}). Nothing was sent to Claude. Check it with: systemctl --user status subagent-models; journalctl --user -u subagent-models -e`);
  }
  if (!res || !("value" in res) || !res.value) {
    const why = res && "deny" in res ? (res as { deny: string }).deny : "no answer";
    return errorValue(503, `subagent-models: the request to the gateway on ${socket} was refused (${why}). Nothing was sent to Claude.`);
  }
  const v = (res as { value: { status: number; headers: Record<string, string> } }).value;
  if (v.status === 0 || (v.status >= 500 && !v.headers["x-subagent-models-served-by"] && !v.headers["x-should-retry"])) {
    // Not the gateway's own answer (its errors carry x-should-retry): the socket is dead or something else answered.
    return errorValue(503, `subagent-models: the gateway on ${socket} did not answer (HTTP ${v.status}). Nothing was sent to Claude. Check it with: systemctl --user status subagent-models`);
  }
  const claude = v.headers[FALLBACK_HEADER];
  if (!claude) return res;
  // The chain reached a Claude entry. Serve it only if this session's copy of the
  // config names that Claude model for this id: never Claude by accident.
  if (!view.claudeFallbacks[model]?.includes(claude)) {
    return errorValue(503, `subagent-models: the gateway handed ${model} to Claude model ${claude}, which the config's fallback chain for ${model} does not name; refused`);
  }
  log(`subagent-models: ${model} fell back to Claude (${claude})`);
  return send({ ...e, init: { ...e.init, body: claudeBody(body, claude, v.headers[EFFORT_HEADER] ?? null) } });
}
