// Run with: claude plugin test mod
// The pane and the sign-in, against a fake hosted gateway: the test's hooks stand
// for the engine beneath the mod (the network, the disk, the clock, the store).
import { describe, expect, mock, test } from "claude-code/testing";

const HOSTED = "https://llm-gateway.execution.associates";
const PANE = {
  plugin: "subagent-models",
  component: "Pane",
  requestId: "subagent-models",
  props: { title: "Subagent models", isFocused: true, bodyColumns: 60, placement: "dock", scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const;
const VIEW = {
  path: "", mtimeMs: 0, socket: "", providers: ["openrouter"], claudeFallbacks: {}, sources: [], warnings: [],
  models: { "openrouter/moonshotai/kimi-k2": { name: "Kimi", contextWindow: 262144, maxTokens: 32000, input: ["text"] } },
  agents: [{ name: "worker", model: "openrouter/moonshotai/kimi-k2", effort: null, description: "a worker", prompt: null, extra: {} }],
};
const PROVIDERS = [{ id: "p1", name: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", keyLast4: "abcd", models: [{ id: "openrouter/moonshotai/kimi-k2", key: "moonshotai/kimi-k2", name: "Kimi", contextWindow: 262144, maxTokens: 32000 }] }];
const AGENTS = [{ id: "a1", name: "worker", model: "openrouter/moonshotai/kimi-k2", effort: null, description: "a worker", prompt: null }];

type Sent = { url: string; method: string; headers: Record<string, string>; body?: string };
const reply = (status: number, j: unknown) => ({ value: { status, ok: status < 300, headers: { "content-type": "application/json" }, text: JSON.stringify(j) } });

/** The engine beneath the mod, with the hosted gateway at the other end of http.fetch. */
function world(on: any, { approveAfter = 1, store = {} as Record<string, unknown> } = {}) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const registered: string[] = [];
  const status: (string | undefined)[] = [];
  let polls = 0;
  let agents = [...AGENTS];
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.store(on, store);
  on("session.start", async (_$: any, e: any) => ({ cwd: e.cwd }));
  on("env.get", async (_$: any, e: any) => ({ value: e.name === "HOME" ? "/home/t" : e.name === "HOSTNAME" ? "laptop" : undefined }));
  on("fs.stat", async () => ({ deny: "ENOENT" }));
  on("command.register", async () => ({ value: { command: "subagent-models" } }));
  on("ui.open", async () => ({ value: { isPlaced: true } }));
  on("ui.log", async (_$: any, e: any) => { logs.push(JSON.stringify(e)); return { value: undefined }; });
  on("ui.status", async (_$: any, e: any) => { status.push(e?.text); return { value: undefined }; });
  on("ui.toast", async () => ({ value: undefined }));
  on("agent.register", async (_$: any, e: any) => { registered.push(e.name); return { value: { agent: `subagent-models:${e.name}` } }; });
  on("http.fetch", async (_$: any, e: any) => {
    const s: Sent = { url: e.url, method: e.init?.method ?? "GET", headers: e.init?.headers ?? {}, body: e.init?.body };
    sent.push(s);
    const path = s.url.replace(HOSTED, "");
    const authed = s.headers.authorization === "Bearer smk_new" || s.headers.authorization === "Bearer smk_saved";
    if (path === "/api/device/code") return reply(200, { device_code: "smd_1", user_code: "ABCD-EFGH", verification_uri: `${HOSTED}/device`, verification_uri_complete: `${HOSTED}/device?code=ABCD-EFGH`, expires_in: 900, interval: 2 });
    if (path === "/api/device/token") return ++polls > approveAfter ? reply(200, { api_key: "smk_new", email: "me@example.test" }) : reply(400, { error: "authorization_pending" });
    if (!authed) return reply(401, { error: "unknown key" });
    if (path === "/mod-config") return reply(200, { ok: true, config: VIEW });
    if (path === "/api/providers" && s.method === "GET") return reply(200, PROVIDERS);
    if (path === "/api/agents" && s.method === "GET") return reply(200, agents);
    if (path === "/api/chains" && s.method === "GET") return reply(200, []);
    if (path === "/api/agents" && s.method === "POST") {
      const b = JSON.parse(s.body!);
      agents = [...agents, { id: "a2", ...b }];
      return reply(201, { id: "a2", ...b });
    }
    if (path === "/api/keys/current") return reply(200, { ok: true });
    return reply(404, { error: "not_found" });
  });
  return { sent, logs, registered, status, clock };
}

describe("signing in", () => {
  test("a new install is signed out: nothing routes, the status line and the pane say how", async ($, on) => {
    const w = world(on);
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    expect(w.sent.length).toBe(0);
    expect(w.status.at(-1)).toContain("/subagent-models");
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
    expect(await ui.find({ key: "sign-in" })).toBeTruthy();
    await ui.unmount();
  });

  test("the pane's device sign-in ends signed in, with the agents registered", async ($, on) => {
    const w = world(on);
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    await ui.press({ key: "sign-in" });
    await w.clock.settle();
    const start = w.sent.find(s => s.url.endsWith("/api/device/code"))!;
    expect(JSON.parse(start.body!).client_name).toBe("Claude Code on laptop");
    expect((await ui.find({ type: "Text", text: "ABCD-EFGH" }))).toBeTruthy();
    expect((await ui.find({ type: "Link" }))?.props.href).toBe(`${HOSTED}/device?code=ABCD-EFGH`);

    await w.clock.advance(2000); // pending
    await w.clock.advance(2000); // approved
    await w.clock.settle();
    expect(w.registered).toEqual(["worker"]);
    const mc = w.sent.find(s => s.url.endsWith("/mod-config"))!;
    expect(mc.headers.authorization).toBe("Bearer smk_new");
    expect(await ui.find({ type: "Text", text: /me@example\.test/ })).toBeTruthy();
    expect(await ui.find({ key: "agent:a1" })).toBeTruthy();
    await ui.unmount();
  });

  test("a saved sign-in is used at start; a revoked one signs out", async ($, on) => {
    const w = world(on, { store: { [`account:${HOSTED}`]: { key: "smk_saved", email: "me@example.test" } } });
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    expect(w.registered).toEqual(["worker"]);
    expect(w.sent.find(s => s.url.endsWith("/mod-config"))!.headers.authorization).toBe("Bearer smk_saved");
  });

  test("a revoked saved key signs out and asks again", async ($, on) => {
    const w = world(on, { store: { [`account:${HOSTED}`]: { key: "smk_gone", email: null } } });
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    expect(w.registered).toEqual([]);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
    expect(await ui.find({ key: "sign-in" })).toBeTruthy();
    expect(await ui.find({ type: "Text", text: /ended/ })).toBeTruthy();
    await ui.unmount();
  });

  test("/subagent-models login answers with the link and the code", async ($, on) => {
    world(on);
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    const r: any = await $.command.run({ command: "subagent-models", args: "login" } as any);
    expect(r.text).toContain(`${HOSTED}/device?code=ABCD-EFGH`);
    expect(r.text).toContain("ABCD-EFGH");
  });
});

describe("the pane, signed in", () => {
  test("adds an agent", async ($, on) => {
    const w = world(on, { store: { [`account:${HOSTED}`]: { key: "smk_saved", email: "me@example.test" } } });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await w.clock.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    await ui.press({ key: "add-agent" });
    await ui.input({ key: "agent-name", text: "reviewer", kind: "change" });
    await ui.select({ key: "agent-effort", value: "high" });
    await ui.press({ key: "agent-save" });
    await w.clock.settle();
    const post = w.sent.find(s => s.url.endsWith("/api/agents") && s.method === "POST")!;
    expect(JSON.parse(post.body!)).toMatchObject({ name: "reviewer", model: "openrouter/moonshotai/kimi-k2", effort: "high" });
    expect(post.headers.authorization).toBe("Bearer smk_saved");
    expect(await ui.find({ key: "agent:a2" })).toBeTruthy();
    await ui.unmount();
  });

  test("signing out revokes the key and forgets it", async ($, on) => {
    const w = world(on, { store: { [`account:${HOSTED}`]: { key: "smk_saved", email: "me@example.test" } } });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await w.clock.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    await ui.press({ key: "sign-out" });
    await w.clock.settle();
    expect(w.sent.some(s => s.url.endsWith("/api/keys/current") && s.method === "DELETE")).toBe(true);
    expect(await ui.find({ key: "sign-in" })).toBeTruthy();
    await ui.unmount();
  });
});
