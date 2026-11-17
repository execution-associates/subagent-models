#!/usr/bin/env bun
// subagent-models CLI (bin/subagent-models runs this).
//   install [--no-start] | uninstall | start | stop | restart | logs [sync] [-f]
//                                the gateway as a user service (systemd on Linux, launchd on macOS)
//   serve [--config FILE]        run the gateway in the foreground (what the service runs)
//   check [--config FILE]        validate the config and print what it defines
//   mod-config [--config FILE]   the config as the Claude Code mod reads it (JSON, no keys)
//   status [--config FILE]       service state, then ask the running gateway for models, chains, cooldowns, recent requests
//   key-check PROVIDER           resolve a provider's key and say whether it worked (never prints it)
//   omp-sdk status|sync [--force]|rollback|unpin|use VERSION   the omp SDK copy that follows the installed omp
//   omp-find PROVIDER/MODEL      how omp resolves an id, and whether it routes here (omp-native mode)
import { ConfigError, defaultConfigPath, loadConfig, modView } from "./config";
import { KeyStore } from "./keys";
import { main } from "./server";
import { control, install, logs, modDir, serviceState, statusHint, uninstall, version } from "./service";
import { describe as describeSdk, readState, realDeps, rollback, stateDir, switchTo, sync, unpin } from "./omp-sdk";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const ci = args.indexOf("--config");
const configPath = ci >= 0 ? args[ci + 1]! : defaultConfigPath();

async function load() {
  try { return await loadConfig(configPath); }
  catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); process.exit(78); }
    throw e;
  }
}

switch (cmd) {
  case "install":
    await install(configPath, { start: !args.includes("--no-start") });
    break;
  case "uninstall":
    await uninstall();
    break;
  case "start": case "stop": case "restart":
    await control(cmd);
    break;
  case "logs":
    process.exitCode = await logs(args.includes("sync") ? "sync" : "gateway", args.includes("-f") || args.includes("--follow"));
    break;
  case "mod-path":
    console.log(modDir());
    break;
  case "version": case "--version": case "-v":
    console.log(version());
    break;
  case "serve":
    await main(configPath);
    break;
  case "check": {
    const c = await load();
    const o = (k: string) => `[${c.origins[k] ?? "ours"}]`;
    console.log(`ok: ${c.path}`);
    console.log(`socket: ${c.gateway.socket}`);
    console.log(c.omp ? `omp: native via SDK ${c.ompRuntime!.version} from ${c.omp.dir}; ${c.ompProviders.length} providers route (${c.omp.providers ? "restricted" : "all but anthropic"}); fallbackChains: ${c.omp.fallbackChains}; agents: ${c.omp.agents.join(", ") || "none"}` : "omp: off (no omp block)");
    if (c.omp) {
      console.log(`omp providers: ${c.ompProviders.join(", ")}`);
      for (const l of describeSdk(readState())) console.log(l);
    }
    for (const p of Object.keys(c.providers)) console.log(`provider ${p} ${o(`provider ${p}`)}: ${c.providers[p]!.api} ${c.providers[p]!.baseUrl}`);
    for (const [id, chain] of Object.entries(c.chains)) console.log(`model ${id} ${o(`model ${id}`)}: ${chain.map(t => t.ref).join(" -> ")}${chain.length > 1 ? ` (chain ${o(`chain ${id}`)})` : ""}`);
    for (const [id, m] of Object.entries(c.ompModels)) if (m.subscription) console.log(`note: ${id} is served by a subscription login in omp`);
    const t = c.timeouts;
    console.log(`timeouts: firstEvent ${t.streamFirstEventTimeoutSeconds}s ${o("timeouts.streamFirstEventTimeoutSeconds")}, idle ${t.streamIdleTimeoutSeconds}s ${o("timeouts.streamIdleTimeoutSeconds")}, total ${t.totalTimeoutSeconds || "off"}`);
    console.log(`retry: maxRetries ${c.retry.maxRetries} ${o("retry.maxRetries")}, rateLimitWalksChain ${c.retry.rateLimitWalksChain} ${o("retry.rateLimitWalksChain")}, cooldown ${c.retry.cooldownSeconds}s`);
    for (const a of c.agents) console.log(`agent subagent-models:${a.name} ${o(`agent ${a.name}`)}: ${a.model}${a.effort ? ` (effort ${a.effort})` : ""}`);
    for (const w of c.warnings) console.log(`warning: ${w}`);
    break;
  }
  case "mod-config": {
    try { console.log(JSON.stringify({ ok: true, config: modView(await loadConfig(configPath)) })); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: (e as Error).message })); }
    break;
  }
  case "status": {
    console.log(await serviceState());
    const c = await load();
    try {
      const r = await fetch("http://gateway/status", { unix: c.gateway.socket } as RequestInit);
      console.log(JSON.stringify(await r.json(), null, 2));
    } catch (e) {
      console.error(`the gateway is not answering on ${c.gateway.socket}: ${(e as Error).message}\n  ${statusHint()}`);
      process.exit(1);
    }
    break;
  }
  case "omp-sdk": {
    const sub = args[1] ?? "status";
    if (sub === "sync") {
      const st = await sync(realDeps(), { force: args.includes("--force") });
      for (const l of describeSdk(st)) console.log(l);
      // A failed or waiting sync is not a failed unit: the gateway keeps serving, the timer retries.
      process.exitCode = 0;
    } else if (sub === "rollback") {
      const st = rollback();
      console.log(`switched to ${st.current} (was ${st.previous}), pinned while omp stays ${st.pinned?.whileOmp}; the gateway picks it up within seconds`);
    } else if (sub === "unpin") {
      unpin();
      console.log("unpinned: the next sync follows the installed omp");
    } else if (sub === "use") {
      const st = switchTo(args[2] ?? "");
      console.log(`switched to ${st.current}`);
    } else {
      for (const l of describeSdk(readState())) console.log(l);
    }
    break;
  }
  case "omp-find": {
    const c = await load();
    const id = args[1] ?? "";
    const slash = id.indexOf("/");
    const m = c.ompRuntime && slash > 0 ? c.ompRuntime.find(id.slice(0, slash), id.slice(slash + 1)) : undefined;
    console.log(m ? JSON.stringify({ ...m, routes: c.ompProviders.includes(m.provider) }) : `omp resolves no model ${id}`);
    break;
  }
  case "key-check": {
    const c = await load();
    const p = c.providers[args[1] ?? ""];
    if (!p) { console.error(`no provider ${args[1]} (providers: ${Object.keys(c.providers).join(", ")})`); process.exit(2); }
    try {
      const k = await new KeyStore(() => c).get(p, { fresh: true });
      console.log(k ? `ok: providers.${p.name}.apiKey resolved (${k.length} characters)` : `providers.${p.name} has no apiKey`);
    } catch (e) { console.error((e as Error).message); process.exit(1); }
    break;
  }
  default:
    console.log(`subagent-models ${version()}

service:  install [--no-start] | uninstall | start | stop | restart | status | logs [sync] [-f]
config:   check | key-check PROVIDER | mod-path | omp-find PROVIDER/MODEL
omp SDK:  omp-sdk status | sync [--force] | rollback | unpin | use VERSION
other:    serve (foreground) | mod-config | version

Every command takes --config FILE (default ${configPath}).`);
}

// omp's SDK keeps timers and database handles open; a one-shot command ends here.
if (cmd !== "serve") process.exit(process.exitCode ?? 0);
