// A fake omp runtime: a registry of models and a scripted transport.
import type { OmpEvent, OmpModelInfo, OmpRuntime, OmpStreamOptions } from "../src/omp-runtime";

export type Script = (ctx: any, o: OmpStreamOptions) => AsyncIterable<OmpEvent> | OmpEvent[];

export class FakeOmp implements OmpRuntime {
  version = "18.20.0";
  calls: { id: string; ctx: any; o: OmpStreamOptions }[] = [];
  scripts = new Map<string, Script[]>();
  constructor(public models: Partial<OmpModelInfo>[]) {}
  providers() { return [...new Set(this.models.map(m => m.provider!))].sort(); }
  find(provider: string, modelId: string): OmpModelInfo | undefined {
    const m = this.models.find(x => x.provider === provider && x.modelId === modelId);
    return m ? { id: `${provider}/${modelId}`, provider, modelId, name: modelId, api: "openai-completions", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], subscription: false, hasAuth: true, ...m } : undefined;
  }
  script(id: string, ...s: Script[]) { this.scripts.set(id, s); }
  stream(model: OmpModelInfo, ctx: unknown, o: OmpStreamOptions): AsyncIterable<OmpEvent> {
    this.calls.push({ id: model.id, ctx, o });
    const s = this.scripts.get(model.id)?.shift() ?? ok(`hello from ${model.id}`);
    const r = s(ctx, o);
    return (async function* () { yield* r as any; })();
  }
}

export const msg = (over: Record<string, unknown> = {}) => ({ content: [], usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 0 }, stopReason: "stop", ...over });
export const ok = (text: string): Script => () => [
  { type: "start" },
  { type: "thinking_start", contentIndex: 0 },
  { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
  { type: "thinking_end", contentIndex: 0, content: "hmm", partial: { content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "sig-1" }] } },
  { type: "text_start", contentIndex: 1 },
  { type: "text_delta", contentIndex: 1, delta: text },
  { type: "text_end", contentIndex: 1, content: text },
  { type: "done", reason: "stop", message: msg() },
] as any;
export const fail = (status: number, message: string): Script => () => [{ type: "start" }, { type: "error", reason: "error", error: msg({ errorStatus: status, errorMessage: message, stopReason: "error" }) }] as any;
export const hang: Script = (_c, o) => (async function* () { yield { type: "start" } as OmpEvent; await new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))); })();
