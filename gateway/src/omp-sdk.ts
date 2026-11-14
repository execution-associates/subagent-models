// Keeps a copy of omp's SDK that matches the installed omp, unattended.
//
// omp is a compiled binary and updates itself, so the gateway runs its own copy of
// omp's SDK (@oh-my-pi/pi-coding-agent + @oh-my-pi/pi-ai). This module keeps that
// copy in step with the installed omp:
//
//   ~/.local/share/subagent-models/omp-sdk/      (machine state, never in git)
//     <version>/           package.json, bun.lock, node_modules/, natives/, verified.json
//     current -> <version> what the gateway loads
//     previous -> <version> kept for rollback
//     state.json           installed omp, sync phase, last error, next retry
//
// sync(): detect the installed omp version; if no verified copy of it exists,
// check both packages are published, install them in a throwaway isb sandbox
// (--ignore-scripts, exact versions, the official registry) into a staging
// directory, compare the lockfile's integrity with the registry's, verify on the
// host that the SDK loads, opens omp's auth store and lists models, and only then
// switch `current` (atomically). Anything that fails leaves `current` as it was
// and schedules a retry with backoff. The gateway watches `current` and hot-swaps.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const PACKAGES = ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-ai"] as const;
export const REGISTRY = "https://registry.npmjs.org";

export function stateDir(): string {
  return process.env.SUBAGENT_MODELS_OMP_SDK_DIR || `${process.env.XDG_DATA_HOME || `${homedir()}/.local/share`}/subagent-models/omp-sdk`;
}

/** The tracked manifest: the baseline the code was written against, and the lockfile for it. */
export const MANIFEST_DIR = `${dirname(import.meta.dir)}/omp-sdk`;

export type SyncState = {
  installedOmp: string | null;
  /** Where installedOmp came from: override, binary, version-file. */
  installedFrom: string | null;
  current: string | null;
  previous: string | null;
  phase: "idle" | "syncing" | "waiting" | "failed";
  target: string | null;
  lastError: string | null;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  attempts: number;
  lastSwitchAt: number | null;
  /** Set by rollback: stay on `version` while the installed omp is still `whileOmp`. */
  pinned: { version: string; whileOmp: string | null } | null;
};

const EMPTY: SyncState = { installedOmp: null, installedFrom: null, current: null, previous: null, phase: "idle", target: null, lastError: null, lastAttemptAt: null, nextAttemptAt: null, attempts: 0, lastSwitchAt: null, pinned: null };

export function readState(dir = stateDir()): SyncState {
  try { return { ...EMPTY, ...JSON.parse(readFileSync(`${dir}/state.json`, "utf8")) }; } catch { return { ...EMPTY }; }
}
function writeState(dir: string, s: SyncState) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/state.json.tmp`, JSON.stringify(s, null, 1));
  renameSync(`${dir}/state.json.tmp`, `${dir}/state.json`);
}

/** The version `current` points at, or null. */
export function linkedVersion(dir: string, name: "current" | "previous"): string | null {
  try { return readlinkSync(`${dir}/${name}`).replace(/\/+$/, "").split("/").pop() || null; } catch { return null; }
}

/** The directory of the SDK the gateway should load, or null when none is installed. */
export function currentSdkDir(dir = stateDir()): string | null {
  const v = linkedVersion(dir, "current");
  return v && existsSync(`${dir}/${v}/verified.json`) ? `${dir}/${v}` : null;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

// ---------- installed omp version ----------

let binaryCache: { key: string; version: string | null } | null = null;

/** omp's version from its compiled binary, without running it: the `omp/<version>` user-agent marker. */
export function versionFromBinary(path: string): string | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  const key = `${path}:${st.size}:${st.mtimeMs}`;
  if (binaryCache?.key === key) return binaryCache.version;
  let version: string | null = null;
  try {
    const counts = new Map<string, number>();
    const data = readFileSync(path);
    const re = /omp\/(\d+\.\d+\.\d+)\b/g;
    const text = data.toString("latin1");
    for (const m of text.matchAll(re)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
    if (counts.size === 1) version = [...counts.keys()][0]!;
  } catch {}
  binaryCache = { key, version };
  return version;
}

export function ompBinaryPath(): string {
  return process.env.SUBAGENT_MODELS_OMP_BIN || "/usr/local/bin/omp";
}

/**
 * The installed omp version: an override (SUBAGENT_MODELS_OMP_VERSION, or the file
 * <state>/installed-version.override, for testing the switch), else the binary's
 * marker, else the version omp last ran as (<agentDir>/last-changelog-version).
 */
export function installedOmp(agentDir = `${homedir()}/.omp/agent`, dir = stateDir()): { version: string | null; from: string | null } {
  const env = process.env.SUBAGENT_MODELS_OMP_VERSION?.trim();
  if (env) return { version: env, from: "override (env)" };
  try {
    const o = readFileSync(`${dir}/installed-version.override`, "utf8").trim();
    if (o) return { version: o, from: "override (file)" };
  } catch {}
  const b = versionFromBinary(ompBinaryPath());
  if (b) return { version: b, from: `binary ${ompBinaryPath()}` };
  try {
    const f = readFileSync(`${agentDir}/last-changelog-version`, "utf8").trim();
    if (SEMVER.test(f)) return { version: f, from: "last-changelog-version" };
  } catch {}
  return { version: null, from: null };
}

// ---------- the steps, injectable for tests ----------

export type SyncDeps = {
  /** Registry metadata: dist.integrity per package, or a reason it is not available. */
  published(version: string): Promise<{ ok: true; integrity: Record<string, string> } | { ok: false; reason: string; retry: boolean }>;
  /** Installs package.json in `dir` (exact pins, scripts off) into dir/node_modules, writing dir/bun.lock. */
  install(dir: string, version: string): Promise<void>;
  /** Loads the SDK in `dir` in a separate process: opens omp's auth store and lists models. */
  verify(dir: string, agentDir: string): Promise<{ models: number; available: number }>;
  now(): number;
  log(msg: string): void;
};

export function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** The version and integrity bun recorded for each of our packages in a lockfile. */
export function lockIntegrity(lockText: string, version?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lockText.split("\n")) {
    for (const p of PACKAGES) {
      const head = `"${p}": ["${p}@`;
      const i = line.indexOf(head);
      if (i < 0) continue;
      const v = line.slice(i + head.length).split('"')[0];
      const sha = /"(sha512-[A-Za-z0-9+/=]+)"\s*\],?\s*$/.exec(line)?.[1];
      if (sha && (!version || v === version)) out[p] = sha;
    }
  }
  return out;
}

