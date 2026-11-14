import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConfigError, parseRef, parseYaml, validate } from "../src/config";

const example = readFileSync(`${import.meta.dir}/../../config.example.yml`, "utf8");
const problems = (doc: unknown): string[] => {
  try { validate(doc); return []; } catch (e) { if (e instanceof ConfigError) return e.problems; throw e; }
};
const base = () => ({
  providers: { p: { api: "openai-completions", baseUrl: "https://x.test/v1", apiKey: "P_KEY", models: { m1: {}, m2: { contextWindow: 100000 } } } },
});

describe("config", () => {
  test("the example config is valid", () => {
    const c = validate(parseYaml(example, "example"), "example");
    expect(Object.keys(c.models)).toEqual(["refuseless/deepseek-v4.1-flash-fast", "refuseless/glm-5.3-flash-abliterated"]);
    expect(c.chains["refuseless/deepseek-v4.1-flash-fast"]!.map(t => t.ref)).toEqual([
      "refuseless/deepseek-v4.1-flash-fast", "refuseless/glm-5.3-flash-abliterated:high", "anthropic/claude-sonnet-5-5:medium",
    ]);
    expect(c.agents[0]).toMatchObject({ name: "deepseek", model: "refuseless/deepseek-v4.1-flash-fast", effort: "high" });
    expect(c.models["refuseless/deepseek-v4.1-flash-fast"]!.openai.reasoningEffortMap.medium).toBe("high");
    expect(c.models["refuseless/deepseek-v4.1-flash-fast"]!.openai.reasoningEffortMap.off).toBe("off");
  });

  test("parseRef splits a level suffix only when it is a level", () => {
    expect(parseRef("a/b:high")).toEqual({ id: "a/b", level: "high" });
    expect(parseRef("a/b")).toEqual({ id: "a/b", level: null });
    expect(parseRef("a/b:v2")).toEqual({ id: "a/b:v2", level: null });
  });

  test("errors name the key path", () => {
    const d: any = base();
    d.providers.p.api = "grpc";
    d.providers.p.models.m1.contextWindow = "big";
    d.providers.p.models.m1.colour = "red";
    d.retry = { fallbackChains: { "p/m1": ["p/nope", "anthropic/gpt-4"] } };
    d.agents = { a: { model: "p/m9" } };
    const ps = problems(d);
    expect(ps).toContain("providers.p.api: must be one of openai-completions, anthropic-messages, openai-responses, got \"grpc\"");
    expect(ps).toContain("providers.p.models.m1.contextWindow: must be a number >= 1000, got \"big\"");
    expect(ps.some(p => p.startsWith("providers.p.models.m1.colour: unknown key"))).toBe(true);
    expect(ps.some(p => p.startsWith("retry.fallbackChains.p/m1[0]: p/nope: no such model"))).toBe(true);
    expect(ps.some(p => p.startsWith("retry.fallbackChains.p/m1[1]: anthropic/gpt-4: a Claude entry is"))).toBe(true);
    expect(ps.some(p => p.startsWith("agents.a.model: p/m9: no such model"))).toBe(true);
  });

  test("literal keys, the reserved provider and Claude-looking ids are refused", () => {
    const d: any = base();
    d.providers.p.apiKey = "sk-not-a-real-key-just-a-test";
    d.providers.anthropic = { api: "anthropic-messages", baseUrl: "https://a.test", models: { x: {} } };
    d.providers.p.models["claude-copy"] = {};
    const ps = problems(d);
    expect(ps.some(p => p.includes("looks like a literal key"))).toBe(true);
    expect(ps.some(p => p.startsWith("providers.anthropic: \"anthropic\" is reserved"))).toBe(true);
    expect(ps.some(p => p.includes("contains a Claude model name"))).toBe(true);
  });

  test("openai-responses is reserved but not implemented", () => {
    const d: any = base();
    d.providers.p.api = "openai-responses";
    expect(problems(d).some(p => p.includes("openai-responses is not implemented"))).toBe(true);
  });

  test("compat and timeouts inherit provider -> model", () => {
    const d: any = base();
    d.timeouts = { streamFirstEventTimeoutSeconds: 5 };
    d.providers.p.timeouts = { streamIdleTimeoutSeconds: 7 };
    d.providers.p.compat = { maxTokensField: "max_completion_tokens" };
    d.providers.p.models.m2.compat = { reasoningEffortMap: { high: "max" } };
    d.providers.p.models.m2.timeouts = { totalTimeoutSeconds: 9 };
    const c = validate(d);
    expect(c.models["p/m2"]!.timeouts).toEqual({ streamFirstEventTimeoutSeconds: 5, streamIdleTimeoutSeconds: 7, totalTimeoutSeconds: 9 });
    expect(c.models["p/m1"]!.openai.maxTokensField).toBe("max_completion_tokens");
    expect(c.models["p/m2"]!.openai.reasoningEffortMap.high).toBe("max");
    expect(c.models["p/m1"]!.openai.reasoningEffortMap.high).toBe("high");
  });

  test("bad YAML is one precise problem", () => {
    expect(() => parseYaml("a: [1, 2\n", "f.yml")).toThrow(/f.yml: 1 problem:\n  - not valid YAML/);
  });

  test("agent extra fields pass through, name/hooks refused", () => {
    const d: any = base();
    d.agents = { w: { model: "p/m1:low", description: "d", tools: ["Read"], maxTurns: 3 }, bad: { model: "p/m1", description: "d", hooks: {} } };
    expect(problems(d)).toEqual(["agents.bad.hooks: not allowed here"]);
    delete d.agents.bad;
    const c = validate(d);
    expect(c.agents[0]).toMatchObject({ model: "p/m1", effort: "low", extra: { tools: ["Read"], maxTurns: 3 } });
  });
});
