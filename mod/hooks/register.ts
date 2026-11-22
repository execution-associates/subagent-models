// subagent-models: native Claude Code subagents on non-Claude models.
//
// Every model request the engine sends passes `http.fetch`. A request whose
// `model` is one of the configured ids (refuseless/deepseek-v4.1-flash-fast, ...)
// is sent to the gateway instead of Anthropic (the local socket, or the HTTPS URL in
// SUBAGENT_MODELS_URL, whose /mod-config then stands in for the local config file), unchanged but for its URL
// and its credentials, which stay behind. Every other request goes on untouched.
// When the gateway's fallback chain lands on a real Claude model, it answers with
// a hand-back header and this hook re-sends the original request to Anthropic with
// that model, on the session's own login.
import type { EngineInterface, Register } from "claude-code";
import { type ModView, type Remote, agentSpec, errorValue, messagesPath, parseRemoteConfig, remoteFrom, routeFetch, routedModel } from "./route";

let view: ModView | null = null;
let configError: string | null = null;
let remote: Remote | null = null;

async function readRemote($: EngineInterface, r: Remote) {
  try {
    const res = await $.http.fetch(`${r.base}/mod-config`, { method: "GET", headers: r.headers });
    return parseRemoteConfig(r.base, res);
  } catch (e) {
    return { ok: false as const, error: `the gateway at ${r.base} is not answering (${(e as Error)?.message ?? e})` };
  }
}

async function configPath($: EngineInterface): Promise<string> {
  const explicit = await $.env.get("SUBAGENT_MODELS_CONFIG");
  if (explicit) return explicit;
  const xdg = await $.env.get("XDG_CONFIG_HOME");
  const home = await $.env.get("HOME");
  return `${xdg || `${home}/.config`}/subagent-models/config.yml`;
}

/** Validates the YAML with the gateway's own code (one validator, one set of rules). */
async function readConfig($: EngineInterface, path: string): Promise<{ ok: true; config: ModView } | { ok: false; error: string }> {
  const cli = `${$.plugin.root}/../gateway/src/cli.ts`;
  const bun = (await $.env.get("SUBAGENT_MODELS_BUN")) || "bun";
  let r;
  try {
    r = await $.process.run([bun, cli, "mod-config", "--config", path], { timeoutMs: 60_000 });
  } catch {
    r = await $.process.run(["sh", "-lc", 'exec bun "$0" mod-config --config "$1"', cli, path], { timeoutMs: 60_000 });
  }
  try { return JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); }
  catch { return { ok: false, error: `cannot run ${cli} (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}` }; }
}

/** One string for the modification times of every file the config is built from. */
async function stampOf($: EngineInterface, paths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const p of paths) {
    let m = -1;
    try { m = (await $.fs.stat(p)).mtimeMs; } catch {}
    parts.push(`${p}@${m}`);
  }
  return parts.join("|");
}

let stamp = "";
let warned = new Set<string>();

async function refresh($: EngineInterface, { force = false } = {}) {
  let r: Awaited<ReturnType<typeof readConfig>>;
  let path = "";
  if (remote) {
    r = await readRemote($, remote);
    // Unchanged since the last poll: nothing to register again.
    if (r.ok && !force && view && JSON.stringify(r.config) === JSON.stringify(view)) return;
  } else {
    path = await configPath($);
    // Our file, plus every omp file the last good config was built from.
    const paths = view && view.path === path ? [path, ...(view.sources ?? []).filter(p => p !== path)] : [path];
    const now = await stampOf($, paths);
    if (!force && now === stamp) return;
    stamp = now;
    r = await readConfig($, path);
  }
  if (!r.ok) {
    if (r.error !== configError) $.ui.log(`subagent-models: ${r.error}${view ? " (keeping the previous config)" : ""}`);
    configError = r.error;
    if (!view) {
      // No good config this session yet: fall back to the last one that worked, so
      // its model ids still route (and fail loudly) instead of reaching Anthropic.
      const saved = (await $.store.get("lastGoodConfig").catch(() => undefined)) as ModView | undefined;
      if (saved) view = saved;
    }
    return;
  }
  configError = null;
  view = r.config;
  if (!remote) stamp = await stampOf($, [path, ...(view.sources ?? []).filter(p => p !== path)]);
  await $.store.set("lastGoodConfig", view).catch(() => {});
  for (const w of view.warnings ?? []) if (!warned.has(w)) { warned.add(w); $.ui.log(`subagent-models: ${w}`); }
  for (const a of view.agents) {
    try {
      await $.agent.register(agentSpec(a, view) as Parameters<EngineInterface["agent"]["register"]>[0]);
    } catch (e) {
      $.ui.log(`subagent-models: agent ${a.name} not registered: ${(e as Error).message}`);
    }
  }
}

export const register: Register = on => {
  on("session.start", async ($, e, next) => {
    try {
      remote = remoteFrom({
        url: await $.env.get("SUBAGENT_MODELS_URL"),
        accessId: await $.env.get("SUBAGENT_MODELS_ACCESS_ID"),
        accessSecret: await $.env.get("SUBAGENT_MODELS_ACCESS_SECRET"),
      });
    } catch (err) { $.ui.log(`subagent-models: ${(err as Error).message}`); }
    await refresh($, { force: true }).catch(err => $.ui.log(`subagent-models: ${(err as Error).message}`));
    // A local file is a cheap stat; a remote gateway is a request, so poll it less often.
    $.clock.every(remote ? 30_000 : 3000, () => { refresh($).catch(() => {}); });
    return next(e);
  });

  // An agent removed from the YAML stays registered until the session reloads the
  // mod; it is hidden from the model in the meantime.
  on("agent.offer", async ($, e, next) => {
    if (!e.agent.startsWith(`${$.plugin.name}:`) || !view) return next(e);
    const name = e.agent.slice($.plugin.name.length + 1);
    return view.agents.some(a => a.name === name) ? next(e) : { isOffered: false };
  });

  on("http.fetch", async ($, e, next) => {
    if (next.origin?.plugin !== "engine" || !view) return next(e);
    return routeFetch(e, view, x => next(x), msg => $.ui.log(msg), remote);
  }).catch(($, e, next) => {
    // The hook failed. A request of ours must not slip through to Anthropic as is.
    if (next.called) return next(e);
    const body = e.init?.body;
    const ours = view && typeof body === "string" && messagesPath(e.url) && routedModel(body, view);
    return ours ? errorValue(503, `subagent-models: the routing hook failed for ${ours}; nothing was sent to Claude. Run claude --debug for the reason`) : next(e);
  });
};
