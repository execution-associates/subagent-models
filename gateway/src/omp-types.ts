// omp's shapes, as types only: the core (config-core.ts, chain.ts,
// omp-transport.ts) names them without reaching omp.ts or omp-runtime.ts, which
// need Bun and the file system.

export type OmpBlock = {
  dir: string;
  /** Optional restriction: only these omp providers route (default: all but `anthropic`). */
  providers: string[] | null;
  fallbackChains: boolean;
  agents: string[];
  versionCheck: "exact" | "warn";
};

export type Origin = "ours" | "omp" | "ours over omp";
export type Source = { path: string; mtimeMs: number };
/** A skipped entry; `about` names the chain or agent it concerns, so a warning about something our own file overrides can be dropped. */
export type OmpWarning = { about?: string; text: string };

/** What the gateway knows about one omp model. */
export type OmpModelInfo = {
  /** `<provider>/<model id>`, the id Claude Code sends. */
  id: string;
  provider: string;
  modelId: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  /** A subscription login (ChatGPT, Claude, ...) rather than an API key. */
  subscription: boolean;
  hasAuth: boolean;
};

/** pi-ai's streaming events, as far as the gateway reads them. */
export type OmpEvent =
  | { type: "start" }
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_end"; contentIndex: number; content: string; partial?: { content?: any[] } }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: OmpAssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: OmpAssistantMessage }
  | { type: string; [k: string]: unknown };

export type OmpAssistantMessage = {
  content: any[];
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
  errorMessage?: string;
  errorStatus?: number;
};

export type OmpStreamOptions = {
  signal: AbortSignal;
  reasoning?: string;
  disableReasoning?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  sessionId?: string;
};

export interface OmpRuntime {
  readonly version: string;
  /** The SDK copy's directory (tests: anything). */
  readonly dir?: string;
  /** Every provider omp has a model for. */
  providers(): string[];
  find(provider: string, modelId: string): OmpModelInfo | undefined;
  /** Streams one model call. `context` is pi-ai's Context (see omp-transport.ts). */
  stream(model: OmpModelInfo, context: unknown, options: OmpStreamOptions): AsyncIterable<OmpEvent>;
}
