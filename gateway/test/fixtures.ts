// An engine request shaped like the ones Claude Code 2.1.325 sends for a subagent
// on an unrecognised model id (structure taken from a captured request; all text
// is made up).
import { validate, type Config } from "../src/config";
import { makeSignature } from "../src/canonical";

export const ROUTED = "fake/model-a";

export function engineRequest(over: Record<string, unknown> = {}) {
  return {
    model: ROUTED,
    stream: true,
    max_tokens: 32000,
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "high" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    metadata: { user_id: JSON.stringify({ device_id: "dev", account_uuid: "acct", session_id: "s" }) },
    thread: { type: "create" },
    diagnostics: { previous_message_id: null },
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.325; cc_is_subagent=true;", cache_control: null },
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "You are a worker.\n\nNotes.", cache_control: { type: "ephemeral" } },
    ],
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }, eager_input_streaming: true },
      { name: "ToolSearch", description: "Find tools", input_schema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "DeferredToolPlaceholder", description: "never call", input_schema: { type: "object", properties: {} }, defer_loading: true },
      { name: "mcp__srv__deferred_one", description: "deferred", input_schema: { type: "object", properties: {} }, defer_loading: true },
      { type: "web_search_20250305", name: "web_search" },
    ],
    messages: [
      { role: "user", content: [
        { type: "text", text: "<system-reminder>\n# Environment\n - cwd: /x\n\nYou are powered by the model fake/model-a.\n\nSkills: ...\n</system-reminder>" },
        { type: "text", text: "Read /x/a.txt and /x/b.png" },
      ] },
      { role: "system", content: [
        { type: "text", text: "The following tools just became available:\nmcp__srv__added" },
        { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "mcp__srv__added", description: "added tool", input_schema: { type: "object", properties: { q: { type: "string" } } }, eager_input_streaming: true } } },
      ] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "I will read both.", signature: makeSignature(ROUTED) },
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/x/a.txt" } },
        { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "/x/b.png" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_1", content: "hello" },
        { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "an image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
        { type: "text", text: "<system-reminder>todo reminder</system-reminder>" },
      ] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "", signature: "EqQBClaudeSignature" },
        { type: "tool_use", id: "call_3", name: "ToolSearch", input: { query: "select:mcp__srv__deferred_one" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_3", content: [{ type: "tool_reference", tool_name: "mcp__srv__deferred_one" }] },
      ] },
    ],
    ...over,
  };
}

export function testConfig(over: Record<string, any> = {}): Config {
  return validate({
    gateway: { socket: "/tmp/never-used.sock", accessLog: "/dev/null" },
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, cooldownSeconds: 60, ...(over.retry ?? {}) },
    timeouts: { streamFirstEventTimeoutSeconds: 1, streamIdleTimeoutSeconds: 1, ...(over.timeouts ?? {}) },
    providers: over.providers ?? {
      fake: {
        api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "FAKE_KEY_ENV",
        compat: { reasoningEffortMap: { off: "off", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" } },
        models: { "model-a": { name: "Model A", input: ["text", "image"], maxTokens: 8192 }, "model-b": { name: "Model B" }, "model-c": { name: "Model C", reasoning: false } },
      },
    },
  }, "test.yml");
}
