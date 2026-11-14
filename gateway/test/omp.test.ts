// omp compatibility mode: import from fixture copies of omp's three file shapes.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ConfigError, loadConfig, parseYaml, resolve, validate } from "../src/config";
import { parseAgentFile } from "../src/omp";

const FIX = `${import.meta.dir}/omp-fixture`;
const tmp = mkdtempSync(`${tmpdir()}/smg-omp-`);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const problems = (doc: unknown): string[] => {
  try { resolve(doc, "ours.yml"); return []; } catch (e) { if (e instanceof ConfigError) return e.problems; throw e; }
};
const omp = (over: Record<string, unknown> = {}) => ({ dir: FIX, providers: ["acme"], ...over });

describe("omp block absent", () => {
  test("resolve() is validate() exactly: no omp file is looked at", () => {
    const example = parseYaml(readFileSync(`${import.meta.dir}/../../config.example.yml`, "utf8"), "x");
    const a = validate(example, "x");
    const b = resolve(example, "x");
    expect({ ...b, origins: {} }).toEqual({ ...a, origins: {} });
    expect(b.omp).toBe(null);
    expect(b.sources.map(s => s.path)).toEqual(["x"]);
    expect(b.warnings).toEqual([]);
  });
});

describe("import", () => {
  const c = resolve({ omp: omp({ providers: ["acme", "other", "weird", "missing"], agents: ["worker", "probe", "ghost"] }) }, "ours.yml");

  test("providers in the allow-list and models.yml are imported, in our id scheme", () => {
    expect(Object.keys(c.models).sort()).toEqual(["acme/fast-1", "acme/slow-2", "other/o-1"]);
    const m = c.models["acme/fast-1"]!;
    expect(m).toMatchObject({ name: "Acme Fast 1", upstreamId: "fast-1", input: ["text", "image"], contextWindow: 1048576, maxTokens: 262144 });
    expect(m.openai.reasoningEffortMap.medium).toBe("high");
    expect(c.providers.acme!.apiKey).toBe("!printf placeholder-not-a-key");
    expect(c.origins["model acme/fast-1"]).toBe("omp");
  });

  test("chains: unroutable entries are skipped with a warning, Claude entries kept as the hand-back", () => {
    expect(c.chains["acme/fast-1"]!.map(t => t.ref)).toEqual(["acme/fast-1", "acme/slow-2:high", "other/o-1", "anthropic/claude-sonnet-5-5:medium"]);
    expect(c.chains["acme/fast-1"]![3]!.kind).toBe("claude");
    expect(c.warnings).toContain("omp chain acme/fast-1: entry deepseek/deepseek-v4-flash:high is not an imported model (an omp built-in provider, a provider not in omp.providers, or a model left out by omp.models); skipped");
    expect(c.retry).toMatchObject({ maxRetries: 4, rateLimitWalksChain: false });
  });

  test("skipped providers, models and agents each get a warning, never an error", () => {
    const w = c.warnings.join("\n");
    expect(w).toContain("omp provider weird: api \"openai-codex-responses\" is not one this gateway speaks; skipped");
    expect(w).toContain("omp.providers: missing is not defined in");
    expect(w).toContain("omp model acme/claude-lookalike: contains a Claude model name");
    expect(w).toContain("omp agent probe: model \"anthropic/claude-sonnet-5-5:high\" is not an imported model; skipped");
    expect(w).toContain("omp.agents:");
    expect(w).toContain("ghost.md not found; skipped");
  });

  test("agents opt-in by name: frontmatter and prompt body", () => {
    expect(c.agents.map(a => a.name)).toEqual(["worker"]);
    expect(c.agents[0]).toMatchObject({ model: "acme/fast-1", effort: "high", description: "General worker pinned to Acme Fast 1.", prompt: "You are a worker subagent. Do exactly the assigned slice." });
    expect(c.agents[0]!.extra).toEqual({});
  });

  test("timeouts are not imported by default", () => {
    expect(c.timeouts.streamFirstEventTimeoutSeconds).toBe(30);
    expect(c.models["acme/fast-1"]!.timeouts.streamIdleTimeoutSeconds).toBe(90);
  });

  test("timeouts: true imports the global ones (-1 means omp's default: left alone) and per-model compat", () => {
    const t = resolve({ omp: omp({ timeouts: true }) }, "ours.yml");
    expect(t.timeouts.streamFirstEventTimeoutSeconds).toBe(10);
    expect(t.timeouts.streamIdleTimeoutSeconds).toBe(90);
    expect(t.models["acme/fast-1"]!.timeouts.streamIdleTimeoutSeconds).toBe(45);
    expect(t.origins["timeouts.streamFirstEventTimeoutSeconds"]).toBe("omp");
  });

  test("fallbackChains: false imports no chain or retry setting", () => {
    const n = resolve({ omp: omp({ fallbackChains: false }) }, "ours.yml");
    expect(n.chains["acme/fast-1"]!.length).toBe(1);
    expect(n.retry.maxRetries).toBe(2);
    expect(n.sources.map(s => s.path)).toEqual(["ours.yml", `${FIX}/models.yml`]);
  });

  test("omp.models narrows the import", () => {
    const n = resolve({ omp: omp({ models: ["acme/fast-1", "acme/nope"] }) }, "ours.yml");
    expect(Object.keys(n.models)).toEqual(["acme/fast-1"]);
    expect(n.warnings).toContain("omp.models: acme/nope is not a model of an imported provider; skipped");
  });
});