function manifestFor(version: string): string {
  let base: any;
  try { base = JSON.parse(readFileSync(`${MANIFEST_DIR}/package.json`, "utf8")); } catch { base = { name: "subagent-models-omp-sdk", private: true }; }
  const deps: Record<string, string> = {};
  for (const p of PACKAGES) deps[p] = version;
  return JSON.stringify({ name: base.name, private: true, description: base.description, dependencies: deps }, null, 2) + "\n";
}

function relink(dir: string, name: "current" | "previous", version: string) {
  const tmp = `${dir}/.${name}.${process.pid}`;
  try { unlinkSync(tmp); } catch {}
  symlinkSync(version, tmp);
  renameSync(tmp, `${dir}/${name}`); // atomic replace
}

/** Switches `current` to an already verified version; the old current becomes `previous`. */
export function switchTo(version: string, dir = stateDir(), now = Date.now()): SyncState {
  if (!existsSync(`${dir}/${version}/verified.json`)) throw new Error(`omp SDK ${version} is not installed and verified in ${dir}`);
  const s = readState(dir);
  const cur = linkedVersion(dir, "current");
  if (cur === version) return s;
  if (cur && existsSync(`${dir}/${cur}/verified.json`)) relink(dir, "previous", cur);
  relink(dir, "current", version);
  const next = { ...s, current: version, previous: linkedVersion(dir, "previous"), lastSwitchAt: now };
  writeState(dir, next);
  return next;
}

/** Deletes versions other than current and previous (and stale staging directories). */
export function prune(dir = stateDir()) {
  const keep = new Set([linkedVersion(dir, "current"), linkedVersion(dir, "previous")].filter(Boolean));
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.includes(".staging-") || (SEMVER.test(e.name) && !keep.has(e.name))) rmSync(`${dir}/${e.name}`, { recursive: true, force: true });
  }
}

