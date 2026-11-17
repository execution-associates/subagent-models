// Runs the gateway as a per-user background service: a systemd user unit on
// Linux, a launchd agent on macOS. `install` writes the service files, links the
// running copy of this project at a stable path (so a `mise upgrade` only needs
// another `install`), and starts it. Pure renderers are exported for the tests.
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const GATEWAY = "subagent-models";
export const SYNC = "subagent-models-omp-sync";
const LABEL = { gateway: "subagent-models.gateway", sync: "subagent-models.omp-sync" } as const;

/** The project this code runs from (gateway/src/service.ts → the repo or release root). */
export const projectRoot = () => resolve(import.meta.dir, "../..");
export const dataDir = () => `${process.env.XDG_DATA_HOME || `${homedir()}/.local/share`}/subagent-models`;
/** Stable link to the installed copy; services and the Claude Code plugin dir point here. */
export const appLink = () => `${dataDir()}/app`;
export const modDir = () => `${appLink()}/mod`;
export const macLogDir = () => `${homedir()}/Library/Logs/subagent-models`;

export type Ctx = {
  home: string;
  bun: string;          // absolute path the service runs bun from
  app: string;          // appLink()
  path: string;         // PATH for the service
  ompWatch: string[];   // files whose change means omp was updated
};

export function context(): Ctx {
  const home = homedir();
  const bun = bunPath();
  const dirs = [dirname(bun), `${home}/.local/bin`, `${home}/.local/share/mise/shims`, ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []), "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    home, bun, app: appLink(),
    path: [...new Set(dirs)].join(":"),
    ompWatch: ["/opt/omp/bin/omp", "/usr/local/bin/omp", `${home}/.omp/agent/last-changelog-version`],
  };
}

/** Prefer mise's shim over a versioned bun path, so a bun upgrade does not break the service. */
function bunPath(): string {
  if (process.env.SUBAGENT_MODELS_BUN) return process.env.SUBAGENT_MODELS_BUN;
  const shim = `${homedir()}/.local/share/mise/shims/bun`;
  if (existsSync(shim)) return shim;
  return Bun.which("bun") ?? process.execPath;
}

// ---------- systemd (Linux) ----------

export function renderSystemd(c: Ctx): Record<string, string> {
  const cli = `${c.app}/gateway/src/cli.ts`;
  return {
    [`${GATEWAY}.service`]: `[Unit]
Description=subagent-models gateway: Claude Code subagents on non-Claude models
After=network-online.target
# A broken config exits 78; keep trying so a fixed config is picked up without a manual restart.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${c.bun} ${cli} serve
Environment=PATH=${c.path}
Restart=always
RestartSec=3
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=default.target
`,
    [`${SYNC}.service`]: `[Unit]
Description=subagent-models: keep the omp SDK in step with the installed omp

[Service]
Type=oneshot
ExecStart=${c.bun} ${cli} omp-sdk sync
Environment=PATH=${c.path}
NoNewPrivileges=yes
UMask=0077
TimeoutStartSec=20min
`,
    [`${SYNC}.path`]: `[Unit]
Description=subagent-models: sync the omp SDK when omp is updated

[Path]
${c.ompWatch.map(p => `PathChanged=${p}`).join("\n")}
Unit=${SYNC}.service

[Install]
WantedBy=default.target
`,
    [`${SYNC}.timer`]: `[Unit]
Description=subagent-models: retry the omp SDK sync (backoff is in the sync itself)

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
Unit=${SYNC}.service

[Install]
WantedBy=timers.target
`,
  };
}

// ---------- launchd (macOS) ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const strings = (xs: string[]) => xs.map(x => `    <string>${esc(x)}</string>`).join("\n");

