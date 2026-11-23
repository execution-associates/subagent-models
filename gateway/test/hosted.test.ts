// What the hosted service relies on from the core: validate's hosted mode, literal
// keys held in memory, and the request path running with them.
import { expect, test } from "bun:test";
import { ConfigError, StaticKeys, hostedUrlProblem, handleMessages, Cooldowns, type Entry, validate } from "../src/core";
import { makeSignature, readSignature } from "../src/canonical";

const tenant = (baseUrl: string, extra: Record<string, unknown> = {}) => ({
  providers: { acme: { api: "openai-completions", baseUrl, apiKey: "sk-live-literal-key-123", models: { "fast-1": { name: "Fast" } } } },
  agents: { quick: { model: "acme/fast-1", description: "a quick one" } },
  ...extra,
});

test("hosted validate takes literal keys and has no socket, log or capture", () => {
  const c = validate(tenant("https://api.acme.example/v1"), "user u1", 0, undefined, { hosted: true });
  expect(c.providers.acme!.apiKey).toBe("sk-live-literal-key-123");
  expect(c.gateway.socket).toBe("");
  expect(c.gateway.accessLog).toBe("");
  expect(c.gateway.captureDir).toBe(null);
  expect(c.agents.map(a => a.name)).toEqual(["quick"]);
});

test("the Bun gateway still refuses literal keys", () => {
  expect(() => validate(tenant("https://api.acme.example/v1"))).toThrow(/looks like a literal key/);
});

test("hosted validate refuses private, plain-http and IP base URLs, and the Bun-only blocks", () => {
  for (const [url, why] of [
    ["http://api.acme.example/v1", "https"],
    ["https://127.0.0.1/v1", "IP address"],
    ["https://[::1]/v1", "IP address"],
    ["https://localhost:8080/v1", "public host"],
    ["https://gpu.internal/v1", "public host"],
    ["https://box/v1", "public host"],
    ["https://user:pw@api.acme.example/v1", "user name"],
  ] as const) {
    expect(() => validate(tenant(url), "u", 0, undefined, { hosted: true })).toThrow(new RegExp(why));
  }
  expect(() => validate(tenant("https://api.acme.example/v1", { omp: { dir: "~/.omp" } }), "u", 0, undefined, { hosted: true })).toThrow(/omp: not available/);
  expect(() => validate(tenant("https://api.acme.example/v1", { secrets: {} }), "u", 0, undefined, { hosted: true })).toThrow(ConfigError);
  expect(() => validate(tenant("https://api.acme.example/v1", { gateway: { socket: "/tmp/x" } }), "u", 0, undefined, { hosted: true })).toThrow(/pingIntervalSeconds/);
  expect(hostedUrlProblem("https://api.deepseek.com")).toBe(null);
  // a test's fake upstream, exempted explicitly
  expect(validate(tenant("http://127.0.0.1:9/v1"), "u", 0, undefined, { hosted: true, allowBaseUrl: u => u.startsWith("http://127.0.0.1:9") }).providers.acme!.baseUrl).toBe("http://127.0.0.1:9/v1");
});

test("StaticKeys serves keys by provider name and offers them for scrubbing", async () => {
  const k = new StaticKeys({ acme: "sk-live-literal-key-123" });
  expect(await k.get({ name: "acme" } as any)).toBe("sk-live-literal-key-123");
  expect(await k.get({ name: "other" } as any)).toBe(null);
  expect(k.known()).toEqual(["sk-live-literal-key-123"]);
});

test("thinking signatures round-trip non-ASCII text with web APIs only", () => {
  const sig = makeSignature("acme/fast-1", "sïgnàture ✓ 署名");
  expect(readSignature(sig)).toEqual({ origin: "acme/fast-1", upstreamSignature: "sïgnàture ✓ 署名" });
  expect(readSignature("smg1.!!notbase64")).toBe(null);
});

test("handleMessages runs with a literal key, and the recorded entry carries no prompt text", async () => {
  let seenAuth: string | null = null;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    seenAuth = req.headers.get("authorization");
    const enc = new TextEncoder();
    const chunk = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(chunk({ choices: [{ delta: { role: "assistant", content: "hi" } }] }));
      c.enqueue(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      c.enqueue(chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    // The fake upstream is on loopback, so build the config the Bun way and swap in literal keys.
    const cfg = validate({ providers: { acme: { api: "openai-completions", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "UNUSED_ENV", models: { "fast-1": {} } } } }, "u");
    const entries: Entry[] = [];
    const secretPrompt = "the client's secret source code";
    const res = await handleMessages(new Request("http://gw/v1/messages", { method: "POST", body: JSON.stringify({ model: "acme/fast-1", stream: true, max_tokens: 10, messages: [{ role: "user", content: secretPrompt }] }) }), {
      cfg, keys: new StaticKeys({ acme: "sk-live-literal-key-123" }), cooldowns: new Cooldowns(), record: e => entries.push(e),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi");
    expect(seenAuth).toBe("Bearer sk-live-literal-key-123");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.usage).toMatchObject({ input_tokens: 5, output_tokens: 1 });
    expect(JSON.stringify(entries)).not.toContain(secretPrompt);
    expect(JSON.stringify(entries)).not.toContain("sk-live-literal-key-123");
  } finally { upstream.stop(true); }
});
