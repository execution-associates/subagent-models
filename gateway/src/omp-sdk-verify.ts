// Run by the SDK sync in its own process: can this SDK copy work here?
//   bun omp-sdk-verify.ts <sdk dir> <omp agent dir>
// Loads the SDK, opens omp's auth store and model registry (offline), and counts
// models. Prints one JSON line. Nothing is called over the network.
const [dir, agentDir] = process.argv.slice(2);
const out = (o: unknown) => { console.log(JSON.stringify(o)); process.exit((o as { ok: boolean }).ok ? 0 : 1); };
if (!dir || !agentDir) out({ ok: false, error: "usage: omp-sdk-verify.ts <sdk dir> <agent dir>" });
if (process.env.SUBAGENT_MODELS_SDK_VERIFY_FAULT) out({ ok: false, error: `injected fault (${process.env.SUBAGENT_MODELS_SDK_VERIFY_FAULT})` });
try {
  const agent = await import(`${dir}/node_modules/@oh-my-pi/pi-coding-agent/src/index.ts`);
  const ai = await import(`${dir}/node_modules/@oh-my-pi/pi-ai/src/index.ts`);
  if (typeof agent.discoverAuthStorage !== "function" || typeof agent.ModelRegistry !== "function" || typeof ai.streamSimple !== "function") out({ ok: false, error: "the SDK lacks discoverAuthStorage, ModelRegistry or streamSimple" });
  const auth = await agent.discoverAuthStorage(agentDir);
  const registry = new agent.ModelRegistry(auth);
  await registry.refresh("offline");
  out({ ok: true, models: registry.getAll("all").length, available: registry.getAvailable().length });
} catch (e) {
  out({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 400) });
}
export {};
