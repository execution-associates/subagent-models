// The omp SDK sync, with a fake registry, installer and verifier.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PACKAGES, type SyncDeps, backoffMs, currentSdkDir, linkedVersion, lockIntegrity, readState, rollback, sync, versionFromBinary } from "../src/omp-sdk";

const root = mkdtempSync(`${tmpdir()}/smg-sdk-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir: string;
let n = 0;
process.env.SUBAGENT_MODELS_OMP_BIN = `${root}/no-such-omp`;

const integ = (p: string, v: string) => `sha512-${Buffer.from(`${p}@${v}`).toString("base64")}`;
type Fake = SyncDeps & { installs: string[]; verifies: string[]; t: number; unpublished: Set<string>; badVerify: Set<string>; tamper: Set<string> };
function fake(): Fake {
  const f: Fake = {
    installs: [], verifies: [], t: 1_000_000, unpublished: new Set(), badVerify: new Set(), tamper: new Set(),
    now: () => f.t,
    log: () => {},
    async published(v) {
      if (f.unpublished.has(v)) return { ok: false, reason: `@oh-my-pi/pi-coding-agent@${v} is not published yet`, retry: true };
      return { ok: true, integrity: Object.fromEntries(PACKAGES.map(p => [p, integ(p, v)])) };
    },
    async install(d, v) {
      f.installs.push(v);
      const lines = PACKAGES.map(p => `    "${p}": ["${p}@${v}", "", {}, "${f.tamper.has(v) ? "sha512-tampered" : integ(p, v)}"],`);
      writeFileSync(`${d}/bun.lock`, `{\n  "packages": {\n${lines.join("\n")}\n  }\n}\n`);
      for (const p of PACKAGES) { mkdirSync(`${d}/node_modules/${p}`, { recursive: true }); writeFileSync(`${d}/node_modules/${p}/package.json`, JSON.stringify({ version: v })); }
    },
    async verify(d) {
      f.verifies.push(d);
      if ([...f.badVerify].some(v => d.includes(`/${v}.staging-`))) throw new Error("verification failed: cannot open the auth store");
      return { models: 42, available: 7 };
    },
  };
  return f;
}
const at = (v: string) => { process.env.SUBAGENT_MODELS_OMP_VERSION = v; };

beforeEach(() => { dir = `${root}/s${++n}`; delete process.env.SUBAGENT_MODELS_OMP_VERSION; });

describe("sync", () => {
  test("first run: installs the installed omp's version, verifies, links current", async () => {
    const f = fake(); at("18.20.0");
    const s = await sync(f, { dir, agentDir: root });
    expect(s).toMatchObject({ phase: "idle", current: "18.20.0", installedOmp: "18.20.0", installedFrom: "override (env)", lastError: null });
    expect(readlinkSync(`${dir}/current`)).toBe("18.20.0");
    expect(JSON.parse(readFileSync(`${dir}/18.20.0/verified.json`, "utf8"))).toMatchObject({ version: "18.20.0", models: 42 });
    expect(currentSdkDir(dir)).toBe(`${dir}/18.20.0`);
    expect(await sync(f, { dir, agentDir: root })).toMatchObject({ phase: "idle" });
    expect(f.installs).toEqual(["18.20.0"]); // nothing to do the second time
  });

  test("omp updates: the new version is verified before the switch; previous kept; older pruned", async () => {
    const f = fake();
    for (const v of ["18.18.9", "18.19.0", "18.20.0"]) { at(v); await sync(f, { dir, agentDir: root }); }
    expect(linkedVersion(dir, "current")).toBe("18.20.0");
    expect(linkedVersion(dir, "previous")).toBe("18.19.0");
    expect(existsSync(`${dir}/18.18.9`)).toBe(false);
    expect(f.verifies.every(d => d.includes(".staging-"))).toBe(true);
  });

  test("not published yet: stays on the working SDK, waits, retries with backoff", async () => {
    const f = fake();
    at("18.20.0"); await sync(f, { dir, agentDir: root });
    f.unpublished.add("18.21.0"); at("18.21.0");
    let s = await sync(f, { dir, agentDir: root });
    expect(s).toMatchObject({ phase: "waiting", current: "18.20.0", target: "18.21.0", attempts: 1, nextAttemptAt: f.t + 60_000 });
    expect(s.lastError).toContain("is not published yet");
    f.t += 30_000; s = await sync(f, { dir, agentDir: root });
    expect(s.attempts).toBe(1); // still backing off: nothing tried
    f.t += 31_000; s = await sync(f, { dir, agentDir: root });
    expect(s).toMatchObject({ attempts: 2, nextAttemptAt: f.t + 120_000 });
    f.unpublished.clear(); f.t += 120_001;
    s = await sync(f, { dir, agentDir: root });
    expect(s).toMatchObject({ phase: "idle", current: "18.21.0", previous: "18.20.0", attempts: 0 });
  });

  test("verification fails: no switch, staging removed, retry scheduled", async () => {
    const f = fake();
    at("18.20.0"); await sync(f, { dir, agentDir: root });
    f.badVerify.add("18.21.0"); at("18.21.0");
    const s = await sync(f, { dir, agentDir: root });
    expect(s).toMatchObject({ phase: "failed", current: "18.20.0", target: "18.21.0" });
    expect(s.lastError).toContain("cannot open the auth store");
    expect(linkedVersion(dir, "current")).toBe("18.20.0");
    expect(existsSync(`${dir}/18.21.0`)).toBe(false);
  });

  test("an integrity that differs from the registry's is refused", async () => {
    const f = fake();
    at("18.20.0"); await sync(f, { dir, agentDir: root });
    f.tamper.add("18.21.0"); at("18.21.0");
    const s = await sync(f, { dir, agentDir: root });
    expect(s.phase).toBe("failed");
    expect(s.lastError).toContain("differs from the registry's");
    expect(linkedVersion(dir, "current")).toBe("18.20.0");
  });

  test("a downgrade to a version still on disk switches at once; rollback goes back", async () => {
    const f = fake();
    at("18.19.0"); await sync(f, { dir, agentDir: root });
    at("18.20.0"); await sync(f, { dir, agentDir: root });
    at("18.19.0");
    const s = await sync(f, { dir, agentDir: root });
    expect(s).toMatchObject({ current: "18.19.0", previous: "18.20.0" });
    expect(f.installs).toEqual(["18.19.0", "18.20.0"]);
    const r = rollback(dir);
    expect(r).toMatchObject({ current: "18.20.0", previous: "18.19.0", pinned: { version: "18.20.0", whileOmp: "18.19.0" } });
    // pinned: the sync does not undo the rollback while omp stays the same
    expect(await sync(f, { dir, agentDir: root })).toMatchObject({ current: "18.20.0" });
    // omp changes: the pin is dropped and the sync follows omp again
    at("18.21.0");
    expect(await sync(f, { dir, agentDir: root })).toMatchObject({ current: "18.21.0", pinned: null });
  });

  test("a second sync while one runs does nothing", async () => {
    const f = fake(); at("18.20.0");
    let release!: () => void;
    const slow = { ...f, install: async (d: string, v: string) => { await new Promise<void>(r => (release = r)); return f.install(d, v); } };
    const first = sync(slow, { dir, agentDir: root });
    await Bun.sleep(20);
    await sync(f, { dir, agentDir: root });
    expect(f.installs).toEqual([]);
    release();
    expect((await first).current).toBe("18.20.0");
  });

  test("backoff doubles from a minute to at most an hour", () => {
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 3_600_000]);
  });
});

describe("helpers", () => {
  test("the installed version from a binary's omp/<version> marker, refused when ambiguous", () => {
    writeFileSync(`${root}/bin1`, Buffer.concat([Buffer.alloc(1000), Buffer.from("user-agent omp/18.21.3 x"), Buffer.alloc(10)]));
    expect(versionFromBinary(`${root}/bin1`)).toBe("18.21.3");
    writeFileSync(`${root}/bin2`, "omp/1.2.3 and omp/1.2.4");
    expect(versionFromBinary(`${root}/bin2`)).toBe(null);
  });
  test("lockfile integrity of the tracked baseline", () => {
    const lock = readFileSync(`${import.meta.dir}/../omp-sdk/bun.lock`, "utf8");
    const i = lockIntegrity(lock, "18.20.0");
    expect(Object.keys(i).sort()).toEqual([...PACKAGES].sort());
    expect(i["@oh-my-pi/pi-ai"]).toMatch(/^sha512-0PcMR1nF3T/);
    expect(lockIntegrity(lock, "9.9.9")).toEqual({});
  });
  test("state survives as JSON", async () => {
    const f = fake(); at("18.20.0");
    await sync(f, { dir, agentDir: root });
    expect(readState(dir).current).toBe("18.20.0");
  });
});
