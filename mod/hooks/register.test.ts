// Run with: claude plugin test mod
// The test's own hooks sit beneath the mod and stand for the engine: the network
// (http.fetch), the host (process.run: the gateway's mod-config CLI) and the disk.
import { describe, expect, test } from "claude-code/testing";
import { FALLBACK_HEADER, EFFORT_HEADER, claudeBody, routedModel, messagesPath, gatewayHeaders, agentSpec, routeFetch, type ModView } from "./route";

const SOCKET = "/run/user/1000/subagent-models/gateway.sock";
const VIEW: ModView = {
  path: "/cfg.yml",
  mtimeMs: 1,
  socket: SOCKET,
  models: { "fake/model-a": { name: "A", contextWindow: 1048576, maxTokens: 8192, input: ["text"] }, "fake/small": { name: "S", contextWindow: 131072, maxTokens: 8192, input: ["text"] } },
  claudeFallbacks: { "fake/model-a": ["claude-haiku-5-5"], "fake/small": [] },
  agents: [{ name: "worker", model: "fake/model-a", effort: "high", description: "a worker", prompt: null, extra: { maxTurns: 5 } }],
};
const URL = "https://api.anthropic.com/v1/messages?beta=true";
const SMG = "smg1." + "eyJtIjoiZmFrZS9tb2RlbC1hIn0";
const body = (model: string) => JSON.stringify({
  model, stream: true, max_tokens: 100,
  messages: [
    { role: "user", content: [{ type: "text", text: "<system-reminder>You are powered by the model fake/model-a.</system-reminder>" }, { type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: SMG }, { type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: SMG }] },
    { role: "user", content: "go on" },
  ],
});
const headers = { authorization: "[redacted]", "anthropic-beta": "x", "content-type": "application/json", "x-claude-code-agent-id": "a1" };
const ok = (h: Record<string, string> = {}) => ({ value: { status: 200, ok: true, headers: { "x-subagent-models-served-by": "fake/model-a", ...h }, text: "", isStreaming: true as const } });

async function boot($: any, on: any, sent: any[], answer: (e: any, n: number) => any) {
  on("session.start", async (_$: any, e: any) => ({ cwd: e.cwd }));
  on("ui.log", async (_$: any, e: any) => { sent.push({ log: e }); return { value: undefined }; });
  on("clock.every", async () => ({ value: undefined }));
  on("env.get", async (_$: any, e: any) => ({ value: e.name === "HOME" ? "/home/t" : undefined }));
  on("process.run", async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ok: true, config: VIEW }), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }));
  on("fs.stat", async () => ({ value: { kind: "file", size: 1, mtimeMs: 1, isLink: false } }));
  on("agent.register", async (_$: any, e: any) => { sent.push({ register: e }); return { value: { agent: `subagent-models:${e.name}` } }; });
  on("http.fetch", async (_$: any, e: any) => { sent.push(e); return answer(e, sent.filter(s => s.url).length); });
  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
}

describe("http.fetch routing (routeFetch, with send standing for next)", () => {
  const run = async (b: string, answer: (e: any, n: number) => any) => {
    const sent: any[] = [];
    const send = async (e: any) => { sent.push(e); const a = answer(e, sent.length); if (a instanceof Error) throw a; return a; };
    const r: any = await routeFetch({ url: URL, init: { method: "POST", headers, body: b, compress: "gzip" } }, VIEW, send);
    return { r, sent };
  };

  test("a Claude request goes on untouched", async () => {
    const b = body("claude-sonnet-5-5");
    const { sent } = await run(b, () => ok());
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual({ url: URL, init: { method: "POST", headers, body: b, compress: "gzip" } });
  });

  test("a routed request goes to the gateway socket, without credentials", async () => {
    const b = body("fake/model-a");
    const { r, sent } = await run(b, () => ok());
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe("http://subagent-models/v1/messages?beta=true");
    expect(sent[0].init.socketPath).toBe(SOCKET);
    expect(sent[0].init.compress).toBe(undefined);
    expect(sent[0].init.headers.authorization).toBe(undefined);
    expect(sent[0].init.headers["x-claude-code-agent-id"]).toBe("a1");
    expect(sent[0].init.body).toBe(b);
    expect(r.value.status).toBe(200);
  });

  for (const [name, answer] of [["throws", () => new Error("ENOENT")], ["is denied", () => ({ deny: "ENOENT" })], ["answers 502 itself", () => ({ value: { status: 502, ok: false, headers: {}, text: "" } })]] as const) {
    test(`the gateway that ${name} is a loud 503, never Claude`, async () => {
      const { r, sent } = await run(body("fake/model-a"), answer as any);
      expect(sent.length).toBe(1);
      expect(r.value.status).toBe(503);
      expect(r.value.headers["x-should-retry"]).toBe("false");
      expect(JSON.parse(r.value.text).error.message).toContain(SOCKET);
    });
  }

  test("a gateway error of its own passes through as the agent's error", async () => {
    const err = { value: { status: 503, ok: false, headers: { "x-should-retry": "false" }, text: "{}" } };
    const { r, sent } = await run(body("fake/model-a"), () => err);
    expect(sent.length).toBe(1);
    expect(r).toBe(err);
  });

  test("a Claude hand-back the chain names is re-sent to Anthropic with the model swapped", async () => {
    const { r, sent } = await run(body("fake/model-a"), (_e, n) => n === 1 ? { value: { status: 409, ok: false, headers: { [FALLBACK_HEADER]: "claude-haiku-5-5", [EFFORT_HEADER]: "low", "x-should-retry": "false" }, text: "" } } : ok());
    expect(sent.length).toBe(2);
    expect(sent[1].url).toBe(URL);
    expect(sent[1].init.socketPath).toBe(undefined);
    expect(sent[1].init.headers.authorization).toBe("[redacted]");
    expect(sent[1].init.compress).toBe("gzip");
    const sentBody = JSON.parse(sent[1].init.body);
    expect(sentBody.model).toBe("claude-haiku-5-5");
    expect(sentBody.output_config.effort).toBe("low");
    expect(JSON.stringify(sentBody)).not.toContain("smg1.");
    expect(sentBody.messages[0].content[0].text).toContain("You are powered by the model claude-haiku-5-5.");
    expect(sentBody.messages[2].content).toEqual([{ type: "text", text: "(no content)" }]);
    expect(r.value.status).toBe(200);
  });

  test("a Claude hand-back the chain does not name is refused", async () => {
    const { r, sent } = await run(body("fake/model-a"), () => ({ value: { status: 409, ok: false, headers: { [FALLBACK_HEADER]: "claude-opus-5-5" }, text: "" } }));
    expect(sent.length).toBe(1);
    expect(r.value.status).toBe(503);
    expect(JSON.parse(r.value.text).error.message).toContain("does not name; refused");
  });
});

