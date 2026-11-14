// omp-native mode, against a fake omp runtime (registry + transport) and fixture
// copies of omp's config.yml and agents/*.md.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ConfigError, loadConfig, parseYaml, resolve, validate } from "../src/config";
import { parseAgentFile } from "../src/omp";
import { OmpStream, classifyOmpError, toOmpContext } from "../src/omp-transport";
import { makeSignature, normalize, readSignature } from "../src/canonical";
import { Gateway, FALLBACK_HEADER } from "../src/server";
import { FakeOmp, fail, hang, msg, ok } from "./fake-omp";
import { engineRequest } from "./fixtures";

const FIX = `${import.meta.dir}/omp-fixture`;
const tmp = mkdtempSync(`${tmpdir()}/smg-omp-`);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const fake = () => new FakeOmp([
  { provider: "acme", modelId: "fast-1", name: "Acme Fast 1" },
  { provider: "acme", modelId: "slow-2", name: "Acme Slow 2", reasoning: false },
  { provider: "deepseek", modelId: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { provider: "other", modelId: "o-1" },
  { provider: "openai-codex", modelId: "gpt-x", subscription: true },
  { provider: "anthropic", modelId: "claude-sonnet-5-5" },
]);
const opts = (rt: FakeOmp) => ({ loadRuntime: async () => rt });
const omp = (over: Record<string, unknown> = {}) => ({ dir: FIX, ...over });
const problems = async (doc: unknown, rt = fake()): Promise<string[]> => {
  try { await resolve(doc, "ours.yml", 0, opts(rt)); return []; } catch (e) { if (e instanceof ConfigError) return e.problems; throw e; }
};

describe("omp block absent", () => {
  test("resolve() is validate() exactly, and no runtime is loaded", async () => {
    const example = parseYaml(readFileSync(`${import.meta.dir}/../../config.example.yml`, "utf8"), "x");
    let loaded = false;
    const b = await resolve(example, "x", 0, { loadRuntime: async () => { loaded = true; return fake(); } });
    const a = validate(example, "x");
    expect({ ...b, origins: {} }).toEqual({ ...a, origins: {} });
    expect(loaded).toBe(false);
    expect(b.ompRuntime).toBe(null);
    expect(b.sources.map(s => s.path)).toEqual(["x"]);
  });
});

describe("routing and resolution", () => {
  test("every omp provider routes except anthropic; providers: restricts", async () => {
    const c = await resolve({ omp: omp() }, "ours.yml", 0, opts(fake()));
    expect(c.ompProviders).toEqual(["acme", "deepseek", "openai-codex", "other"]);
    const r = await resolve({ omp: omp({ providers: ["acme", "nope"] }) }, "ours.yml", 0, opts(fake()));
    expect(r.ompProviders).toEqual(["acme"]);
    expect(r.warnings).toContain("omp.providers: omp has no provider nope");
  });

  test("omp's chains resolve through the registry, built-in providers included; unresolvable entries are warnings", async () => {
    const c = await resolve({ omp: omp({ providers: ["acme", "deepseek"] }) }, "ours.yml", 0, opts(fake()));
    expect(c.chains["acme/fast-1"]!.map(t => `${t.kind}:${t.ref}`)).toEqual(["omp:acme/fast-1", "omp:deepseek/deepseek-v4-flash:high", "omp:acme/slow-2:high", "claude:anthropic/claude-sonnet-5-5:medium"]);
    expect(c.warnings).toContain("omp chain acme/fast-1: entry other/o-1 does not resolve here (no such omp model, or its provider is restricted); skipped");
    expect(c.warnings).toContain("omp chain other/o-1: other/o-1 does not resolve here; chain skipped");
    expect(c.retry).toMatchObject({ maxRetries: 4, rateLimitWalksChain: false });
    expect(c.origins["chain acme/fast-1"]).toBe("omp");
  });

  test("agents: opt-in by name; a Claude-pinned omp agent is skipped", async () => {
    const c = await resolve({ omp: omp({ agents: ["worker", "probe", "ghost"] }) }, "ours.yml", 0, opts(fake()));
    expect(c.agents.map(a => a.name)).toEqual(["worker"]);
    expect(c.agents[0]).toMatchObject({ model: "acme/fast-1", effort: "high", prompt: "You are a worker subagent. Do exactly the assigned slice." });
    expect(c.warnings.join("\n")).toContain("omp agent probe: model \"anthropic/claude-sonnet-5-5:high\" does not resolve here; skipped");
    expect(c.warnings.join("\n")).toContain("ghost.md not found; skipped");
    expect(c.ompModels["acme/fast-1"]!.name).toBe("Acme Fast 1");
  });

  test("ours over omp: a chain, an agent, a retry setting; our own provider shadows omp's", async () => {
    const c = await resolve({
      omp: omp({ agents: ["worker"] }),
      retry: { maxRetries: 1, fallbackChains: { "acme/fast-1": ["deepseek/deepseek-v4-flash"] } },
      agents: { worker: { model: "acme/slow-2", description: "ours" } },
      providers: { other: { api: "openai-completions", baseUrl: "https://o.test/v1", models: { "o-1": { name: "Ours O1" } } } },
    }, "ours.yml", 0, opts(fake()));
    expect(c.chains["acme/fast-1"]!.map(t => t.ref)).toEqual(["acme/fast-1", "deepseek/deepseek-v4-flash"]);
    expect(c.agents[0]!.description).toBe("ours");
    expect(c.retry.maxRetries).toBe(1);
    expect(c.ompProviders).not.toContain("other");
    expect(c.models["other/o-1"]!.name).toBe("Ours O1");
    expect(c.origins).toMatchObject({ "chain acme/fast-1": "ours over omp", "agent worker": "ours over omp", "retry.maxRetries": "ours over omp", "provider other": "ours over omp", "model other/o-1": "ours" });
  });

  test("a compat-only provider entry is set aside with a warning; removed keys are warnings", async () => {
    const c = await resolve({ omp: omp({ models: ["x"], timeouts: false }), providers: { acme: { compat: { maxTokensField: "max_tokens" } } } }, "ours.yml", 0, opts(fake()));
    expect(c.ompProviders).toContain("acme");
    expect(c.warnings).toEqual(expect.arrayContaining([
      "omp.models is ignored: every model omp can resolve is routable; restrict with omp.providers",
      "omp.timeouts is ignored: timeouts are always this file's (omp's apply to all its providers at once)",
      "providers.acme is ignored: it defines no baseUrl or models, and omp serves acme with its own settings",
    ]));
  });

  test("errors: an unknown omp model in our own file, Claude-named ids, a bad block", async () => {
    expect((await problems({ omp: omp(), agents: { a: { model: "acme/nope", description: "d" } } }))[0]).toContain("omp resolves no such model");
    expect((await problems({ omp: omp(), agents: { a: { model: "anthropic/claude-sonnet-5-5", description: "d" } } }))[0]).toContain("no such model");
    expect(await problems({ omp: omp({ versionCheck: "loose" }) })).toContain("omp.versionCheck: must be exact or warn");
  });

  test("the runtime failing to load (SDK missing, version skew) is a config error naming the cause", async () => {
    const e = await resolve({ omp: omp() }, "ours.yml", 0, { loadRuntime: async () => { const { OmpRuntimeError } = await import("../src/omp-runtime"); throw new OmpRuntimeError("omp: the installed omp is 18.21.0 but the gateway's omp SDK is 18.20.0"); } }).catch(x => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.problems[0]).toContain("18.21.0");
  });
});

describe("transport translation", () => {
  const model = fake().find("acme", "fast-1")!;
  test("canonical -> pi-ai Context: system, tool results with names, images, own thinking signature back", () => {
    const req = engineRequest({ model: "acme/fast-1" });
    (req.messages[2] as any).content[0].signature = makeSignature("acme/fast-1", "sig-up");
    const ctx = toOmpContext(normalize(req), model);
    expect(ctx.systemPrompt).toEqual(["You are a Claude agent, built on Anthropic's Claude Agent SDK.", "You are a worker.\n\nNotes."]);
    expect(ctx.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user", "assistant", "toolResult"]);
    expect(ctx.messages[1].content[0]).toEqual({ type: "thinking", thinking: "I will read both.", thinkingSignature: "sig-up" });
    expect(ctx.messages[1].content.filter((c: any) => c.type === "toolCall").map((c: any) => c.name)).toEqual(["Read", "Read"]);
    expect(ctx.messages[3]).toMatchObject({ toolCallId: "call_2", toolName: "Read", content: [{ type: "text", text: "an image" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] });
    expect(ctx.tools.map(t => t.name)).toEqual(["Read", "ToolSearch", "mcp__srv__added", "mcp__srv__deferred_one"]);
  });

  test("events -> Anthropic: thinking with our signature, text, interleaved parallel tool calls as whole blocks, usage", () => {
    const s = new OmpStream("acme/fast-1", "acme/fast-1", "msg_x");
    const evs = [
      { type: "start" }, { type: "thinking_delta", contentIndex: 0, delta: "t" },
      { type: "thinking_end", contentIndex: 0, content: "t", partial: { content: [{ type: "thinking", thinkingSignature: "s1" }] } },
      { type: "text_delta", contentIndex: 1, delta: "ok" },
      { type: "toolcall_start", contentIndex: 2 }, { type: "toolcall_delta", contentIndex: 2, delta: "{" },
      { type: "toolcall_start", contentIndex: 3 }, { type: "toolcall_delta", contentIndex: 3, delta: "{" },
      { type: "toolcall_end", contentIndex: 2, toolCall: { id: "c1", name: "Read", arguments: { a: 1 } } },
      { type: "toolcall_end", contentIndex: 3, toolCall: { id: "c2", name: "Bash", arguments: { b: 2 } } },
      { type: "done", reason: "toolUse", message: msg() },
    ].flatMap(e => s.push(e as any));
    expect(evs.map(e => e.type + ((e as any).delta?.type ? `:${(e as any).delta.type}` : ""))).toEqual([
      "message_start", "content_block_start", "content_block_delta:thinking_delta", "content_block_delta:signature_delta", "content_block_stop",
      "content_block_start", "content_block_delta:text_delta", "content_block_stop",
      "content_block_start", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start", "content_block_delta:input_json_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(readSignature((evs[3] as any).delta.signature)).toEqual({ origin: "acme/fast-1", upstreamSignature: "s1" });
    expect((evs.at(-2) as any)).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4 } });
  });

  test("errors classify by status and wording", () => {
    expect(classifyOmpError({ errorStatus: 429 })).toBe("rate_limit");
    expect(classifyOmpError({ errorStatus: 401 })).toBe("auth");
    expect(classifyOmpError({ errorMessage: "No API key found for \"x\"" })).toBe("auth");
    expect(classifyOmpError({ errorStatus: 400, errorMessage: "maximum context length is 8192 tokens" })).toBe("context_length");
    expect(classifyOmpError({ errorStatus: 503 })).toBe("server");
    expect(classifyOmpError({ errorMessage: "fetch failed" })).toBe("server");
  });
});

describe("gateway through the omp transport", () => {
  const gwFor = async (rt: FakeOmp, doc: Record<string, unknown>) => new Gateway(await resolve({ gateway: { accessLog: "/dev/null" }, retry: { maxRetries: 0, baseDelayMs: 1 }, timeouts: { streamFirstEventTimeoutSeconds: 1, streamIdleTimeoutSeconds: 1 }, ...doc }, "ours.yml", 0, opts(rt)), { sleep: async () => {} });
  const call = (g: Gateway, model: string, signal?: AbortSignal) => g.fetch(new Request("http://gw/v1/messages", { method: "POST", signal, body: JSON.stringify({ model, stream: true, max_tokens: 100, output_config: { effort: "medium" }, messages: [{ role: "user", content: "You are powered by the model x.\nhi" }] }) }));
  const text = async (r: Response) => (await r.text()).split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6))).filter(e => e.delta?.type === "text_delta").map(e => e.delta.text).join("");

  test("any omp model routes with no configuration, at the request's level, with omp's model name in the identity line", async () => {
    const rt = fake();
    const g = await gwFor(rt, { omp: omp({ fallbackChains: false }) });
    const r = await call(g, "other/o-1");
    expect(r.status).toBe(200);
    expect(await text(r)).toBe("hello from other/o-1");
    expect(rt.calls[0]!.o).toMatchObject({ reasoning: "medium", disableReasoning: false });
    expect(JSON.stringify(rt.calls[0]!.ctx.messages[0])).toContain("You are powered by the model o-1 (o-1, served by other)");
  });

  test("a failed primary falls back to omp's built-in provider, then hands back to Claude", async () => {
    const rt = fake();
    rt.script("acme/fast-1", fail(503, "upstream overloaded"));
    const g = await gwFor(rt, { omp: omp({ providers: ["acme", "deepseek"] }) });
    const r = await call(g, "acme/fast-1");
    expect(await text(r)).toBe("hello from deepseek/deepseek-v4-flash");
    expect(rt.calls.map(c => c.id)).toEqual(["acme/fast-1", "deepseek/deepseek-v4-flash"]);
    expect(rt.calls[1]!.o.reasoning).toBe("high");
    rt.script("deepseek/deepseek-v4-flash", fail(429, "slow down"));
    rt.script("acme/slow-2", fail(500, "boom"));
    g.cooldowns.set("acme/fast-1", 60_000, "test");
    const h = await call(g, "acme/fast-1");
    expect(h.status).toBe(409);
    expect(h.headers.get(FALLBACK_HEADER)).toBe("claude-sonnet-5-5");
  });

  test("a first-event timeout aborts the omp call and walks on; an unknown id is a 404", async () => {
    const rt = fake();
    rt.script("acme/fast-1", hang);
    const g = await gwFor(rt, { omp: omp({ fallbackChains: false }), retry: { maxRetries: 0, fallbackChains: { "acme/fast-1": ["other/o-1"] } } });
    const r = await call(g, "acme/fast-1");
    expect(await text(r)).toBe("hello from other/o-1");
    expect(rt.calls[0]!.o.signal.aborted).toBe(true);
    expect((await call(g, "acme/nope")).status).toBe(404);
    expect((await call(g, "anthropic/claude-sonnet-5-5")).status).toBe(404);
  });

  test("a client abort aborts the omp call", async () => {
    const rt = fake();
    rt.script("acme/fast-1", (_c, o) => (async function* () { yield { type: "text_delta", contentIndex: 0, delta: "part" } as any; await new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))); })());
    const g = await gwFor(rt, { omp: omp({ fallbackChains: false }), timeouts: { streamIdleTimeoutSeconds: 30 } });
    const ac = new AbortController();
    const r = await call(g, "acme/fast-1", ac.signal);
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});
    await Bun.sleep(50);
    expect(rt.calls[0]!.o.signal.aborted).toBe(true);
  });
});

