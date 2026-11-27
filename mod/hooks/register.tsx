// subagent-models: native Claude Code subagents on non-Claude models.
//
// Every model request the engine sends passes `http.fetch`. A request whose
// `model` is one of the configured ids (openrouter/moonshotai/kimi-k2, ...) is sent
// to the gateway instead of Anthropic, unchanged but for its URL and its
// credentials, which stay behind. Every other request goes on untouched. When the
// gateway's fallback chain lands on a real Claude model, it answers with a
// hand-back header and this hook re-sends the original request to Anthropic with
// that model, on the session's own login.
//
// The gateway is the hosted one unless the settings name another. The person signs
// in from the pane (/subagent-models) with a device code, and sets up providers,
// agents and fallback chains there. A gateway on this machine (`subagent-models
// install`, with its YAML config) is used instead when it is there and nothing
// names a remote one.
import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import type { Auth, Edit, PaneState } from "../types";
import {
  type Agent, type Fetch, type Gateway, EFFORTS, HOSTED_GATEWAY, PRESETS,
  call, loadGateway, matching, modelKey, parseTargets, pollDevice, startDevice,
} from "./account";
import { type ModView, type Remote, agentSpec, errorValue, messagesPath, parseRemoteConfig, remoteFrom, routeFetch, routedModel } from "./route";

const PANE = "subagent-models";
const COMMAND = "subagent-models";
const INITIAL: PaneState = { auth: { kind: "signed-out", base: HOSTED_GATEWAY }, gateway: null, busy: null, error: null, notice: null, edit: null };
const pane = atom({ plugin: "subagent-models", key: "pane" } as const, INITIAL);

/** The empty routing table: nothing routes, no agent is offered. */
const EMPTY_VIEW: ModView = { path: "", mtimeMs: 0, socket: "", models: {}, claudeFallbacks: {}, agents: [], providers: [], sources: [], warnings: [] };

let view: ModView | null = null;
let configError: string | null = null;
let remote: Remote | null = null;
/** The remote gateway's base URL, or null for the gateway on this machine. */
let base: string | null = null;
/** A key from the settings or the environment: it wins over a signed-in account. */
let fixedKey: string | null = null;
let accessHeaders: Record<string, string> = {};
let account: { key: string; email: string | null } | null = null;
/** The cloud environment adds the gateway key itself (a network secret for the gateway's host). */
let envKey = false;
let devicePoll: { cancel: () => void } | null = null;
let poller: { cancel: () => void } | null = null;

const accountKey = (b: string) => `account:${b}`;
type Account = { key: string; email: string | null };
const isAccount = (x: unknown): x is Account => typeof (x as Account | null)?.key === "string" && (x as Account).key.length > 0;

/**
 * Where a sign-in is kept: a file of the gateway's own under ~/.config, which outlives
 * the plugin's store when the plugin is updated, and the store too.
 */
async function accountFile($: EngineInterface, b: string) {
  const xdg = await $.env.get("XDG_CONFIG_HOME");
  const home = await $.env.get("HOME");
  const dir = `${xdg || `${home}/.config`}/subagent-models`;
  return { dir, path: `${dir}/account-${b.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]/g, "_")}.json` };
}

async function loadAccount($: EngineInterface, b: string): Promise<Account | null> {
  try {
    const f = await accountFile($, b);
    const saved = JSON.parse(await $.fs.read(f.path));
    if (isAccount(saved)) return saved;
  } catch {}
  const stored = await $.store.get(accountKey(b)).catch(() => undefined);
  return isAccount(stored) ? stored : null;
}

