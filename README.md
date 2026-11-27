# subagent-models

Run Claude Code subagents on non-Claude models. A subagent whose `model` is a
configured id (say `deepseek/deepseek-v4-flash`) is launched with the ordinary Agent
tool and gets everything a native subagent gets: Claude Code's system prompt,
CLAUDE.md, every tool with its schema, deferred MCP tools, skills, reminders and
compaction. Only the model answering it changes.

Two parts: a **mod** (a Claude Code plugin) that routes requests for configured ids,
and a **gateway** that serves them from any OpenAI- or Anthropic-compatible API, with
retries and fallback chains. The gateway is [hosted](https://llm-gateway.execution.associates)
by default: install the plugin, run `/subagent-models`, sign in, and set up providers
and agents in its pane. You can also run the gateway yourself.

## Install

Needs Claude Code, on Linux or macOS. There are three ways to install, depending on
where the gateway runs:

| You want | Needs | Path |
| -- | -- | -- |
| the hosted gateway (the default) | nothing | [Hosted](#hosted) |
| the gateway on this machine, upgraded with one command | mise | [With mise](#with-mise) |
| the gateway on this machine, without mise | bun, git | [From a checkout](#from-a-checkout) |
| a gateway someone else runs | its URL and key | [Remote gateway only](#remote-gateway-only) |

### Hosted

```
/plugin marketplace add execution-associates/subagent-models
/plugin install subagent-models@subagent-models
/subagent-models
```

The pane signs you in with a code: open the link it shows, sign up or sign in, and
approve the code. Claude Code picks the sign-in up by itself and keeps it. Then, in
the same pane, add a provider (pick one, paste its API key, choose models) and an
agent on one of its models. Agents load at once as `subagent-models:<name>`.
`/subagent-models login`, `logout` and `status` do the same from the prompt where no
pane is shown. Provider keys are stored encrypted on the gateway; the mod keeps only
its own gateway key, in the plugin's store under `~/.claude`.

### With mise

```sh
mise use -g bun github:execution-associates/subagent-models
subagent-models install       # config, background service, started
$EDITOR ~/.config/subagent-models/config.yml
subagent-models check         # validate; prints models, chains and agents
```

### From a checkout

The gateway's only runtime is [bun](https://bun.sh), installed any way you like.

```sh
git clone https://github.com/execution-associates/subagent-models
subagent-models/bin/subagent-models install
$EDITOR ~/.config/subagent-models/config.yml
subagent-models/bin/subagent-models check
```

`install` links the checkout, so the service and the mod run that working tree, and an
upgrade is `git pull` then `install` again.

Either way, load the mod in Claude Code, in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.local/share/subagent-models/app/mod" } }
```

and call an agent from your config: `Agent(subagent_type: "subagent-models:<name>", …)`.

### Remote gateway only

With a gateway URL set, the mod loads everything from that gateway over HTTPS and runs
nothing locally. Give the plugin the gateway's URL and key, as in
[Remote sessions](#remote-sessions). [Claude desktop and claude.ai/code](#claude-desktop-and-claudeaicode)
has the settings for a cloud session.

<details>
<summary>Upgrades, one session, removal</summary>

- **Upgrade (mise):** `mise upgrade github:execution-associates/subagent-models`, then
  `subagent-models install` again. `install` is idempotent: it re-points
  `~/.local/share/subagent-models/app` at the new version, rewrites the service files
  and restarts the gateway. It never overwrites an existing config.
- **One session only:** `claude --plugin-dir ~/.local/share/subagent-models/app/mod`.
- **Remove:** `subagent-models uninstall` stops and removes the service and the link.
  Config and state stay.

</details>

## Run the daemon

`subagent-models install` registers the gateway as a per-user background service that
starts at login and restarts if it dies. The same commands work on both systems:

```sh
subagent-models status        # service state, then the gateway's chains, cooldowns, last 20 requests
subagent-models logs -f       # one line per request: agent, model -> served by, status, ttfb, usage
subagent-models restart       # only needed when gateway.socket changes; config edits apply live
subagent-models start | stop
```

| | Linux | macOS |
| -- | -- | -- |
| Service | systemd user unit `subagent-models.service` in `~/.config/systemd/user/` | launchd agent `subagent-models.gateway` in `~/Library/LaunchAgents/` |
| Logs | `journalctl --user -u subagent-models` | `~/Library/Logs/subagent-models/gateway.log` |
| Socket | `$XDG_RUNTIME_DIR/subagent-models/gateway.sock` | `~/.local/state/subagent-models/gateway.sock` |

The gateway listens on that Unix socket (mode 0600). It opens a TCP port only when
`gateway.listen` asks for one, and only on loopback (see [Remote sessions](#remote-sessions)).
`subagent-models serve` runs it in the foreground instead. Full request records,
including every attempt, are in `~/.local/state/subagent-models/access.jsonl`.

## Configure

One file: `~/.config/subagent-models/config.yml` (`$SUBAGENT_MODELS_CONFIG` overrides it
for both parts). [`config.example.yml`](config.example.yml) is the annotated reference,
and `install` starts you with a copy. Edits are picked up within ~3 s. A broken edit is
reported in the logs and in the Claude Code transcript, and the last good config stays
in force. Errors name the key path:
`retry.fallbackChains.acme/big-model[0]: acme/nope: no such model (configured: …)`.

<details>
<summary>Add a provider</summary>

```yaml
providers:
  acme:
    api: openai-completions          # POST {baseUrl}/chat/completions
    baseUrl: https://api.example.com/v1
    apiKey: ACME_API_KEY             # env var name, op://Vault/item/field, or "!command"
    compat: { maxTokensField: max_completion_tokens }
    models:
      big-model: { name: Big Model, input: [text, image], contextWindow: 262144, maxTokens: 65536, defaultLevel: high }
```

Every model is addressed as `<provider>/<model key>`, here `acme/big-model`.

- `api: anthropic-messages` posts to `{baseUrl}/v1/messages`. Its compat knobs:
  `authHeader` (`x-api-key`|`bearer`), `thinkingMode` (`budget`|`adaptive`|`none`),
  `thinkingBudgets`, `stripCacheControl`, `supportsMidConversationSystem`, `extraBody`.
- OpenAI compat knobs (provider level, overridable per model): `reasoningEffortMap`
  (level → value, `null` = send none), `supportsReasoningEffort`, `maxTokensField`,
  `reasoningContentField` (`reasoning_content`|`reasoning`), `replayReasoning`
  (`tool-calls`|`all`|`none`), `supportsMultipleSystemMessages`,
  `supportsUsageInStreaming`, `supportsToolChoice`, `extraBody`.
- Model fields: `name`, `upstreamId` (defaults to the key), `reasoning`, `input`,
  `contextWindow`, `maxTokens`, `defaultLevel`, `compat`, `timeouts`.
- `api: openai-responses` is reserved. The seam is `gateway/src/upstream.ts` (an
  adapter is an async generator yielding Anthropic events) plus `adapterFor` in
  `gateway/src/chain.ts`.

</details>

<details>
<summary>Keys</summary>

`apiKey` is one of:

- the **name of an environment variable**;
- `op://Vault/item/field`, read with `op read` (the service-account token comes from
  `secrets.opServiceAccountTokenFile`);
- `!shell command`, whose trimmed stdout is the key.

A literal key is refused. Keys live in the gateway's memory for
`secrets.keyCacheSeconds` and are fetched again at once after a 401/403. They are never
logged, and error text is scrubbed of known keys. `subagent-models key-check acme`
resolves one and prints only its length.

</details>

<details>
<summary>Add an agent</summary>

```yaml
agents:
  reviewer:
    model: acme/big-model:high
    description: Reviews a diff for bugs. Give it the diff or a path.
    # optional; any agent-definition field passes through:
    # prompt: |                      # default: the general-purpose agent's prompt
    # tools: [Read, Bash]           # default: every tool
    # disallowedTools, maxTurns, skills, mcpServers, permissionMode, memory, initialPrompt, autoCompactWindow
```

It is registered as `subagent-models:reviewer`. A plain `~/.claude/agents/*.md` (or
project `.claude/agents/*.md`) whose `model:` is a configured id works too: routing is
by the id in the request.

**Levels.** A suffix `:off :minimal :low :medium :high :xhigh :max` sets the reasoning
level. On an agent it becomes the agent's `effort` (Claude Code's scale starts at
`low`, so `off` and `minimal` run as `low`). On a chain entry it is used as written.
Otherwise the request's effort applies, else the model's `defaultLevel`.

**Reserved names.** Ids may not contain a Claude model name (`claude-…`), and the
provider name `anthropic` is reserved, so a routed id never collides with a real one.

</details>

<details>
<summary>Add a fallback</summary>

```yaml
retry:
  fallbackChains:
    acme/big-model:
      - acme/small-model:high
      - anthropic/claude-sonnet-5-5:medium     # a real Claude model, on the session's own login
```

See [fallback semantics](#how-it-works) for exactly when the chain is walked.

</details>

## omp-native mode

With an `omp:` block, the gateway uses [omp](https://omp.sh)'s model registry, logins
and transport, so anything omp can call is a subagent model, with no model list to keep:

```yaml
omp:
  dir: ~/.omp/agent            # omp's agent directory (default)
  # providers: [deepseek]      # optional restriction (default: every omp provider but anthropic)
  fallbackChains: true         # import omp's retry.fallbackChains, maxRetries, rateLimitWalksChain
  agents: []                   # omp agents/<name>.md to expose, by name
  versionCheck: warn           # warn (default) | exact: refuse omp models while omp and its SDK differ
```

> **macOS:** the omp SDK sync installs packages inside an [isb](https://github.com/execution-associates/isb)
> sandbox, so it is set up only where `isb` is on PATH. Without it, omp-native mode has no SDK to load.

<details>
<summary>What it uses from omp</summary>

- **Catalogue:** omp's built-in providers, `models.yml`, and discovered models. Every
  `<provider>/<model>` omp resolves routes here, e.g. `deepseek/deepseek-v4-flash`.
  `subagent-models omp-find provider/model` shows how one resolves.
- **Auth:** omp's auth store (`agent.db`): API keys, `!command` keys, and OAuth logins
  with refresh, shared safely with running omp sessions. The gateway never holds these
  keys in its own config.
- **Transport:** omp's `streamSimple`, so every API family omp speaks (OpenAI
  completions and Responses, Anthropic-compatible, Google, Bedrock, …). omp makes one
  HTTP attempt per call; the gateway's retries, timeouts, cooldowns and chains apply on top.
- **`anthropic/…` stays the Claude hand-back** on the Claude Code session's own login.
  omp's Anthropic credentials are never used, and the main session is never routed.
- **Your file wins.** A provider under `providers:` shadows omp's provider of the same
  name; a chain, agent or retry setting defined here replaces omp's. Timeouts are always
  ours. `check` labels everything `[ours]`, `[omp]` or `[ours over omp]`.
- Only omp's `config.yml` (chains) and the opted-in `agents/<name>.md` are read as files.
  omp agent prompts are written for omp's tools, so read one before exposing it.
  Unresolvable chain entries and agents pinned to Claude are skipped with a warning.
- Subscription logins (ChatGPT via `openai-codex`, a Claude subscription) route like
  any other provider; `check` flags them. Keep them out with `providers:`.

</details>

<details>
<summary>Keeping omp's SDK in step with omp</summary>

omp updates itself, so the gateway keeps its own copy of omp's SDK
(`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`) at the installed omp's version, with
no manual step.

- **Where:** `~/.local/share/subagent-models/omp-sdk/`, one directory per version
  (about 470 MB each, two kept), with `current`/`previous` links and `state.json`.
  `gateway/omp-sdk/` in git is the baseline (18.20.0), reused as the lockfile when the
  versions match.
- **Installed omp version:** read from the binary without running it (`/usr/local/bin/omp`,
  or `$SUBAGENT_MODELS_OMP_BIN`), else `~/.omp/agent/last-changelog-version`.
- **Sync:** checks both packages are on the official registry, installs exactly that
  version in a throwaway isb sandbox (`bun install --exact --ignore-scripts`), checks
  the lockfile integrity against the registry, verifies on the host in a separate
  process (loads, opens the auth store, lists models), then switches `current`
  atomically.
- **Triggers:** a change to the omp binary or its changelog marker, the gateway itself
  on a mismatch, and a 10-minute retry timer (`subagent-models-omp-sync.{path,timer}` on
  Linux, the `subagent-models.omp-sync` agent on macOS).
- **Failure is never an outage.** `current` stays, `state.json` records why, retries
  back off from 1 minute to 1 hour. While versions differ the gateway keeps serving
  with the SDK it has and logs one warning per reload.
- **Switching** loads the new copy beside the old one; requests in flight finish on the
  old one. If the new copy fails to load, the old one stays.

```sh
subagent-models omp-sdk status        # installed omp, SDK in use, sync phase, last error
subagent-models omp-sdk sync --force  # sync now, ignoring the backoff
subagent-models omp-sdk rollback      # back to `previous`, pinned until omp changes again
subagent-models omp-sdk unpin         # follow the installed omp again
subagent-models omp-sdk use 18.19.0   # switch to a verified version on disk
subagent-models logs sync
```

</details>

## Remote sessions

A Claude Code session can use a gateway that runs somewhere else: claude.ai/code in the
cloud, a second machine, or a team sharing one gateway. The mod then needs no local
config, gateway or bun. It loads the gateway's routing table from `GET /mod-config`
(polled every 30 s) and sends routed requests to the gateway's URL. Provider keys stay
with the gateway, and the session's Claude credentials are stripped as always.

### The hosted gateway

[llm-gateway.execution.associates](https://llm-gateway.execution.associates) runs the
gateway for you, and the mod uses it unless told otherwise. Sign in from
`/subagent-models` ([Hosted](#hosted)); using it means agreeing to provide usage
telemetry (see its privacy page). Providers, agents and fallback chains can be edited
in the pane or on the site. It serves providers reached with an API key; omp's
subscription logins need a gateway of your own.

### Settings

Tell the mod where the gateway is, in either place (the environment wins):

| Plugin setting | Environment variable | Value |
| -- | -- | -- |
| Gateway URL (`gatewayUrl`) | `SUBAGENT_MODELS_URL` | the gateway's HTTPS URL; unset, the local gateway when one is installed beside the mod, else the hosted one |
| Gateway key (`apiKey`) | `SUBAGENT_MODELS_API_KEY` | a key the gateway issued, sent as `Authorization: Bearer` |
| | `SUBAGENT_MODELS_ACCESS_ID`, `SUBAGENT_MODELS_ACCESS_SECRET` | a Cloudflare Access service token, for a gateway behind Access |

Claude Code asks for the plugin settings when the plugin is enabled. Change them later
in `/plugin`: Installed, subagent-models, Configure options. The gateway URL also has a
row in `/config`; the key, being secret, is kept in the system's credential store and
appears only there. Cloud sessions take the environment variables instead.

**Publishing your own gateway.** The gateway has no auth of its own, so put a gate in
front of it, for example a cloudflared tunnel behind Cloudflare Access with a service
token for the sessions:

```yaml
gateway:
  listen: 127.0.0.1:8110       # loopback only; the tunnel's origin
```

## Claude desktop and claude.ai/code

Only Claude Code sessions can use the mod, because it is a Claude Code plugin. Chat
conversations in the desktop app or on claude.ai have no subagents and load no plugins.

**Desktop app (the Code tab).** The Code tab runs Claude Code on your own machine, so
[Install](#install) applies unchanged: the same gateway service, and the same
`CLAUDE_CODE_PLUGIN_DIRS` entry in `~/.claude/settings.json`. An app launched from the
Dock does not read your shell profile, so `bun` from mise may not be on its `PATH`. The
mod falls back to a login shell, and if that also fails, set `SUBAGENT_MODELS_BUN` to
bun's full path (`command -v bun` in a terminal) in the same `env` block. The desktop app can also
use a remote gateway instead, the way the web app does.

**claude.ai/code (cloud sessions).** A cloud session runs in a fresh container with no
gateway, so it uses a [remote gateway](#remote-sessions):

1. Enable the plugin in the `.claude/settings.json` of the repo the session works on
   (a cloud session reads the repo's settings, not your home directory's):

   ```json
   {
     "extraKnownMarketplaces": {
       "subagent-models": { "source": { "source": "github", "repo": "execution-associates/subagent-models" } }
     },
     "enabledPlugins": { "subagent-models@subagent-models": true }
   }
   ```

2. A cloud container starts fresh each session, so a sign-in does not last past it
   (`/subagent-models login` works for the one session). To stay signed in, create a
   gateway key on the site and set it as `SUBAGENT_MODELS_API_KEY` in the cloud
   environment's settings (with `SUBAGENT_MODELS_URL` for a gateway other than the hosted
   one). Cloud sessions do not take plugin settings.
3. Allow the gateway's host (for example `llm-gateway.execution.associates`) in the
   environment's network access. It is the only host needed: provider keys and API
   hosts stay with the gateway.

> **Not yet verified:** whether cloud sessions run plugin hook modules (the mod's
> `http.fetch` hook) at all. Try it with one agent before relying on it.

## How it works

```
Claude Code ──http.fetch──▶ mod
   │                          │ body "model" is a configured id?
   │                          ├─ no  → request goes on to Anthropic untouched
   │                          └─ yes → same request, URL → Unix socket, credentials stripped
   │                                       ▼
   │                            gateway (Bun)
   │                              normalize → fallback chain → upstream adapter
   │◀──── Anthropic SSE stream ────────────┘
   │
   └─ chain reaches a Claude model → gateway answers 409 + x-subagent-models-claude-fallback
        → mod re-sends the ORIGINAL request to Anthropic with that model,
          on the session's own login (the gateway never holds a Claude credential)
```

The mod registers the config's agents at session start and re-reads the file when it
changes. It validates the YAML with the gateway's own code, so both agree.

<details>
<summary>What the gateway changes in the request</summary>

From `gateway/src/canonical.ts`:

| Engine sends | Gateway |
| -- | -- |
| `x-anthropic-billing-header` system block | dropped (it changes every prompt and would defeat prefix caching) |
| `"You are powered by the model <id>."` | the serving model's real name, id and provider |
| `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | "You are an agent running in Claude Code, Anthropic's agent harness." |
| `role: "system"` messages mid-conversation | `<system-reminder>` text in the next user turn, or a system message where the upstream supports it |
| `tool_addition` blocks | added to the upstream tool list |
| tools with `defer_loading` | sent only once a ToolSearch result names them |
| server tools (web search, advisor) | dropped (they run on Anthropic's side) |
| `thread` (message-threads beta) | refused, so Claude Code resends turns whole for that model |
| `thinking`, `output_config.effort` | a level, mapped per model |
| `context_management`, `diagnostics`, `metadata`, `cache_control`, … | dropped for OpenAI upstreams; `cache_control` kept for Anthropic-compatible ones unless `stripCacheControl` |
| thinking blocks | signed `smg1.…` so they replay only to the model that wrote them |
| images in tool results / user turns | OpenAI: moved to a following user turn; text-only models get a note |
| tool names OpenAI refuses | mapped to safe names and back |
| `/v1/messages/count_tokens` | estimated locally (characters / 3.6) |
| `stream: false` | streamed upstream, aggregated |

Responses become a normal Anthropic event stream with stop reasons and usage mapped
(cached tokens reported as `cache_read_input_tokens`). A stream that ends early is an
error, never a short answer. `ping` events go out every `pingIntervalSeconds` while
the upstream is quiet.

</details>

<details>
<summary>Fallback semantics</summary>

Vocabulary follows omp (`retry.maxRetries`, `retry.rateLimitWalksChain`,
`retry.fallbackChains`, `streamFirstEventTimeoutSeconds`, `streamIdleTimeoutSeconds`).

- A request's chain is `[its model, ...fallbackChains[its model]]`.
- Each model gets `1 + maxRetries` attempts (backoff `baseDelayMs·2^n`, capped at
  `maxDelayMs`) on connection errors, 5xx/529/408, first-event timeout, an unfinished
  stream, and 429 when `rateLimitWalksChain: false`. A 429 with
  `rateLimitWalksChain: true`, 401/403 (after one fresh key fetch) and 404 walk on at once.
- Walking away from a model cools it down for `cooldownSeconds` (a 429's `retry-after`
  wins). If every model is cooling, all are tried anyway. A success clears the cooldown.
- A context-length refusal comes back as Anthropic's `prompt is too long`, so Claude
  Code compacts. Other 400/422s are returned, not walked past (`walkOnClientErrors: true`
  changes that).
- **The switch happens only before the first event reaches Claude Code.** After that,
  a stall (`streamIdleTimeoutSeconds`) or error aborts the call, cools the model, and
  sends `overloaded_error`; Claude Code retries and the retry walks past it.
- **Claude entries** (`anthropic/<model>[:level]`) are handed back to the mod, which
  only accepts a Claude model its own copy of the config names in that chain.
- Every gateway error carries `x-should-retry: false` (it already retried) and names
  every attempt.

</details>

<details>
<summary>Fail closed</summary>

Nothing meant for another model is ever answered by Claude by accident.

- Mod not loaded: the id reaches Anthropic and fails `model_not_found`.
- Gateway down: the mod answers 503 naming the socket and `subagent-models status`.
- The routing hook itself fails: 503 for a configured id.
- A Claude hand-back the chain does not name is refused.
- No config at session start: the last good config keeps routing its ids, so they
  still fail loudly.

</details>

## Troubleshooting

<details>
<summary>Debugging, context windows, known gaps</summary>

**Debugging.** Set `gateway.captureDir` to dump each engine request and each translated
upstream body (conversation text: turn it off afterwards). `claude --debug` shows the
mod's `[subagent-models]` lines and `autocompact: … effectiveWindow=`.

**Context window.** Claude Code assumes a 1M window for an id it does not know.
`autoCompactWindow` can only lower that, so the mod sets it on config agents whose
`contextWindow` is under 1M (minimum 100K). A `.md` agent on a smaller model should set
`autoCompactWindow` itself.

**Known gaps.**

- Dollar costs are placeholders (`costBasis: "unknown"`); token counts are right.
  Tokens of a Claude fallback are booked under the routed id.
- `-p` runs print `[claude-code:unrecognized_model]` once on stderr.
- The first request per model per session costs one local round trip (the thread
  refusal), which `--debug` logs as an API error.
- `count_tokens` is an estimate. PDFs are replaced with a note; text documents are inlined.
- Server tools (Anthropic-side web search, advisor) are unavailable to routed agents.
- An agent removed from the config stays registered (hidden) until the mod reloads.
- The gateway's own adapters lack `openai-responses` (omp-native mode reaches it).
- Through omp's transport, tool-call arguments arrive whole rather than streamed.
- The default agent prompt is a copy of the general-purpose agent's and can drift.

</details>

## Development

<details>
<summary>Tests and releases</summary>

Run tests in a sandbox with only `gateway/` and `mod/` mounted:

```sh
bun test                       # gateway: translation goldens, config, chains, service files
claude plugin test mod         # mod: routing, Claude hand-back, registration
claude plugin validate mod
tsc -p mod
```

`gateway/src/core/` is the request path (config validation, chains, translation, the
`/v1/messages` handler) with no Bun, Node or file-system API, for running the gateway
inside a Cloudflare Worker; other projects import it as `subagent-models/core`.
`test/core-purity.test.ts` bundles it for the browser and fails on any runtime import.

**Release:** bump `version` in `mod/.claude-plugin/plugin.json`, then push a matching
tag (`v0.2.0`). The release workflow attaches the source archive that `mise use -g
github:execution-associates/subagent-models` installs.

</details>
