import { describe, expect, test } from "bun:test";
import { makeSignature, normalize, portableSchema, readSignature, withIdentity } from "../src/canonical";
import { OpenAIStream, ToolNames, mapUsage, toOpenAI } from "../src/openai";
import { toAnthropic } from "../src/anthropic";
import { identityLine } from "../src/chain";
import { ROUTED, engineRequest, testConfig } from "./fixtures";

const cfg = testConfig();
const modelA = cfg.models["fake/model-a"]!;

describe("normalize (engine request -> canonical)", () => {
  const c = normalize(engineRequest());
  test("drops the attribution block and first-party fields", () => {
    expect(c.system.map(b => b.text)).toEqual(["You are a Claude agent, built on Anthropic's Claude Agent SDK.", "You are a worker.\n\nNotes."]);
    expect(c.dropped).toEqual(expect.arrayContaining(["attribution block", "server tool web_search_20250305", "context_management", "thread", "diagnostics", "metadata"]));
  });
  test("tools: tool_addition added, placeholder and server tools dropped, deferred loaded only when referenced", () => {
    expect(c.tools.map(t => t.name)).toEqual(["Read", "ToolSearch", "mcp__srv__added", "mcp__srv__deferred_one"]);
    const unref = normalize(engineRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(unref.tools.map(t => t.name)).toEqual(["Read", "ToolSearch"]);
  });
  test("thinking blocks keep their origin", () => {
    const a = c.messages[2] as any;
    expect(a.content[0]).toEqual({ type: "thinking", thinking: "I will read both.", origin: ROUTED, upstreamSignature: null });
    expect((c.messages[4] as any).content[0].origin).toBe(null);
  });
  test("level from output_config.effort, thinking budget, or off", () => {
    expect(c.level).toBe("high");
    expect(normalize(engineRequest({ output_config: undefined, thinking: { type: "enabled", budget_tokens: 4000 } })).level).toBe("medium");
    expect(normalize(engineRequest({ output_config: undefined, thinking: undefined })).level).toBe("off");
    expect(normalize(engineRequest({ output_config: undefined })).level).toBe(null);
  });
  test("identity line and harness line rewritten", () => {
    const w = withIdentity(c, identityLine(modelA));
    expect(w.system[0]!.text).toBe("You are an agent running in Claude Code, Anthropic's agent harness.");
    const first = (w.messages[0] as any).content[0].text as string;
    expect(first).toContain("You are powered by the model Model A (model-a, served by fake). You are not a Claude model;");
    expect(first).not.toContain("fake/model-a.");
  });
  test("signature round trip", () => {
    expect(readSignature(makeSignature("p/m", "abc"))).toEqual({ origin: "p/m", upstreamSignature: "abc" });
    expect(readSignature("EqQB...")).toBe(null);
  });
});

describe("toOpenAI", () => {
  const names = new ToolNames();
  const body = toOpenAI(normalize(engineRequest()), modelA, "high", names) as any;
  test("golden message list", () => {
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user", "assistant", "tool"]);
    expect(body.messages[0].content).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nYou are a worker.\n\nNotes.");
    // the mid-conversation system entry merges into the first user turn as a reminder
    expect(body.messages[1].content).toContain("Read /x/a.txt and /x/b.png\n\n<system-reminder>\nThe following tools just became available:");
    expect(body.messages[2]).toEqual({
      role: "assistant", content: "Reading.", reasoning_content: "I will read both.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"/x/a.txt"}' } },
        { id: "call_2", type: "function", function: { name: "Read", arguments: '{"file_path":"/x/b.png"}' } },
      ],
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "hello" });
    expect(body.messages[4]).toEqual({ role: "tool", tool_call_id: "call_2", content: "an image" });
    // tool-result images follow the tool messages as a user turn, then the turn's own text
    expect(body.messages[5].content).toEqual([
      { type: "text", text: "[image returned by tool call call_2]" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "text", text: "<system-reminder>todo reminder</system-reminder>" },
    ]);
    // Claude's own (empty) thinking is not echoed
    expect(body.messages[6]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_3", type: "function", function: { name: "ToolSearch", arguments: '{"query":"select:mcp__srv__deferred_one"}' } }] });
    expect(body.messages[7]).toEqual({ role: "tool", tool_call_id: "call_3", content: "Tool loaded: mcp__srv__deferred_one" });
  });
  test("request fields", () => {
    expect(body.model).toBe("model-a");
    expect(body.max_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools.map((t: any) => t.function.name)).toEqual(["Read", "ToolSearch", "mcp__srv__added", "mcp__srv__deferred_one"]);
    for (const k of ["metadata", "thread", "context_management", "thinking", "output_config", "system"]) expect(body[k]).toBeUndefined();
  });
  test("effort map: medium -> high, off -> off, non-reasoning model sends none", () => {
    expect((toOpenAI(normalize(engineRequest()), modelA, "medium", new ToolNames()) as any).reasoning_effort).toBe("high");
    expect((toOpenAI(normalize(engineRequest()), modelA, "off", new ToolNames()) as any).reasoning_effort).toBe("off");
    expect((toOpenAI(normalize(engineRequest()), cfg.models["fake/model-c"]!, "high", new ToolNames()) as any).reasoning_effort).toBeUndefined();
  });
  test("text-only model gets notes instead of images", () => {
    const b = toOpenAI(normalize(engineRequest()), cfg.models["fake/model-b"]!, "high", new ToolNames()) as any;
    expect(JSON.stringify(b)).not.toContain("image_url");
  });
  test("tool names OpenAI refuses are mapped both ways", () => {
    const n = new ToolNames();
    const long = "mcp__" + "x".repeat(80) + ".dot";
    const s = n.safe(long);
    expect(s).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(n.orig(s)).toBe(long);
  });
  test("empty content and tool choice", () => {
    const b = toOpenAI(normalize({ model: ROUTED, max_tokens: 10, messages: [{ role: "user", content: [] }, { role: "assistant", content: [] }, { role: "user", content: "go" }], tools: [{ name: "T", input_schema: { type: "object" } }], tool_choice: { type: "any", disable_parallel_tool_use: true } }), modelA, "off", new ToolNames()) as any;
    expect(b.messages).toEqual([{ role: "assistant", content: "" }, { role: "user", content: "go" }]);
    expect(b.tool_choice).toBe("required");
    expect(b.parallel_tool_calls).toBe(false);
  });
});

describe("OpenAIStream (chunks -> Anthropic events)", () => {
  const run = (chunks: any[], done = true) => {
    const s = new OpenAIStream(ROUTED, ROUTED, new ToolNames(), "reasoning_content", "msg_x");
    const evs = chunks.flatMap(c => s.push(c));
    return [...evs, ...s.end(done)];
  };
  test("reasoning, text, two parallel tool calls with streamed arguments, usage", () => {
    const evs = run([
      { choices: [{ delta: { role: "assistant", reasoning_content: "think" } }] },
      { choices: [{ delta: { reasoning_content: "ing" } }] },
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "Read", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/a"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "Bash", arguments: '{"command":"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } },
    ]);
    const types = evs.map(e => e.type + ((e as any).delta?.type ? `:${(e as any).delta.type}` : "") + ((e as any).content_block?.type ? `:${(e as any).content_block.type}` : ""));
    expect(types).toEqual([
      "message_start",
      "content_block_start:thinking", "content_block_delta:thinking_delta", "content_block_delta:thinking_delta", "content_block_delta:signature_delta", "content_block_stop",
      "content_block_start:text", "content_block_delta:text_delta", "content_block_stop",
      "content_block_start:tool_use", "content_block_delta:input_json_delta", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start:tool_use", "content_block_delta:input_json_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect((evs[0] as any).message.model).toBe(ROUTED);
    expect(readSignature((evs[4] as any).delta.signature)?.origin).toBe(ROUTED);
    expect((evs[9] as any).content_block).toEqual({ type: "tool_use", id: "call_a", name: "Read", input: {} });
    expect((evs[13] as any).index).toBe(3);
    const md = evs.at(-2) as any;
    expect(md.delta.stop_reason).toBe("tool_use");
    expect(md.usage).toEqual({ input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 });
  });
  test("stop reasons", () => {
    expect((run([{ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }]).at(-2) as any).delta.stop_reason).toBe("max_tokens");
    expect((run([{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }]).at(-2) as any).delta.stop_reason).toBe("end_turn");
    expect((run([{ choices: [{ delta: { content: "x" }, finish_reason: "content_filter" }] }]).at(-2) as any).delta.stop_reason).toBe("refusal");
  });
  test("an empty answer is still a complete message", () => {
    expect(run([{ choices: [{ delta: {}, finish_reason: "stop" }] }]).map(e => e.type)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
  test("a stream cut before finish is an error, not a short answer", () => {
    expect(() => run([{ choices: [{ delta: { content: "par" } }] }], false)).toThrow(/ended before it finished/);
  });
  test("an error chunk throws a classified error", () => {
    const s = new OpenAIStream(ROUTED, ROUTED, new ToolNames(), "reasoning_content");
    expect(() => s.push({ error: { message: "slow down", code: 429 } })).toThrow(/slow down/);
  });
  test("DeepSeek's cache-hit usage field", () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 })).toEqual({ input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
  });
});

describe("toAnthropic (third-party Anthropic-compatible)", () => {
  const ac = testConfig({ providers: { an: { api: "anthropic-messages", baseUrl: "https://a.test", apiKey: "K", compat: { thinkingMode: "budget" }, models: { "model-a": { input: ["text"], maxTokens: 64000 } } } } });
  const m = ac.models["an/model-a"]!;
  const sig = makeSignature("an/model-a", "upstream-sig");
  const req = engineRequest({ model: "an/model-a" });
  (req.messages[2] as any).content[0].signature = sig;
  const b = toAnthropic(normalize(req), m, "high") as any;
  test("strips first-party fields, keeps cache_control, converts thinking to a budget", () => {
    for (const k of ["metadata", "thread", "context_management", "diagnostics", "output_config"]) expect(b[k]).toBeUndefined();
    expect(b.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(b.system[0]).toEqual({ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: "ephemeral" } });
    expect(b.tools.map((t: any) => Object.keys(t).sort())).toEqual([["description", "input_schema", "name"], ["description", "input_schema", "name"], ["description", "input_schema", "name"], ["description", "input_schema", "name"]]);
  });
  test("own thinking goes back with the upstream signature, others' is dropped; system entries become user text", () => {
    const roles = b.messages.map((x: any) => x.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(b.messages[1].content[0]).toEqual({ type: "thinking", thinking: "I will read both.", signature: "upstream-sig" });
    expect(b.messages[3].content.map((x: any) => x.type)).toEqual(["tool_use"]);
    expect(JSON.stringify(b.messages[0])).toContain("<system-reminder>\\nThe following tools just became available");
    // images to a text-only model become notes
    expect(JSON.stringify(b)).not.toContain('"type":"image"');
  });
});

describe("portableSchema", () => {
  test("drops patterns other regex engines refuse, keeps the rest", () => {
    const schema = {
      type: "object",
      properties: {
        // a parameter NAMED pattern is not the keyword
        pattern: { type: "string", description: "glob" },
        file_paths: { type: "array", items: { type: "string", pattern: "^[^\\0]*$", maxLength: 1024 } },
        id: { type: "string", pattern: "^[0-9a-f]{32}$" },
        version: { anyOf: [{ const: "latest" }, { type: "string", pattern: "^(0|[1-9]\\d{0,3})$" }] },
        look: { type: "string", pattern: "^(?!x).*$" },
      },
    };
    const out = portableSchema(schema) as any;
    expect(out.properties.pattern).toEqual({ type: "string", description: "glob" });
    expect(out.properties.file_paths.items).toEqual({ type: "string", maxLength: 1024 });
    expect(out.properties.id.pattern).toBe("^[0-9a-f]{32}$");
    expect(out.properties.version.anyOf[1].pattern).toBe("^(0|[1-9]\\d{0,3})$");
    expect(out.properties.look).toEqual({ type: "string" });
    expect(schema.properties.file_paths.items.pattern).toBe("^[^\\0]*$");
  });
});