async function saveAccount($: EngineInterface, b: string, a: Account | null) {
  if (a) await $.store.set(accountKey(b), a).catch(() => {});
  else await $.store.delete(accountKey(b)).catch(() => {});
  try {
    const f = await accountFile($, b);
    const text = a ? `${JSON.stringify(a, null, 2)}\n` : "{}\n";
    try { await $.fs.write(f.path, text); }
    catch {
      await $.process.run(["mkdir", "-p", f.dir], { timeoutMs: 10_000 });
      await $.fs.write(f.path, text);
    }
  } catch {}
}
const host = (b: string) => b.replace(/^https?:\/\//, "");

function httpFetch($: EngineInterface): Fetch {
  return async (url, init) => {
    const r = await $.http.fetch(url, { method: init.method, headers: { ...accessHeaders, ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) });
    return { status: r.status, text: r.text };
  };
}

const setPane = ($: EngineInterface, fn: (s: PaneState) => PaneState) => update($, pane, fn).then(() => {}, () => {});

// ---- the gateway's routing table

async function readRemote($: EngineInterface, r: Remote) {
  try {
    const res = await $.http.fetch(`${r.base}/mod-config`, { method: "GET", headers: r.headers });
    return { ...parseRemoteConfig(r.base, res), status: res.status };
  } catch (e) {
    return { ok: false as const, status: 0, error: `the gateway at ${r.base} is not answering (${(e as Error)?.message ?? e})` };
  }
}

async function configPath($: EngineInterface): Promise<string> {
  const explicit = await $.env.get("SUBAGENT_MODELS_CONFIG");
  if (explicit) return explicit;
  const xdg = await $.env.get("XDG_CONFIG_HOME");
  const home = await $.env.get("HOME");
  return `${xdg || `${home}/.config`}/subagent-models/config.yml`;
}

const localCli = ($: EngineInterface) => `${$.plugin.root}/../gateway/src/cli.ts`;
async function exists($: EngineInterface, p: string) {
  try { await $.fs.stat(p); return true; } catch { return false; }
}

/** Validates the YAML with the gateway's own code (one validator, one set of rules). */
async function readConfig($: EngineInterface, path: string): Promise<{ ok: true; config: ModView } | { ok: false; error: string }> {
  const cli = localCli($);
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
const warned = new Set<string>();

async function refresh($: EngineInterface, { force = false } = {}) {
  let r: { ok: true; config: ModView } | { ok: false; error: string; status?: number };
  let path = "";
  if (base !== null) {
    if (!remote) return; // signed out: nothing to load
    r = await readRemote($, remote);
    if (!r.ok && r.status === 401 && account && !fixedKey) {
      await signedOut($, "Your sign-in to the gateway ended (the key was revoked). Sign in again.");
      return;
    }
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
    if (r.error !== configError) $.ui.log(`${r.error}${view ? " (keeping the previous config)" : ""}`);
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
  if (base === null) stamp = await stampOf($, [path, ...(view.sources ?? []).filter(p => p !== path)]);
  await $.store.set("lastGoodConfig", view).catch(() => {});
  for (const w of view.warnings ?? []) if (!warned.has(w)) { warned.add(w); $.ui.log(`${w}`); }
  for (const a of view.agents) {
    try {
      await $.agent.register(agentSpec(a, view) as Parameters<EngineInterface["agent"]["register"]>[0]);
    } catch (e) {
      $.ui.log(`agent ${a.name} not registered: ${(e as Error).message}`);
    }
  }
}

// ---- signing in and out

const keyInUse = () => fixedKey ?? account?.key ?? (envKey ? "" : null);
/** A gateway of one's own behind Cloudflare Access may take the Access token alone. */
const credentialed = () => keyInUse() !== null || Object.keys(accessHeaders).length > 0;

function useKey(key: string | null) {
  remote = base !== null && (key !== null || Object.keys(accessHeaders).length > 0)
    ? { base, headers: { ...accessHeaders, ...(key ? { authorization: `Bearer ${key}` } : {}) } }
    : null;
}

async function signedOut($: EngineInterface, why: string | null) {
  account = null;
  if (base !== null) await saveAccount($, base, null);
  useKey(fixedKey);
  view = EMPTY_VIEW;
  await $.store.delete("lastGoodConfig").catch(() => {});
  $.ui.status(`subagent-models: sign in with /${COMMAND}`);
  await setPane($, () => ({ ...INITIAL, auth: { kind: "signed-out", base: base ?? HOSTED_GATEWAY }, error: why }));
}

async function clientName($: EngineInterface) {
  const name = (await $.env.get("HOSTNAME").catch(() => undefined)) || "";
  return name ? `Claude Code on ${name}` : "Claude Code";
}

/** Starts a device sign-in; the poll carries on in the background. */
async function signIn($: EngineInterface): Promise<{ url: string; userCode: string } | { error: string }> {
  if (base === null) return { error: "this session uses the gateway on this machine; there is nothing to sign in to" };
  const b = base;
  devicePoll?.cancel();
  const d = await startDevice(httpFetch($), b, await clientName($));
  if ("error" in d) {
    await setPane($, s => ({ ...s, error: d.error }));
    return d;
  }
  await setPane($, s => ({ ...s, auth: { kind: "device", base: b, userCode: d.userCode, url: d.url, expiresAt: d.expiresAt }, error: null, notice: null }));
  let interval = d.intervalMs;
  const tick = async () => {
    devicePoll = null;
    if (Date.now() > d.expiresAt) {
      await setPane($, s => ({ ...s, auth: { kind: "signed-out", base: b }, error: "The sign-in code expired. Start again." }));
      return;
    }
    const p = await pollDevice(httpFetch($), b, d.deviceCode);
    if (p.kind === "pending") {
      if (p.intervalMs) interval = Math.max(interval, p.intervalMs);
      devicePoll = $.clock.after(interval, () => { void tick(); });
      return;
    }
    if (p.kind === "failed") {
      await setPane($, s => ({ ...s, auth: { kind: "signed-out", base: b }, error: p.message }));
      return;
    }
    account = { key: p.apiKey, email: p.email };
    await saveAccount($, b, account);
    useKey(keyInUse());
    $.ui.status(undefined);
    $.ui.toast(`subagent-models: signed in${p.email ? ` as ${p.email}` : ""}`);
    await setPane($, s => ({ ...s, auth: { kind: "signed-in", base: b, email: p.email }, error: null }));
    await refresh($, { force: true }).catch(() => {});
    await reload($);
  };
  devicePoll = $.clock.after(interval, () => { void tick(); });
  return { url: d.url, userCode: d.userCode };
}

async function signOut($: EngineInterface) {
  devicePoll?.cancel();
  devicePoll = null;
  if (account && base !== null) await call(httpFetch($), base, account.key, "DELETE", "/keys/current").catch(() => {});
  await signedOut($, null);
  if (credentialed()) await setPane($, s => ({ ...s, auth: { kind: "key", base: base!, via: fixedKey || Object.keys(accessHeaders).length ? "settings" : "environment" } }));
}

// ---- the gateway's configuration, for the pane

async function reload($: EngineInterface) {
  const key = keyInUse();
  if (base === null || key === null) return;
  const r = await loadGateway(httpFetch($), base, key);
  if (!r.ok) {
    if (r.status === 401 && account && !fixedKey) return signedOut($, "Your sign-in to the gateway ended. Sign in again.");
    await setPane($, s => ({ ...s, error: r.error }));
    return;
  }
  await setPane($, s => ({ ...s, gateway: r.data }));
}

/** One change through the API: busy while it runs, then the pane and the routing table reloaded. */
async function change($: EngineInterface, what: string, method: string, path: string, body: unknown, after?: (data: any) => Edit) {
  const key = keyInUse();
  if (base === null || key === null) return;
  await setPane($, s => ({ ...s, busy: what, error: null, notice: null }));
  const r = await call<any>(httpFetch($), base, key, method, path, body);
  if (!r.ok) {
    await setPane($, s => ({ ...s, busy: null, error: r.error }));
    return;
  }
  await reload($);
  await refresh($, { force: true }).catch(() => {});
  await setPane($, s => ({ ...s, busy: null, edit: after ? after(r.data) : null, notice: `${what}: done` }));
}

const allModels = (g: Gateway | null) => (g?.providers ?? []).flatMap(p => p.models.map(m => m.id));

function newAgent(g: Gateway | null, model?: string): Edit {
  const m = model ?? allModels(g)[0] ?? "";
  const taken = new Set((g?.agents ?? []).map(a => a.name));
  let name = "worker";
  for (let i = 2; taken.has(name); i++) name = `worker-${i}`;
  return {
    kind: "agent", id: null, name, model: m, effort: "",
    description: `A general-purpose worker on ${m || "another model"}: hand it self-contained tasks (research, code changes, analysis) with everything it needs in the prompt.`,
    prompt: "",
  };
}

function editAgent(a: Agent): Edit {
  return { kind: "agent", id: a.id, name: a.name, model: a.model, effort: a.effort ?? "", description: a.description, prompt: a.prompt ?? "" };
}

async function saveAgent($: EngineInterface, d: Extract<Edit, { kind: "agent" }>) {
  const body = { name: d.name.trim(), model: d.model, effort: d.effort || null, description: d.description.trim(), prompt: d.prompt.trim() || null };
  if (d.id) await change($, `Agent ${body.name} saved`, "PATCH", `/agents/${d.id}`, body);
  else await change($, `Agent ${body.name} added`, "POST", "/agents", body);
}

async function fetchModels($: EngineInterface, d: Extract<Edit, { kind: "provider-new" }>) {
  const key = keyInUse();
  if (base === null || key === null) return;
  await setPane($, s => ({ ...s, busy: "Fetching the models", error: null }));
  const r = await call<{ ok: boolean; models: string[]; error?: string }>(httpFetch($), base, key, "POST", "/providers/test", { api: d.api, baseUrl: d.baseUrl, apiKey: d.apiKey.trim() });
  const err = !r.ok ? r.error : r.data.ok ? null : (r.data.error ?? "the provider refused");
  await setPane($, s => ({
    ...s, busy: null, error: err,
    edit: s.edit?.kind === "provider-new" ? { ...s.edit, available: r.ok && r.data.ok ? r.data.models.sort() : s.edit.available } : s.edit,
  }));
}

async function saveProvider($: EngineInterface, d: Extract<Edit, { kind: "provider-new" }>) {
  const models = d.picked.map(id => ({ key: modelKey(id), upstreamId: id }));
  const name = d.name.trim();
  await change($, `Provider ${name} added`, "POST", "/providers", { name, api: d.api, baseUrl: d.baseUrl.trim(), apiKey: d.apiKey.trim(), models }, () => null);
  // A first provider: go straight on to a first agent on it.
  const s = await read($, pane);
  if (!s.error && s.gateway && s.gateway.agents.length === 0) {
    const first = s.gateway.providers.find(p => p.name === name)?.models[0]?.id;
    await setPane($, x => ({ ...x, edit: newAgent(x.gateway, first), notice: `Provider ${name} added. Now name an agent that uses it.` }));
  }
}

/** A cloud session's container ends with it, and a sign-in saved in it too. */
const CLOUD_HINT =
  "A cloud session forgets this sign-in when it ends. To stay signed in, create a gateway key on the site (Gateway keys) and save it in the cloud environment's settings as a network secret for llm-gateway.execution.associates (Authorization: Bearer): every session then starts signed in.";

// ---- describing where things stand, for the command's text

function statusText(s: PaneState): string {
  const a = s.auth;
  if (a.kind === "local") return `subagent-models: the gateway on this machine (${a.path}).`;
  if (a.kind === "signed-out") return `subagent-models: not signed in to ${host(a.base)}. Run /${COMMAND} login.`;
  if (a.kind === "device") return `subagent-models: waiting for you to approve code ${a.userCode} at ${a.url}`;
  const who = a.kind === "signed-in" ? `signed in to ${host(a.base)}${a.email ? ` as ${a.email}` : ""}`
    : a.via === "environment" ? `signed in to ${host(a.base)} through this environment's network secret`
    : `using a gateway key for ${host(a.base)}`;
  const agents = view?.agents.map(x => `subagent-models:${x.name} (${x.model})`) ?? [];
  return `subagent-models: ${who}. ${agents.length ? `Agents: ${agents.join(", ")}.` : `No agents yet: open /${COMMAND} to add a provider and an agent.`}`;
}

// ---- the hooks

export const register: Register = (on, options) => {
  // The plugin's settings (userConfig in plugin.json, set in /config); the environment wins.
  const setting = (k: string) => (typeof options?.[k] === "string" && (options[k] as string).trim() ? (options[k] as string).trim() : undefined);

  on("session.start", async ($, e, next) => {
    try {
      const url = (await $.env.get("SUBAGENT_MODELS_URL")) || setting("gatewayUrl");
      fixedKey = (await $.env.get("SUBAGENT_MODELS_API_KEY")) || setting("apiKey") || null;
      const id = await $.env.get("SUBAGENT_MODELS_ACCESS_ID");
      const secret = await $.env.get("SUBAGENT_MODELS_ACCESS_SECRET");
      accessHeaders = id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
      // A gateway installed beside the mod, with its config file, and no remote one named: that one.
      const path = await configPath($);
      const local = !url && await exists($, localCli($)) && await exists($, path);
      base = local ? null : (remoteFrom({ url: url || HOSTED_GATEWAY })!.base);
      if (base === null) {
        remote = null;
        await setPane($, s => ({ ...s, auth: { kind: "local", path } }));
      } else {
        const b = base;
        account = await loadAccount($, b);
        // Nothing of our own: a cloud environment may add the key to each request itself.
        envKey = false;
        if (!fixedKey && !account && !Object.keys(accessHeaders).length) envKey = (await readRemote($, { base: b, headers: {} })).ok;
        useKey(keyInUse());
        const auth: Auth = fixedKey || Object.keys(accessHeaders).length ? { kind: "key", base: b, via: "settings" }
          : account ? { kind: "signed-in", base: b, email: account.email }
          : envKey ? { kind: "key", base: b, via: "environment" }
          : { kind: "signed-out", base: b };
        const cloud = Boolean(await $.env.get("CLAUDE_CODE_REMOTE"));
        await setPane($, s => ({ ...s, auth, cloud, error: null, busy: null }));
      }
    } catch (err) { $.ui.log(`${(err as Error).message}`); }

    await $.command.register({ name: COMMAND, description: "Subagents on other models: sign in, set up providers, agents and fallback chains" }).catch(() => {});

    if (base !== null && !credentialed()) {
      view = EMPTY_VIEW;
      $.ui.status(`subagent-models: sign in with /${COMMAND}`);
      // Newly installed: show the pane once, unasked; after that the status line says how.
      if (!(await $.store.get("introduced").catch(() => true))) {
        await $.store.set("introduced", true).catch(() => {});
        void $.ui.open({ id: PANE, title: "Subagent models" }).catch(() => {});
      }
    } else {
      await refresh($, { force: true }).catch(err => $.ui.log(`${(err as Error).message}`));
      void reload($).catch(() => {});
    }
    // A local file is a cheap stat; a remote gateway is a request, so poll it less often.
    poller?.cancel();
    poller = $.clock.every(base !== null ? 30_000 : 3000, () => { refresh($).catch(() => {}); });
    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($, run) => {
    const e = await read($, pane);
    const args = (run.args ?? "").trim().toLowerCase();
    if (args === "login" || args === "signin" || args === "sign-in") {
      if (e.auth.kind === "local") return { text: statusText(e) };
      const r = await signIn($);
      if ("error" in r) return { text: `subagent-models: ${r.error}` };
      void $.ui.open({ id: PANE, title: "Subagent models" }).catch(() => {});
      return { text: `To sign in, open ${r.url} and approve the code ${r.userCode}. New to the gateway? The same page creates your account. Claude Code picks the sign-in up on its own.${e.cloud ? ` ${CLOUD_HINT}` : ""}` };
    }
    if (args === "logout" || args === "signout" || args === "sign-out") {
      await signOut($);
      return { text: "subagent-models: signed out; this machine's gateway key is revoked." };
    }
    if (args === "status") return { text: statusText(e) };
    void reload($).catch(() => {});
    const { isPlaced } = await $.ui.open({ id: PANE, title: "Subagent models", focus: true }).catch(() => ({ isPlaced: false }));
    if (isPlaced) return { text: "" };
    return { text: `${statusText(e)}${e.auth.kind === "signed-out" ? "" : ` Run /${COMMAND} status, login or logout.`}` };
  });

  // An agent removed from the gateway stays registered until the session reloads the
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

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select, Link } = $.ui.resolve(e);
    const s = await read($, pane);
    const set = (fn: (x: PaneState) => PaneState) => { void update($, pane, fn); };
    const setEdit = <K extends NonNullable<Edit>["kind"]>(kind: K, patch: Partial<Extract<NonNullable<Edit>, { kind: K }>>) =>
      set(x => (x.edit?.kind === kind ? { ...x, edit: { ...x.edit, ...patch } as Edit } : x));
    const rows = e.viewport?.rows ?? 30;
    const a = s.auth;

    const messages = (
      <Box flexDirection="column">
        {s.busy && <Text dimColor>{s.busy}…</Text>}
        {s.error && <Text color="error">{s.error}</Text>}
        {!s.error && s.notice && <Text color="success">{s.notice}</Text>}
      </Box>
    );

    if (a.kind === "local") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Using the gateway on this machine.</Text>
          <Text dimColor>Providers, agents and chains are in {a.path}; edits there load within seconds.</Text>
          {configError && <Text color="error">{configError}</Text>}
          <Text dimColor>Agents: {view?.agents.map(x => `subagent-models:${x.name}`).join(", ") || "none"}</Text>
        </Box>
      );
    }

    if (a.kind === "signed-out") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Claude Code subagents on the models you choose</Text>
          <Text dimColor>Sign in to {host(a.base)} to add your providers' API keys and define agents. New here? The same link creates your account.</Text>
          <Box><Button key="sign-in" variant="primary" hotkey="s" autoFocus onPress={() => { void signIn($); }}>Sign in</Button></Box>
          {messages}
        </Box>
      );
    }

    if (a.kind === "device") {
      const mins = Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 60_000));
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Open this link and approve the code:</Text>
          <Link href={a.url} />
          <Text bold size="title" mono>{a.userCode}</Text>
          <Text dimColor>Waiting for you to approve it (the code lasts {mins} more minute{mins === 1 ? "" : "s"}).</Text>
          <Box><Button key="cancel-sign-in" onPress={() => { devicePoll?.cancel(); devicePoll = null; set(x => ({ ...x, auth: { kind: "signed-out", base: a.base } })); }}>Cancel</Button></Box>
          {messages}
        </Box>
      );
    }

    const g = s.gateway;
    const header = (
      <Box flexDirection="row" gap={2}>
        <Text dimColor>{a.kind === "signed-in" ? `${a.email ?? "Signed in"} · ${host(a.base)}` : a.via === "environment" ? `Signed in by this environment · ${host(a.base)}` : `Gateway key · ${host(a.base)}`}</Text>
        <Button key="refresh" plain hotkey="r" dimColor onPress={() => { void reload($); }}>Refresh</Button>
        {a.kind === "signed-in" && <Button key="sign-out" plain dimColor onPress={() => { void signOut($); }}>Sign out</Button>}
      </Box>
    );
    const cloudHint = s.cloud && a.kind === "signed-in" ? <Text dimColor>{CLOUD_HINT}</Text> : null;
    const back = <Button key="back" onPress={() => set(x => ({ ...x, edit: null, error: null }))}>Cancel</Button>;
    const d = s.edit;

    if (d?.kind === "agent") {
      const models = allModels(g);
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text bold>{d.id ? `Agent ${d.name}` : "New agent"}</Text>
          {!d.id && <Input key="agent-name" label="Name " value={d.name} onInput={v => setEdit("agent", { name: v })} onSubmit={v => setEdit("agent", { name: v })} />}
          {models.length
            ? <Select key="agent-model" label="Model " value={d.model || models[0]} options={models.map(m => ({ value: m }))} onSelect={v => setEdit("agent", { model: v })} />
            : <Text color="warning">Add a provider first: an agent needs one of its models.</Text>}
          <Select key="agent-effort" label="Effort " value={d.effort} options={[{ value: "", label: "the model's default" }, ...EFFORTS.map(x => ({ value: x }))]} onSelect={v => setEdit("agent", { effort: v })} />
          <Input key="agent-description" label="When to use it " rows={3} value={d.description} onInput={v => setEdit("agent", { description: v })} onSubmit={v => setEdit("agent", { description: v })} />
          <Input key="agent-prompt" label="Instructions (optional) " rows={4} placeholder="Added to the agent's system prompt" value={d.prompt} onInput={v => setEdit("agent", { prompt: v })} onSubmit={v => setEdit("agent", { prompt: v })} />
          <Box flexDirection="row" gap={1}>
            <Button key="agent-save" variant="primary" onPress={() => { void saveAgent($, d); }}>{d.id ? "Save" : "Add agent"}</Button>
            {d.id && <Button key="agent-delete" onPress={() => { void change($, `Agent ${d.name} deleted`, "DELETE", `/agents/${d.id}`, undefined); }}>Delete</Button>}
            {back}
          </Box>
          {messages}
        </Box>
      );
    }

    if (d?.kind === "provider-new") {
      const shown = d.available ? matching(d.available, d.filter, Math.max(4, Math.min(12, rows - 22))) : [];
      const preset = PRESETS.find(p => p.id === d.preset);
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text bold>Add a provider</Text>
          <Select key="provider-preset" label="Provider " value={d.preset} options={PRESETS.map(p => ({ value: p.id, label: p.label }))}
            onSelect={v => { const p = PRESETS.find(x => x.id === v)!; setEdit("provider-new", { preset: v, name: p.name, api: p.api, baseUrl: p.baseUrl, available: null, picked: [] }); }} />
          {preset?.id === "custom" ? (
            <Box flexDirection="column" gap={1}>
              <Input key="provider-name" label="Name " placeholder="lowercase, used in model ids" value={d.name} onInput={v => setEdit("provider-new", { name: v })} onSubmit={v => setEdit("provider-new", { name: v })} />
              <Select key="provider-api" label="API " value={d.api} options={[{ value: "openai-completions", label: "OpenAI chat completions" }, { value: "anthropic-messages", label: "Anthropic messages" }]} onSelect={v => setEdit("provider-new", { api: v as typeof d.api })} />
              <Input key="provider-url" label="Base URL " placeholder="https://…/v1" value={d.baseUrl} onInput={v => setEdit("provider-new", { baseUrl: v })} onSubmit={v => setEdit("provider-new", { baseUrl: v })} />
            </Box>
          ) : <Text dimColor>{d.baseUrl}</Text>}
          <Input key="provider-key" label="API key " placeholder="paste it; it is stored encrypted on the gateway" value={d.apiKey}
            onInput={v => setEdit("provider-new", { apiKey: v })} onSubmit={v => { setEdit("provider-new", { apiKey: v }); void fetchModels($, { ...d, apiKey: v }); }} />
          <Box><Button key="provider-fetch" onPress={() => { void fetchModels($, d); }}>{d.available ? "Fetch the models again" : "Check the key and list its models"}</Button></Box>
          {d.available && (
            <Box flexDirection="column">
              <Input key="provider-filter" label="Find a model " placeholder={`${d.available.length} available`} value={d.filter} onInput={v => setEdit("provider-new", { filter: v })} onSubmit={v => setEdit("provider-new", { filter: v })} />
              {shown.map(id => {
                const picked = d.picked.includes(id);
                return <Button key={`pick:${id}`} plain dimColor={!picked} onPress={() => setEdit("provider-new", { picked: picked ? d.picked.filter(x => x !== id) : [...d.picked, id] })}>{picked ? "[x]" : "[ ]"} {id}</Button>;
              })}
            </Box>
          )}
          <Input key="provider-add-model" label="Or add a model id " placeholder="as the provider names it; Enter adds it" value=""
            onSubmit={v => { const id = v.trim(); if (id && !d.picked.includes(id)) setEdit("provider-new", { picked: [...d.picked, id] }); }} />
          <Text dimColor>{d.picked.length ? `Chosen: ${d.picked.join(", ")}` : "Choose at least one model."}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="provider-save" variant="primary" onPress={() => { void saveProvider($, d); }}>Add provider</Button>
            {back}
          </Box>
          {messages}
        </Box>
      );
    }

    if (d?.kind === "provider") {
      const p = g?.providers.find(x => x.id === d.id);
      if (!p) return <Box flexDirection="column">{header}{back}</Box>;
      const patchModels = (keys: { key: string; upstreamId?: string }[], what: string) =>
        void change($, what, "PATCH", `/providers/${p.id}`, { models: keys }, () => ({ kind: "provider", id: p.id, add: "" }));
      const current = p.models.map(m => ({ key: m.key }));
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text bold>{p.name}</Text>
          <Text dimColor>{p.baseUrl} · key …{p.keyLast4}</Text>
          <Box flexDirection="column">
            {p.models.slice(0, Math.max(5, rows - 16)).map(m => (
              <Button key={`model:${m.id}`} plain dimColor onPress={() => { if (p.models.length > 1) patchModels(current.filter(x => x.key !== m.key), `Removed ${m.id}`); }}>× {m.id}</Button>
            ))}
          </Box>
          <Input key="provider-more" label="Add a model id " placeholder="Enter adds it" value={d.add} onInput={v => setEdit("provider", { add: v })}
            onSubmit={v => { const id = v.trim(); if (id) patchModels([...current, { key: modelKey(id), upstreamId: id }], `Added ${p.name}/${modelKey(id)}`); }} />
          <Input key="provider-new-key" label="Replace the API key " placeholder="Enter saves it" value=""
            onSubmit={v => { if (v.trim()) void change($, `${p.name}'s key replaced`, "PATCH", `/providers/${p.id}`, { apiKey: v.trim() }, () => ({ kind: "provider", id: p.id, add: "" })); }} />
          <Box flexDirection="row" gap={1}>
            <Button key="provider-delete" onPress={() => { void change($, `Provider ${p.name} deleted`, "DELETE", `/providers/${p.id}`, undefined); }}>Delete provider</Button>
            <Button key="back" onPress={() => set(x => ({ ...x, edit: null, error: null }))}>Back</Button>
          </Box>
          {messages}
        </Box>
      );
    }

    if (d?.kind === "chain") {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text bold>When {d.model} fails</Text>
          <Text dimColor>Try these next, in order: other models of yours, or a Claude model (anthropic/claude-sonnet-5-5), each optionally with :effort.</Text>
          <Input key="chain-targets" label="Then " rows={2} value={d.text} onInput={v => setEdit("chain", { text: v })} onSubmit={v => setEdit("chain", { text: v })} />
          <Text dimColor>Yours: {allModels(g).filter(m => m !== d.model).join(", ") || "none"}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="chain-save" variant="primary" onPress={() => {
              const targets = parseTargets(d.text);
              void (targets.length
                ? change($, `Fallbacks for ${d.model} saved`, "PUT", `/chains/${encodeURIComponent(d.model)}`, { targets })
                : change($, `Fallbacks for ${d.model} cleared`, "DELETE", `/chains/${encodeURIComponent(d.model)}`, undefined));
            }}>Save</Button>
            {back}
          </Box>
          {messages}
        </Box>
      );
    }

    // The overview.
    if (!g) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor>Loading your gateway…</Text>
          {messages}
        </Box>
      );
    }
    const used = [...new Set(g.agents.map(x => x.model))];
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="column">
          <Text bold>Providers</Text>
          {g.providers.length === 0 && <Text dimColor>None yet. Add one with an API key from OpenRouter, OpenAI, DeepSeek, Moonshot…</Text>}
          {g.providers.map(p => (
            <Button key={`provider:${p.id}`} plain onPress={() => set(x => ({ ...x, edit: { kind: "provider", id: p.id, add: "" }, error: null, notice: null }))}>
              {p.name} <Text dimColor>{p.models.length} model{p.models.length === 1 ? "" : "s"}</Text>
            </Button>
          ))}
          <Button key="add-provider" plain hotkey="p" dimColor onPress={() => {
            const p = PRESETS[0]!;
            set(x => ({ ...x, error: null, notice: null, edit: { kind: "provider-new", preset: p.id, name: p.name, api: p.api, baseUrl: p.baseUrl, apiKey: "", available: null, filter: "", picked: [] } }));
          }}>+ Add a provider</Button>
        </Box>
        {g.providers.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Agents</Text>
            {g.agents.length === 0 && <Text dimColor>None yet. An agent is a subagent type Claude can start, on one of your models.</Text>}
            {g.agents.map(x => (
              <Button key={`agent:${x.id}`} plain onPress={() => set(y => ({ ...y, edit: editAgent(x), error: null, notice: null }))}>
                {x.name} <Text dimColor>{x.model}{x.effort ? ` · ${x.effort}` : ""}</Text>
              </Button>
            ))}
            <Button key="add-agent" plain hotkey="a" dimColor onPress={() => set(y => ({ ...y, edit: newAgent(g), error: null, notice: null }))}>+ New agent</Button>
            {g.agents.length > 0 && <Text dimColor>Claude uses them as subagent-models:{g.agents[0]!.name}, or ask for one by name.</Text>}
          </Box>
        )}
        {used.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Fallbacks</Text>
            {used.map(m => {
              const t = g.chains.find(c => c.model === m)?.targets ?? [];
              return (
                <Button key={`chain:${m}`} plain onPress={() => set(y => ({ ...y, edit: { kind: "chain", model: m, text: t.join(", ") }, error: null, notice: null }))}>
                  {m} <Text dimColor>{t.length ? `→ ${t.join(" → ")}` : "→ no fallback"}</Text>
                </Button>
              );
            })}
          </Box>
        )}
        {cloudHint}
        {messages}
      </Box>
    );
  });
};