describe("precedence: ours over omp, key by key", () => {
  const c = resolve({
    omp: omp({ agents: ["worker"], timeouts: true }),
    timeouts: { streamFirstEventTimeoutSeconds: 30 },
    retry: { maxRetries: 1, fallbackChains: { "acme/fast-1": ["acme/slow-2"] } },
    providers: { acme: { compat: { reasoningEffortMap: { off: "off" } }, models: { "fast-1": { name: "Ours Fast", defaultLevel: "low" }, "own-3": { name: "Ours Only" } } } },
    agents: { worker: { model: "acme/slow-2", description: "ours" } },
  }, "ours.yml");

  test("a model's fields, a provider compat key, a chain, an agent, a timeout", () => {
    const m = c.models["acme/fast-1"]!;
    expect(m.name).toBe("Ours Fast");
    expect(m.defaultLevel).toBe("low");
    expect(m.contextWindow).toBe(1048576); // still omp's
    expect(m.openai.reasoningEffortMap).toMatchObject({ off: "off", medium: "high" }); // ours + omp's
    expect(c.chains["acme/fast-1"]!.map(t => t.ref)).toEqual(["acme/fast-1", "acme/slow-2"]);
    expect(c.agents.find(a => a.name === "worker")!.description).toBe("ours");
    expect(c.timeouts.streamFirstEventTimeoutSeconds).toBe(30);
    expect(c.retry.maxRetries).toBe(1);
    expect(c.retry.rateLimitWalksChain).toBe(false); // still omp's
  });

  test("origins say which side each item came from", () => {
    expect(c.origins).toMatchObject({
      "provider acme": "ours over omp",
      "model acme/fast-1": "ours over omp",
      "model acme/slow-2": "omp",
      "model acme/own-3": "ours",
      "chain acme/fast-1": "ours over omp",
      "agent worker": "ours over omp",
      "retry.maxRetries": "ours over omp",
      "retry.rateLimitWalksChain": "omp",
      "timeouts.streamFirstEventTimeoutSeconds": "ours over omp",
    });
  });

  test("a warning about an omp chain our file replaces is dropped", () => {
    expect(c.warnings.some(w => w.startsWith("omp chain acme/fast-1"))).toBe(false);
  });

  test("our own rules still hold for merged models", () => {
    expect(problems({ omp: omp(), providers: { acme: { models: { "claude-x": {} } } } }).some(p => p.includes("contains a Claude model name"))).toBe(true);
  });
});

describe("broken or missing omp files", () => {
  const copy = () => { const d = mkdtempSync(`${tmp}/d-`); cpSync(FIX, d, { recursive: true }); return d; };

  test("missing models.yml is an error naming the file (the last good config stays)", () => {
    expect(problems({ omp: omp({ dir: `${tmp}/nowhere` }) })[0]).toMatch(/^omp: cannot read models.yml .*nowhere\/models.yml/);
  });
  test("unparsable or reshaped models.yml is an error", () => {
    const d = copy();
    writeFileSync(`${d}/models.yml`, "providers: [unclosed\n");
    expect(problems({ omp: omp({ dir: d }) })[0]).toContain("is not valid YAML");
    writeFileSync(`${d}/models.yml`, "models: []\n");
    expect(problems({ omp: omp({ dir: d }) })[0]).toContain("has no providers map");
  });
  test("a bad omp block is an error in our file", () => {
    expect(problems({ omp: { dir: FIX } })).toContain("omp.providers: required, the omp providers to import, by name (nothing is imported by default)");
    expect(problems({ omp: omp({ everything: true }) })[0]).toMatch(/^omp.everything: unknown key/);
  });
  test("agent frontmatter parsing", () => {
    expect(parseAgentFile("---\nname: a\nmodel: x/y\n---\nbody\n", "a.md")).toEqual({ front: { name: "a", model: "x/y" }, body: "body" });
    expect(() => parseAgentFile("no frontmatter", "a.md")).toThrow(/no --- frontmatter/);
  });
  test("loadConfig lists the omp files as sources, so a change to any reloads", () => {
    const d = copy();
    writeFileSync(`${d}/ours.yml`, `omp:\n  dir: ${d}\n  providers: [acme]\n  agents: [worker]\n`);
    const c = loadConfig(`${d}/ours.yml`);
    expect(c.sources.map(s => s.path)).toEqual([`${d}/ours.yml`, `${d}/models.yml`, `${d}/config.yml`, `${d}/agents/worker.md`]);
    expect(c.sources.every(s => s.mtimeMs > 0)).toBe(true);
  });
});

describe("gateway hot reload of omp files", () => {
  test("a changed omp agent file reloads; a broken models.yml keeps the last good config", async () => {
    const { Gateway } = await import("../src/server");
    const d = mkdtempSync(`${tmp}/hr-`);
    cpSync(FIX, d, { recursive: true });
    writeFileSync(`${d}/ours.yml`, `gateway: { accessLog: /dev/null }\nomp:\n  dir: ${d}\n  providers: [acme]\n  agents: [worker]\n`);
    const gw = new Gateway(loadConfig(`${d}/ours.yml`));
    gw.watch(30);
    try {
      await Bun.sleep(20);
      writeFileSync(`${d}/agents/worker.md`, readFileSync(`${d}/agents/worker.md`, "utf8").replace("General worker pinned to Acme Fast 1.", "Changed in omp."));
      await Bun.sleep(150);
      expect(gw.cfg.agents[0]!.description).toBe("Changed in omp.");
      writeFileSync(`${d}/models.yml`, "providers: [broken\n");
      await Bun.sleep(150);
      expect(gw.cfg.agents[0]!.description).toBe("Changed in omp.");
      expect(Object.keys(gw.cfg.models)).toContain("acme/fast-1");
      const health = await (await gw.fetch(new Request("http://gw/health"))).json() as any;
      expect(health.reloadError).toContain("is not valid YAML");
    } finally { gw.stop(); }
  });
});