/** One lock per state directory: two syncs never run at once. */
function lock(dir: string): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/sync.lock`;
  try {
    const fd = openSync(p, "wx");
    writeFileSync(p, String(process.pid));
    closeSync(fd);
  } catch {
    // A lock whose process is gone is stale.
    try { const pid = Number(readFileSync(p, "utf8")); if (pid && !isAlive(pid)) { unlinkSync(p); return lock(dir); } } catch {}
    return null;
  }
  return () => { try { unlinkSync(p); } catch {} };
}
function isAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

export type SyncOptions = { force?: boolean; agentDir?: string; dir?: string };

/** Brings `current` to the installed omp version, or explains why not. Never breaks `current`. */
export async function sync(deps: SyncDeps, o: SyncOptions = {}): Promise<SyncState> {
  const dir = o.dir ?? stateDir();
  const agentDir = o.agentDir ?? `${homedir()}/.omp/agent`;
  const unlock = lock(dir);
  if (!unlock) { deps.log("omp-sdk: another sync is running"); return readState(dir); }
  let s = readState(dir);
  const prevTarget = s.target;
  try {
    const inst = installedOmp(agentDir, dir);
    s = { ...s, installedOmp: inst.version, installedFrom: inst.from, current: linkedVersion(dir, "current"), previous: linkedVersion(dir, "previous") };
    if (!inst.version) { s = { ...s, phase: "failed", lastError: "cannot tell which omp version is installed" }; return s; }
    const v = inst.version;
    if (s.pinned) {
      if (s.pinned.whileOmp === v && s.current === s.pinned.version) { s = { ...s, phase: "idle", target: null }; return s; }
      s = { ...s, pinned: null }; // omp changed since the rollback: follow it again
    }
    if (s.current === v && currentSdkDir(dir)) { s = { ...s, phase: "idle", target: null, lastError: null, attempts: 0, nextAttemptAt: null }; return s; }
    // A verified copy already on disk (a downgrade, or after a rollback): switch at once.
    if (existsSync(`${dir}/${v}/verified.json`)) {
      s = { ...switchTo(v, dir, deps.now()), installedOmp: v, installedFrom: inst.from, phase: "idle", target: null, lastError: null, attempts: 0, nextAttemptAt: null };
      deps.log(`omp-sdk: switched to ${v} (already verified on disk)`);
      return s;
    }
    if (!o.force && s.target === v && s.nextAttemptAt && deps.now() < s.nextAttemptAt) return s; // backing off
    s = { ...s, phase: "syncing", target: v, lastAttemptAt: deps.now() };
    writeState(dir, s);

    const pub = await deps.published(v);
    if (!pub.ok) throw Object.assign(new Error(pub.reason), { waiting: true, retry: pub.retry });

    const staging = `${dir}/${v}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      writeFileSync(`${staging}/package.json`, manifestFor(v));
      // The baseline lockfile is reused when it is for this very version (reproducible bootstrap).
      try {
        const base = readFileSync(`${MANIFEST_DIR}/bun.lock`, "utf8");
        if (Object.keys(lockIntegrity(base, v)).length === PACKAGES.length) writeFileSync(`${staging}/bun.lock`, base);
      } catch {}
      await deps.install(staging, v);
      const lockText = readFileSync(`${staging}/bun.lock`, "utf8");
      const got = lockIntegrity(lockText, v);
      for (const p of PACKAGES) {
        if (!got[p]) throw new Error(`the lockfile records no integrity for ${p}@${v}`);
        if (got[p] !== pub.integrity[p]) throw new Error(`integrity of ${p}@${v} differs from the registry's (lockfile ${got[p]!.slice(0, 20)}…, registry ${pub.integrity[p]?.slice(0, 20)}…)`);
      }
      for (const p of PACKAGES) {
        const pv = JSON.parse(readFileSync(`${staging}/node_modules/${p}/package.json`, "utf8")).version;
        if (pv !== v) throw new Error(`installed ${p} is ${pv}, not ${v}`);
      }
      const ver = await deps.verify(staging, agentDir);
      if (!(ver.models > 0)) throw new Error(`the SDK loaded but listed no models`);
      writeFileSync(`${staging}/verified.json`, JSON.stringify({ version: v, verifiedAt: deps.now(), integrity: got, models: ver.models, available: ver.available }, null, 1));
      rmSync(`${dir}/${v}`, { recursive: true, force: true });
      renameSync(staging, `${dir}/${v}`);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    s = { ...switchTo(v, dir, deps.now()), installedOmp: v, installedFrom: inst.from, phase: "idle", target: null, lastError: null, attempts: 0, nextAttemptAt: null };
    prune(dir);
    deps.log(`omp-sdk: installed, verified and switched to ${v} (previous: ${s.previous ?? "none"})`);
    return s;
  } catch (e) {
    const err = e as Error & { waiting?: boolean; retry?: boolean };
    const attempts = (prevTarget === s.target ? s.attempts : 0) + 1;
    s = { ...s, phase: err.waiting ? "waiting" : "failed", lastError: err.message.slice(0, 800), attempts, nextAttemptAt: err.retry === false ? null : deps.now() + backoffMs(attempts) };
    deps.log(`omp-sdk: sync to ${s.target} failed (staying on ${s.current ?? "nothing"}): ${s.lastError}; next try ${s.nextAttemptAt ? new Date(s.nextAttemptAt).toISOString() : "on the next change"}`);
    return s;
  } finally {
    writeState(dir, s);
    unlock();
  }
}

/** Back to `previous` (and stays there until the installed omp version changes again). */
export function rollback(dir = stateDir(), now = Date.now()): SyncState {
  const prev = linkedVersion(dir, "previous");
  if (!prev) throw new Error("no previous omp SDK to roll back to");
  const s = switchTo(prev, dir, now);
  const pinned = { ...s, pinned: { version: prev, whileOmp: installedOmp(undefined, dir).version } };
  writeState(dir, pinned);
  return pinned;
}

