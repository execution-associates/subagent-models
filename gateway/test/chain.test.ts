// Fallback, retry, timeout and cooldown behaviour against a scripted fake upstream.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Gateway, FALLBACK_HEADER, EFFORT_HEADER } from "../src/server";
import { testConfig } from "./fixtures";

process.env.FAKE_KEY_ENV = "fake-key-value";

type Behaviour = "ok" | "500" | "429" | "hang" | "stall" | "ctx400" | "400";
const script = new Map<string, Behaviour[]>();
const seen: { model: string; body: any; auth: string | null; aborted: boolean }[] = [];

const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const body = (await req.json()) as any;
    const rec = { model: body.model, body, auth: req.headers.get("authorization"), aborted: false };
    seen.push(rec);
    req.signal.addEventListener("abort", () => { rec.aborted = true; });
    const b = script.get(body.model)?.shift() ?? "ok";
    if (b === "500") return new Response('{"error":{"message":"boom"}}', { status: 500 });
    if (b === "429") return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "7" } });
    if (b === "ctx400") return new Response('{"error":{"message":"This model\'s maximum context length is 1000 tokens"}}', { status: 400 });
    if (b === "400") return new Response('{"error":{"message":"bad field"}}', { status: 400 });
    if (b === "hang") return new Promise<Response>(() => {});
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode(chunk({ choices: [{ delta: { role: "assistant", reasoning_content: "hmm" } }] })));
        c.enqueue(enc.encode(chunk({ choices: [{ delta: { content: `hello from ${body.model}` } }] })));
        if (b === "stall") return; // never finishes
        c.enqueue(enc.encode(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] })));
        c.enqueue(enc.encode(chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => upstream.stop(true));

const providers = {
  fake: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "FAKE_KEY_ENV",
    models: { "model-a": { name: "Model A" }, "model-b": { name: "Model B" } },
  },
};
const chains = { "fake/model-a": ["fake/model-b:low", "anthropic/claude-sonnet-5-5:medium"] };
const gw = (over: Record<string, any> = {}) => new Gateway(testConfig({ providers, retry: { fallbackChains: chains, ...(over.retry ?? {}) }, timeouts: over.timeouts }), { sleep: async () => {} });

const call = (g: Gateway, body: Record<string, unknown> = {}, signal?: AbortSignal) =>
  g.fetch(new Request("http://gw/v1/messages", { method: "POST", body: JSON.stringify({ model: "fake/model-a", stream: true, max_tokens: 100, output_config: { effort: "high" }, messages: [{ role: "user", content: "You are powered by the model fake/model-a.\nhi" }], ...body }), signal }));

