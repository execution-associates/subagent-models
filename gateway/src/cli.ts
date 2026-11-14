#!/usr/bin/env bun
// subagent-models gateway CLI.
//   serve [--config FILE]        run the gateway (what the systemd unit runs)
//   check [--config FILE]        validate the config and print what it defines
//   mod-config [--config FILE]   the config as the Claude Code mod reads it (JSON, no keys)
//   status [--config FILE]       ask the running gateway for models, chains, cooldowns, recent requests
//   key-check PROVIDER           resolve a provider's key and say whether it worked (never prints it)
import { ConfigError, defaultConfigPath, loadConfig, modView } from "./config";
import { KeyStore } from "./keys";
import { main } from "./server";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const ci = args.indexOf("--config");
const configPath = ci >= 0 ? args[ci + 1]! : defaultConfigPath();

function load() {
  try { return loadConfig(configPath); }
  catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); process.exit(78); }
    throw e;
  }
}

switch (cmd) {
  case "serve":
    await main(configPath);
    break;
  case "check": {
    const c = load();
    const o = (k: string) => `[${c.origins[k] ?? "ours"}]`;
    console.log(`ok: ${c.path}`);
    console.log(`socket: ${c.gateway.socket}`);
    console.log(c.omp ? `omp: importing from ${c.omp.dir} (providers: ${c.omp.providers.join(", ") || "none"}; fallbackChains: ${c.omp.fallbackChains}; timeouts: ${c.omp.timeouts}; agents: ${c.omp.agents.join(", ") || "none"})` : "omp: off (no omp block)");
    for (const p of Object.keys(c.providers)) console.log(`provider ${p} ${o(`provider ${p}`)}: ${c.providers[p]!.api} ${c.providers[p]!.baseUrl}`);
    for (const [id, chain] of Object.entries(c.chains)) console.log(`model ${id} ${o(`model ${id}`)}: ${chain.map(t => t.ref).join(" -> ")}${chain.length > 1 ? ` (chain ${o(`chain ${id}`)})` : ""}`);
    const t = c.timeouts;
    console.log(`timeouts: firstEvent ${t.streamFirstEventTimeoutSeconds}s ${o("timeouts.streamFirstEventTimeoutSeconds")}, idle ${t.streamIdleTimeoutSeconds}s ${o("timeouts.streamIdleTimeoutSeconds")}, total ${t.totalTimeoutSeconds || "off"}`);
    console.log(`retry: maxRetries ${c.retry.maxRetries} ${o("retry.maxRetries")}, rateLimitWalksChain ${c.retry.rateLimitWalksChain} ${o("retry.rateLimitWalksChain")}, cooldown ${c.retry.cooldownSeconds}s`);
    for (const a of c.agents) console.log(`agent subagent-models:${a.name} ${o(`agent ${a.name}`)}: ${a.model}${a.effort ? ` (effort ${a.effort})` : ""}`);
    for (const w of c.warnings) console.log(`warning: ${w}`);
    break;
  }
  case "mod-config": {
    try { console.log(JSON.stringify({ ok: true, config: modView(loadConfig(configPath)) })); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: (e as Error).message })); }
    break;
  }
  case "status": {
    const c = load();
    try {
      const r = await fetch("http://gateway/status", { unix: c.gateway.socket } as RequestInit);
      console.log(JSON.stringify(await r.json(), null, 2));
    } catch (e) {
      console.error(`the gateway is not answering on ${c.gateway.socket}: ${(e as Error).message}\n  systemctl --user status subagent-models`);
      process.exit(1);
    }
    break;
  }
  case "key-check": {
    const c = load();
    const p = c.providers[args[1] ?? ""];
    if (!p) { console.error(`no provider ${args[1]} (providers: ${Object.keys(c.providers).join(", ")})`); process.exit(2); }
    try {
      const k = await new KeyStore(() => c).get(p, { fresh: true });
      console.log(k ? `ok: providers.${p.name}.apiKey resolved (${k.length} characters)` : `providers.${p.name} has no apiKey`);
    } catch (e) { console.error((e as Error).message); process.exit(1); }
    break;
  }
  default:
    console.log("usage: cli.ts serve|check|mod-config|status|key-check PROVIDER [--config FILE]");
}