describe("session start", () => {
  test("configured agents are registered as native agent types", async ($, on) => {
    const sent: any[] = [];
    await boot($, on, sent, () => ok());
    const reg = sent.filter(s => s.register).map(s => s.register);
    if (!reg.length) throw new Error(JSON.stringify(sent));
    expect(reg.length).toBe(1);
    expect(reg[0].name).toBe("worker");
    expect(reg[0].model).toBe("fake/model-a");
    expect(reg[0].effort).toBe("high");
    expect(reg[0].maxTurns).toBe(5);
    expect(reg[0].prompt).toContain("You are an agent for Claude Code");
  });
});

describe("route helpers", () => {
  test("messagesPath and routedModel", () => {
    expect(messagesPath(URL)).toBe("/v1/messages?beta=true");
    expect(messagesPath("https://api.anthropic.com/v1/messages/count_tokens?beta=true")).toBe("/v1/messages/count_tokens?beta=true");
    expect(messagesPath("https://api.anthropic.com/api/event_logging/v2/batch")).toBe(null);
    expect(routedModel(body("fake/model-a"), VIEW)).toBe("fake/model-a");
    // the id appearing inside conversation text is escaped and never matches
    expect(routedModel(JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: '"model":"fake/model-a"' }] }), VIEW)).toBe(null);
  });
  test("routing is by rule: a reported provider prefix, any model under it", () => {
    const v = { ...VIEW, providers: ["fake", "omp-prov"] };
    // a model omp resolves dynamically, with no entry in the view
    expect(routedModel(JSON.stringify({ model: "omp-prov/brand-new-9", messages: [] }), v)).toBe("omp-prov/brand-new-9");
    // a nested tool input naming a routed model does not route a Claude request
    expect(routedModel(JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "tool_use", input: { model: "fake/model-a" } }] }], model: "claude-opus-5-5" }), v)).toBe(null);
    // never anthropic/…, never an unreported provider, never a Claude-named id, never a bare Claude id
    for (const id of ["anthropic/claude-sonnet-5-5", "other/x", "fake/claude-lookalike", "claude-sonnet-5-5", "sonnet"]) expect(routedModel(JSON.stringify({ model: id }), v)).toBe(null);
  });
  test("gatewayHeaders drops credentials", () => {
    expect(gatewayHeaders({ authorization: "Bearer x", "X-Api-Key": "k", "x-c": "[redacted]", "anthropic-beta": "b" })).toEqual({ "anthropic-beta": "b" });
  });
  test("claudeBody keeps Claude's own signed thinking", () => {
    const b = JSON.parse(claudeBody(JSON.stringify({ model: "fake/model-a", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "EqRealClaudeSig" }, { type: "text", text: "x" }] }] }), "claude-haiku-5-5", null));
    expect(b.messages[0].content[0].signature).toBe("EqRealClaudeSig");
    expect(b.output_config).toBe(undefined);
  });
  test("agentSpec lowers the compaction window for a smaller model", () => {
    const s = agentSpec({ name: "s", model: "fake/small", effort: "minimal", description: "d", prompt: "p", extra: {} }, VIEW);
    expect(s.autoCompactWindow).toBe(131072);
    expect(s.effort).toBe("low");
    expect(agentSpec(VIEW.agents[0]!, VIEW).autoCompactWindow).toBe(undefined);
  });
});