/** Drops a rollback's pin: the next sync follows the installed omp again. */
export function unpin(dir = stateDir()): SyncState {
  const s = { ...readState(dir), pinned: null, nextAttemptAt: null };
  writeState(dir, s);
  return s;
}

// ---------- the real steps ----------

export const realDeps = (log: (m: string) => void = m => console.log(m)): SyncDeps => ({
  now: () => Date.now(),
  log,
  async published(version) {
    const integrity: Record<string, string> = {};
    for (const p of PACKAGES) {
      let r: Response;
      try { r = await fetch(`${process.env.SUBAGENT_MODELS_NPM_REGISTRY || REGISTRY}/${p.replace("/", "%2f")}/${version}`, { signal: AbortSignal.timeout(20_000) }); }
      catch (e) { return { ok: false, reason: `the registry is unreachable (${(e as Error).message})`, retry: true }; }
      if (r.status === 404) return { ok: false, reason: `${p}@${version} is not published yet`, retry: true };
      if (!r.ok) return { ok: false, reason: `the registry answered HTTP ${r.status} for ${p}@${version}`, retry: true };
      const j: any = await r.json();
      if (typeof j?.dist?.integrity !== "string") return { ok: false, reason: `${p}@${version} has no integrity in the registry`, retry: true };
      integrity[p] = j.dist.integrity;
    }
    return { ok: true, integrity };
  },
  async install(dir, version) {
    // Fetch and unpack in a throwaway sandbox that sees only the staging directory.
    const name = `omp-sdk-${version.replace(/\./g, "-")}-${process.pid}`;
    const run = async (argv: string[], timeoutMs: number) => {
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const t = setTimeout(() => p.kill(), timeoutMs);
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(t);
      if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (exit ${code}): ${(err || out).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
      return out;
    };
    await run(["isb", "create", "--image", "dev-base", "--idmap", "auto", "--ready", "default_route", "-l", "owner=subagent-models", "-v", `${dir}:/home/dev/omp-sdk`, name], 300_000);
    try {
      const frozen = existsSync(`${dir}/bun.lock`) ? "--frozen-lockfile" : "";
      await run(["isb", "exec", name, "--", "su", "-", "dev", "-c", `for i in $(seq 1 60); do getent hosts registry.npmjs.org >/dev/null && break; sleep 1; done; mise use -g bun@1.4.4 >/dev/null 2>&1; export PATH=$HOME/.local/share/mise/shims:$PATH; cd ~/omp-sdk && bun install --exact --ignore-scripts ${frozen}`], 600_000);
    } finally {
      await run(["isb", "rm", "-f", name], 120_000).catch(() => {});
    }
  },
  async verify(dir, agentDir) {
    const p = Bun.spawn(["bun", `${import.meta.dir}/omp-sdk-verify.ts`, dir, agentDir], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...process.env, PI_NATIVES_DIR: `${dir}/natives`, PI_CODING_AGENT_DIR: agentDir },
    });
    const t = setTimeout(() => p.kill(), 120_000);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(t);
    const line = out.trim().split("\n").pop() ?? "";
    let j: any;
    try { j = JSON.parse(line); } catch {}
    if (code !== 0 || !j?.ok) throw new Error(`verification failed: ${j?.error ?? (err.trim().split("\n").slice(-2).join(" ") || `exit ${code}`)}`.slice(0, 600));
    return { models: j.models, available: j.available };
  },
});

/** One line per fact, for `check`, `status` and the unit's journal. */
export function describe(s = readState(), dir = stateDir()): string[] {
  const live = installedOmp(undefined, dir);
  const cur = linkedVersion(dir, "current");
  const lines = [
    `omp installed: ${live.version ?? "unknown"}${live.from ? ` (${live.from})` : ""}${live.version && cur && live.version !== cur ? ` — differs from the SDK in use (${cur}); serving with ${cur} until the sync switches` : ""}`,
    `omp SDK in use: ${linkedVersion(dir, "current") ?? "none"}${linkedVersion(dir, "previous") ? ` (previous: ${linkedVersion(dir, "previous")})` : ""} in ${dir}`,
    `omp SDK sync: ${s.phase}${s.target ? ` -> ${s.target}` : ""}${s.nextAttemptAt ? `, next try ${new Date(s.nextAttemptAt).toISOString()}` : ""}`,
  ];
  if (s.pinned) lines.push(`omp SDK pinned to ${s.pinned.version} by a rollback while omp is ${s.pinned.whileOmp ?? "unknown"} (omp-sdk unpin to follow omp again)`);
  if (s.lastError) lines.push(`omp SDK last error: ${s.lastError}`);
  return lines;
}

export function existsLink(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