describe("files", () => {
  test("agent frontmatter parsing", () => {
    expect(parseAgentFile("---\nname: a\nmodel: x/y\n---\nbody\n", "a.md")).toEqual({ front: { name: "a", model: "x/y" }, body: "body" });
    expect(() => parseAgentFile("no frontmatter", "a.md")).toThrow(/no --- frontmatter/);
  });
  test("a missing or broken omp config.yml is an error; sources list omp's files for reload", async () => {
    expect((await problems({ omp: omp({ dir: `${tmp}/nowhere` }) }))[0]).toMatch(/^omp: cannot read .*nowhere\/config.yml/);
    const d = mkdtempSync(`${tmp}/d-`);
    cpSync(FIX, d, { recursive: true });
    writeFileSync(`${d}/ours.yml`, `omp:\n  dir: ${d}\n  agents: [worker]\n`);
    const c = await loadConfig(`${d}/ours.yml`, opts(fake()));
    expect(c.sources.map(s => s.path)).toEqual([`${d}/ours.yml`, `${d}/config.yml`, `${d}/agents/worker.md`]);
    writeFileSync(`${d}/config.yml`, "retry: [broken\n");
    expect((await problems({ omp: omp({ dir: d }) }))[0]).toContain(`cannot read ${d}/config.yml`);
  });
  test("the gateway reloads when an omp file changes, and keeps the last good config when one breaks", async () => {
    const d = mkdtempSync(`${tmp}/hr-`);
    cpSync(FIX, d, { recursive: true });
    writeFileSync(`${d}/ours.yml`, `gateway: { accessLog: /dev/null }\nomp:\n  dir: ${d}\n  agents: [worker]\n`);
    const rt = fake();
    const gw = new Gateway(await loadConfig(`${d}/ours.yml`, opts(rt)));
    gw.loadOpts = opts(rt);
    gw.watch(30);
    try {
      await Bun.sleep(20);
      writeFileSync(`${d}/agents/worker.md`, readFileSync(`${d}/agents/worker.md`, "utf8").replace("General worker pinned to Acme Fast 1.", "Changed in omp."));
      await Bun.sleep(200);
      expect(gw.cfg.agents[0]!.description).toBe("Changed in omp.");
      writeFileSync(`${d}/config.yml`, "retry: [broken\n");
      await Bun.sleep(200);
      expect(gw.cfg.agents[0]!.description).toBe("Changed in omp.");
      expect(((await (await gw.fetch(new Request("http://gw/health"))).json()) as any).reloadError).toContain("cannot read");
    } finally { gw.stop(); }
  });
});