async function events(r: Response) {
  const text = await r.text();
  return text.split("\n\n").filter(Boolean).map(b => {
    const ev = /^event: (.*)$/m.exec(b)?.[1];
    const data = /^data: (.*)$/m.exec(b)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

beforeEach(() => { script.clear(); seen.length = 0; });

describe("chain", () => {
  test("streams the primary; key and identity reach the upstream, credentials of the client never do", async () => {
    const r = await call(gw());
    expect(r.status).toBe(200);
    expect(r.headers.get("x-subagent-models-served-by")).toBe("fake/model-a");
    const evs = await events(r);
    expect(evs.map(e => e.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(evs[6]!.data.delta.text).toBe("hello from model-a");
    expect(evs[8]!.data.usage).toMatchObject({ input_tokens: 11, output_tokens: 3 });
    expect(seen[0]!.auth).toBe("Bearer fake-key-value");
    expect(seen[0]!.body.reasoning_effort).toBe("high");
    expect(seen[0]!.body.messages[0].content).toContain("You are powered by the model Model A (model-a, served by fake)");
  });

  test("a 5xx is retried on the same model", async () => {
    script.set("model-a", ["500"]);
    const r = await call(gw());
    expect((await events(r))[6]!.data.delta.text).toBe("hello from model-a");
    expect(seen.map(s => s.model)).toEqual(["model-a", "model-a"]);
  });

  test("persistent 5xx walks to the next model at its own level, and the failed one cools down", async () => {
    const g = gw();
    script.set("model-a", ["500", "500"]);
    const r = await call(g);
    expect(r.headers.get("x-subagent-models-served-by")).toBe("fake/model-b");
    expect((await events(r))[6]!.data.delta.text).toBe("hello from model-b");
    expect(seen.map(s => s.model)).toEqual(["model-a", "model-a", "model-b"]);
    expect(seen[2]!.body.reasoning_effort).toBe("low");
    expect(seen[2]!.body.messages[0].content).toContain("You are powered by the model Model B");
    // cooldown: the next request skips model-a
    seen.length = 0;
    await (await call(g)).text();
    expect(seen.map(s => s.model)).toEqual(["model-b"]);
    expect(g.cooldowns.list()[0]).toMatchObject({ id: "fake/model-a", why: "server" });
  });

  test("429 walks the chain at once when rateLimitWalksChain, cooling for its retry-after", async () => {
    const g = gw();
    script.set("model-a", ["429"]);
    const r = await call(g);
    expect(r.headers.get("x-subagent-models-served-by")).toBe("fake/model-b");
    await r.text();
    expect(seen.map(s => s.model)).toEqual(["model-a", "model-b"]);
    expect(g.cooldowns.list()[0]).toMatchObject({ id: "fake/model-a", secondsLeft: 7 });
  });

  test("429 is retried first when rateLimitWalksChain is false", async () => {
    script.set("model-a", ["429"]);
    const r = await call(gw({ retry: { rateLimitWalksChain: false } }));
    expect(r.headers.get("x-subagent-models-served-by")).toBe("fake/model-a");
    await r.text();
  });

  test("first-event timeout walks on and aborts the hung upstream request", async () => {
    script.set("model-a", ["hang", "hang"]);
    const t0 = Date.now();
    const r = await call(gw());
    expect(r.headers.get("x-subagent-models-served-by")).toBe("fake/model-b");
    await r.text();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    await Bun.sleep(50);
    expect(seen[0]!.aborted).toBe(true);
  });

  test("the chain lands on Claude: a hand-back, never an answer", async () => {
    script.set("model-a", ["500", "500"]);
    script.set("model-b", ["500", "500"]);
    const r = await call(gw());
    expect(r.status).toBe(409);
    expect(r.headers.get(FALLBACK_HEADER)).toBe("claude-sonnet-5-5");
    expect(r.headers.get(EFFORT_HEADER)).toBe("medium");
    expect(r.headers.get("x-should-retry")).toBe("false");
  });

  test("no Claude entry: a loud 503 naming every failure", async () => {
    script.set("model-b", ["500", "500"]);
    const g = new Gateway(testConfig({ providers, retry: { fallbackChains: { "fake/model-b": [] } } }), { sleep: async () => {} });
    const r = await call(g, { model: "fake/model-b" });
    expect(r.status).toBe(503);
    expect(r.headers.get("x-should-retry")).toBe("false");
    const j = (await r.json()) as any;
    expect(j.error.message).toContain("no model in the chain for fake/model-b answered");
    expect(j.error.message).toContain("fake/model-b: fake (model-b) answered HTTP 500: boom");
  });

  test("a context-length 400 becomes Anthropic's prompt-too-long wording (Claude Code compacts on it)", async () => {
    script.set("model-a", ["ctx400"]);
    const r = await call(gw());
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.message).toMatch(/^prompt is too long/);
    expect(seen.length).toBe(1);
  });

  test("another 400 is returned, not walked past", async () => {
    script.set("model-a", ["400"]);
    const r = await call(gw());
    expect(r.status).toBe(400);
    expect(seen.length).toBe(1);
  });

  test("a mid-stream stall ends with an overloaded error and cools the model; the retry walks on", async () => {
    const g = gw();
    script.set("model-a", ["stall"]);
    const r = await call(g);
    const evs = await events(r);
    expect(evs.at(-1)).toMatchObject({ event: "error", data: { type: "error", error: { type: "overloaded_error" } } });
    expect(evs.some(e => e.data?.delta?.text === "hello from model-a")).toBe(true);
    expect(g.cooldowns.list()[0]).toMatchObject({ id: "fake/model-a" });
    seen.length = 0;
    const again = await call(g);
    expect(again.headers.get("x-subagent-models-served-by")).toBe("fake/model-b");
    await again.text();
  });

  test("stream:false is aggregated, and a mid-response stall still walks the chain", async () => {
    script.set("model-a", ["stall"]);
    const r = await call(gw(), { stream: false });
    expect(r.status).toBe(200);
    const msg = (await r.json()) as any;
    expect(msg.content.map((b: any) => b.type)).toEqual(["thinking", "text"]);
    expect(msg.content[1].text).toBe("hello from model-b");
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage).toMatchObject({ input_tokens: 11, output_tokens: 3 });
  });

  test("a client abort aborts the upstream call", async () => {
    script.set("model-a", ["stall"]);
    const ac = new AbortController();
    const r = await call(gw({ timeouts: { streamIdleTimeoutSeconds: 30 } }), {}, ac.signal);
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});
    await Bun.sleep(100);
    expect(seen[0]!.aborted).toBe(true);
  });

  test("count_tokens is estimated locally", async () => {
    const r = await gw().fetch(new Request("http://gw/v1/messages/count_tokens", { method: "POST", body: JSON.stringify({ model: "fake/model-a", messages: [{ role: "user", content: "x".repeat(360) }] }) }));
    const n = ((await r.json()) as any).input_tokens;
    expect(n).toBeGreaterThanOrEqual(100);
    expect(n).toBeLessThan(110);
  });

  test("a message-threads request is refused with the code Claude Code recovers from", async () => {
    const r = await call(gw(), { thread: { type: "create" } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.details.error_code).toBe("thread_unsupported_request");
    expect(seen.length).toBe(0);
  });

  test("an unknown model id is a 404 naming the config", async () => {
    const r = await call(gw(), { model: "fake/nope" });
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.message).toContain("is not a configured model");
  });
});