function plist(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

export function renderLaunchd(c: Ctx, logDir = macLogDir()): Record<string, string> {
  const cli = `${c.app}/gateway/src/cli.ts`;
  const common = (label: string, args: string[], log: string) => `  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${strings(args)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(c.path)}</string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${esc(`${logDir}/${log}`)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(`${logDir}/${log}`)}</string>`;
  return {
    [`${LABEL.gateway}.plist`]: plist(`${common(LABEL.gateway, [c.bun, cli, "serve"], "gateway.log")}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>`),
    [`${LABEL.sync}.plist`]: plist(`${common(LABEL.sync, [c.bun, cli, "omp-sdk", "sync"], "omp-sync.log")}
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>WatchPaths</key>
  <array>
${strings(c.ompWatch)}
  </array>`),
  };
}

// ---------- doing it ----------

const mac = process.platform === "darwin";
const uid = () => process.getuid?.() ?? 501;
const systemdDir = () => `${process.env.XDG_CONFIG_HOME || `${homedir()}/.config`}/systemd/user`;
const agentsDir = () => `${homedir()}/Library/LaunchAgents`;
const plistPath = (k: keyof typeof LABEL) => `${agentsDir()}/${LABEL[k]}.plist`;

async function sh(argv: string[], { quiet = false, check = true } = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  const code = await p.exited;
  if (code !== 0 && check && !quiet) throw new Error(`${argv.join(" ")} failed (${code}): ${(err || out).trim()}`);
  return { code, out: out + err };
}
async function passthrough(argv: string[]): Promise<number> {
  return Bun.spawn(argv, { stdout: "inherit", stderr: "inherit", stdin: "inherit" }).exited;
}

/** Write a file, replacing a symlink rather than writing through it. */
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch {}
  writeFileSync(path, text);
}

function link(target: string, at: string) {
  mkdirSync(dirname(at), { recursive: true });
  try {
    if (lstatSync(at).isSymbolicLink() && readlinkSync(at) === target) return false;
    unlinkSync(at);
  } catch {}
  symlinkSync(target, at);
  return true;
}

/** omp-native mode's SDK sync installs packages inside an isb sandbox, so it needs isb. */
const canSync = () => Bun.which("isb") !== null;

export async function install(configPath: string, { start = true } = {}) {
  const root = projectRoot();
  console.log(link(root, appLink()) ? `linked ${appLink()} -> ${root}` : `${appLink()} -> ${root}`);
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    copyFileSync(`${root}/config.example.yml`, configPath);
    console.log(`wrote ${configPath} (a copy of config.example.yml: edit it before use)`);
  }
  const c = context();
  const sync = canSync();
  if (mac) {
    mkdirSync(macLogDir(), { recursive: true });
    const files = renderLaunchd(c);
    for (const k of ["gateway", "sync"] as const) {
      if (k === "sync" && !sync) continue;
      put(plistPath(k), files[`${LABEL[k]}.plist`]!);
      console.log(`wrote ${plistPath(k)}`);
      if (start) await launchdLoad(k);
    }
  } else {
    const files = renderSystemd(c);
    for (const [name, text] of Object.entries(files)) {
      if (name.startsWith(SYNC) && !sync) continue;
      put(`${systemdDir()}/${name}`, text);
      console.log(`wrote ${systemdDir()}/${name}`);
    }
    await sh(["systemctl", "--user", "daemon-reload"]);
    if (start) {
      await sh(["systemctl", "--user", "enable", `${GATEWAY}.service`]);
      await sh(["systemctl", "--user", "restart", `${GATEWAY}.service`]);
      if (sync) await sh(["systemctl", "--user", "enable", "--now", `${SYNC}.path`, `${SYNC}.timer`]);
    }
  }
  if (!sync) console.log("note: isb is not on PATH, so the omp SDK sync (omp-native mode only) is not installed");
  console.log(start ? "gateway started" : "not started (--no-start)");
  console.log(`\nLoad the Claude Code mod from ${modDir()}, e.g. in ~/.claude/settings.json:\n  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "${modDir()}" }`);
}

