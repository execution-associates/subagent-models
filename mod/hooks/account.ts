// Signing in to the gateway and editing its configuration, with no `$`: every call
// takes the fetch it should use, so tests run these directly.
//
// Sign-in is the OAuth 2.0 device authorization grant (RFC 8628): the gateway gives
// a user code and a link, the person approves it in a browser (on any machine:
// Claude Code may run in the cloud or over SSH), and polling the token endpoint then
// yields a gateway key, which the mod keeps and sends as `Authorization: Bearer`.

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>;

/** The hosted gateway: the default, and what the plugin is built around. */
export const HOSTED_GATEWAY = "https://llm-gateway.execution.associates";

export type DeviceStart = { deviceCode: string; userCode: string; url: string; expiresAt: number; intervalMs: number };
export type DevicePoll =
  | { kind: "pending"; intervalMs?: number }
  | { kind: "done"; apiKey: string; email: string | null }
  | { kind: "failed"; reason: "denied" | "expired" | "error"; message: string };

const json = (t: string): any => { try { return JSON.parse(t); } catch { return null; } };
const said = (j: any, status: number) =>
  (typeof j?.error_description === "string" && j.error_description) ||
  (typeof j?.error === "string" && j.error) ||
  (typeof j?.error?.message === "string" && j.error.message) ||
  `HTTP ${status}`;

export async function startDevice(fetch: Fetch, base: string, clientName: string): Promise<DeviceStart | { error: string }> {
  let r;
  try {
    r = await fetch(`${base}/api/device/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: clientName }) });
  } catch (e) {
    return { error: `the gateway at ${base} is not answering (${(e as Error)?.message ?? e})` };
  }
  const j = json(r.text);
  if (r.status !== 200 || typeof j?.device_code !== "string") return { error: `could not start the sign-in: ${said(j, r.status)}` };
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    url: j.verification_uri_complete ?? j.verification_uri,
    expiresAt: Date.now() + Number(j.expires_in ?? 900) * 1000,
    intervalMs: Math.max(1, Number(j.interval ?? 2)) * 1000,
  };
}

export async function pollDevice(fetch: Fetch, base: string, deviceCode: string): Promise<DevicePoll> {
  let r;
  try {
    r = await fetch(`${base}/api/device/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode }).toString(),
    });
  } catch {
    return { kind: "pending" }; // a dropped poll: try again on the next tick
  }
  const j = json(r.text);
  if (r.status === 200 && typeof j?.api_key === "string") return { kind: "done", apiKey: j.api_key, email: typeof j.email === "string" ? j.email : null };
  switch (j?.error) {
    case "authorization_pending": return { kind: "pending" };
    case "slow_down": return { kind: "pending", intervalMs: 5000 };
    case "access_denied": return { kind: "failed", reason: "denied", message: "The sign-in was denied in the browser." };
    case "expired_token": return { kind: "failed", reason: "expired", message: "The sign-in code expired before it was approved." };
  }
  if (r.status >= 500) return { kind: "pending" };
  return { kind: "failed", reason: "error", message: `the sign-in failed: ${said(j, r.status)}` };
}

// ---- the gateway's configuration API (llm-gateway's src/server/gateway/routes.ts)

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type { Agent, Api, Chain, Gateway, Model, Provider } from "../types";
import type { Agent, Api, Chain, Gateway, Provider } from "../types";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function call<T>(fetch: Fetch, base: string, key: string, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let r;
  try {
    r = await fetch(`${base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `the gateway at ${base} is not answering (${(e as Error)?.message ?? e})` };
  }
  const j = json(r.text);
  if (r.status >= 200 && r.status < 300) return { ok: true, data: j as T };
  return { ok: false, status: r.status, error: said(j, r.status) };
}

export async function loadGateway(fetch: Fetch, base: string, key: string): Promise<ApiResult<Gateway>> {
  const [p, a, c] = await Promise.all([
    call<Provider[]>(fetch, base, key, "GET", "/providers"),
    call<Agent[]>(fetch, base, key, "GET", "/agents"),
    call<Chain[]>(fetch, base, key, "GET", "/chains"),
  ]);
  for (const r of [p, a, c]) if (!r.ok) return r;
  return { ok: true, data: { providers: (p as any).data, agents: (a as any).data, chains: (c as any).data } };
}

/** Providers a person is likely to have a key for; any other OpenAI- or Anthropic-compatible API is "custom". */
export const PRESETS: { id: string; label: string; name: string; api: Api; baseUrl: string }[] = [
  { id: "openrouter", label: "OpenRouter", name: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", label: "OpenAI", name: "openai", api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", name: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" },
  { id: "moonshot", label: "Moonshot (Kimi)", name: "moonshot", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" },
  { id: "zai", label: "Z.ai (GLM)", name: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/paas/v4" },
  { id: "groq", label: "Groq", name: "groq", api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "cerebras", label: "Cerebras", name: "cerebras", api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  { id: "xai", label: "xAI (Grok)", name: "xai", api: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  { id: "gemini", label: "Google Gemini", name: "gemini", api: "openai-completions", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "together", label: "Together", name: "together", api: "openai-completions", baseUrl: "https://api.together.xyz/v1" },
  { id: "fireworks", label: "Fireworks", name: "fireworks", api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { id: "custom", label: "Other (OpenAI- or Anthropic-compatible)", name: "", api: "openai-completions", baseUrl: "" },
];

/** The ids a model list offers that match a filter, best first: exact, prefix, then substring. */
export function matching(ids: string[], filter: string, limit: number): string[] {
  const f = filter.trim().toLowerCase();
  if (!f) return ids.slice(0, limit);
  const scored = ids
    .map(id => { const l = id.toLowerCase(); return { id, s: l === f ? 0 : l.startsWith(f) ? 1 : l.includes(f) ? 2 : 9 }; })
    .filter(x => x.s < 9)
    .sort((a, b) => a.s - b.s || a.id.length - b.id.length);
  return scored.slice(0, limit).map(x => x.id);
}

/** A model id as the gateway takes it in a provider's list: the key is the upstream id, `/` and all. */
export const modelKey = (upstream: string) => upstream.replace(/[^A-Za-z0-9._\-/]/g, "-").slice(0, 120);

/** A chain typed as text: entries split on commas, spaces or arrows. */
export const parseTargets = (text: string) => text.split(/[\s,]+|->|→/).map(s => s.trim()).filter(Boolean);
