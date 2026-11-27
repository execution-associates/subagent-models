// The values the mod keeps in $.state (the pane draws from them). The gateway's
// shapes are repeated from hooks/account.ts: a contract names nothing outside it.

export type Api = "openai-completions" | "anthropic-messages";
export type Model = { id: string; key: string; name: string; contextWindow: number; maxTokens: number };
export type Provider = { id: string; name: string; api: Api; baseUrl: string; keyLast4: string; models: Model[] };
export type Agent = { id: string; name: string; model: string; effort: string | null; description: string; prompt: string | null };
export type Chain = { model: string; targets: string[] };
export type Gateway = { providers: Provider[]; agents: Agent[]; chains: Chain[] };

export type Auth =
  /** The gateway on this machine, configured in its YAML file. */
  | { kind: "local"; path: string }
  /** A remote gateway with a key from the settings or SUBAGENT_MODELS_API_KEY. */
  | { kind: "key"; base: string }
  | { kind: "signed-out"; base: string }
  /** A device sign-in waiting for the person to approve it in a browser. */
  | { kind: "device"; base: string; userCode: string; url: string; expiresAt: number }
  | { kind: "signed-in"; base: string; email: string | null };

export type Edit =
  | null
  | { kind: "agent"; id: string | null; name: string; model: string; effort: string; description: string; prompt: string }
  | { kind: "provider-new"; preset: string; name: string; api: Api; baseUrl: string; apiKey: string; available: string[] | null; filter: string; picked: string[] }
  | { kind: "provider"; id: string; add: string }
  | { kind: "chain"; model: string; text: string };

export type PaneState = {
  auth: Auth;
  gateway: Gateway | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  edit: Edit;
};

declare module "claude-code" {
  interface PluginState {
    "subagent-models": { pane: PaneState };
  }
}