export async function uninstall() {
  if (mac) {
    for (const k of ["gateway", "sync"] as const) {
      await sh(["launchctl", "bootout", `gui/${uid()}/${LABEL[k]}`], { check: false });
      if (existsSync(plistPath(k))) { unlinkSync(plistPath(k)); console.log(`removed ${plistPath(k)}`); }
    }
  } else {
    const names = Object.keys(renderSystemd(context()));
    await sh(["systemctl", "--user", "disable", "--now", ...names.filter(n => !n.endsWith(`${SYNC}.service`))], { check: false });
    for (const n of names) {
      const p = `${systemdDir()}/${n}`;
      try { lstatSync(p); unlinkSync(p); console.log(`removed ${p}`); } catch {}
    }
    await sh(["systemctl", "--user", "daemon-reload"], { check: false });
  }
  try { unlinkSync(appLink()); console.log(`removed ${appLink()}`); } catch {}
  console.log("config and state are kept (~/.config/subagent-models, ~/.local/state/subagent-models, ~/.local/share/subagent-models)");
}

async function launchdLoad(k: keyof typeof LABEL) {
  await sh(["launchctl", "bootout", `gui/${uid()}/${LABEL[k]}`], { check: false });
  await sh(["launchctl", "bootstrap", `gui/${uid()}`, plistPath(k)]);
}

function requireInstalled() {
  const p = mac ? plistPath("gateway") : `${systemdDir()}/${GATEWAY}.service`;
  if (!existsSync(p)) { console.error(`not installed (${p} is missing): run subagent-models install`); process.exit(1); }
}

export async function control(action: "start" | "stop" | "restart") {
  requireInstalled();
  if (mac) {
    const target = `gui/${uid()}/${LABEL.gateway}`;
    if (action === "stop") await sh(["launchctl", "bootout", target], { check: false });
    else if (action === "start") {
      const loaded = (await sh(["launchctl", "print", target], { check: false })).code === 0;
      if (!loaded) await launchdLoad("gateway");
    } else await sh(["launchctl", "kickstart", "-k", target]);
  } else {
    await sh(["systemctl", "--user", action, `${GATEWAY}.service`]);
  }
  console.log(`${action}: ok`);
}

/** One line on what the service manager thinks. */
export async function serviceState(): Promise<string> {
  if (mac) {
    if (!existsSync(plistPath("gateway"))) return "service: not installed";
    const r = await sh(["launchctl", "print", `gui/${uid()}/${LABEL.gateway}`], { check: false });
    if (r.code !== 0) return `service: ${LABEL.gateway} not loaded (subagent-models start)`;
    const state = /\n\s*state = (.+)/.exec(r.out)?.[1] ?? "unknown";
    const pid = /\n\s*pid = (\d+)/.exec(r.out)?.[1];
    return `service: launchd ${LABEL.gateway} ${state}${pid ? ` (pid ${pid})` : ""}`;
  }
  if (!existsSync(`${systemdDir()}/${GATEWAY}.service`)) return "service: not installed";
  const r = await sh(["systemctl", "--user", "show", `${GATEWAY}.service`, "-p", "ActiveState,SubState,MainPID", "--value"], { check: false });
  const [active = "unknown", sub = "unknown", pid] = r.out.trim().split("\n");
  return `service: systemd ${GATEWAY}.service ${active}/${sub}${pid && pid !== "0" ? ` (pid ${pid})` : ""}`;
}

export async function logs(which: "gateway" | "sync", follow: boolean): Promise<number> {
  if (mac) {
    const f = `${macLogDir()}/${which === "gateway" ? "gateway.log" : "omp-sync.log"}`;
    if (!existsSync(f)) { console.error(`no log yet at ${f}`); return 1; }
    return passthrough(["tail", "-n", "200", ...(follow ? ["-f"] : []), f]);
  }
  return passthrough(["journalctl", "--user", "-u", which === "gateway" ? GATEWAY : SYNC, "-n", "200", "--no-pager", ...(follow ? ["-f"] : [])]);
}

/** Ask the service manager to run the omp SDK sync now (used by the gateway when it sees skew). */
export function startSyncService() {
  const argv = mac
    ? ["launchctl", "kickstart", `gui/${uid()}/${LABEL.sync}`]
    : ["systemctl", "--user", "start", "--no-block", `${SYNC}.service`];
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

export const statusHint = () => "subagent-models status; subagent-models logs";

export function version(): string {
  try { return JSON.parse(readFileSync(join(projectRoot(), "mod/.claude-plugin/plugin.json"), "utf8")).version; }
  catch { return "unknown"; }
}
