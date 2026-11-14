# subagent-models

Native Claude Code subagents on non-Claude models. A subagent whose `model` is a
configured id (for example `refuseless/deepseek-v4.1-flash-fast`) is launched with
the ordinary Agent tool, shows in the session's agent list, and gets exactly what a
native subagent gets: Claude Code's own system prompt, CLAUDE.md, the full tool list
with schemas, deferred MCP tools behind ToolSearch, skills, reminders and
compaction. Only the model answering it is different.

## How it works

```
Claude Code ──http.fetch──▶ mod (hooks/register.ts)
   │                          │ body "model" is a configured id?
   │                          ├─ no  → request goes on to Anthropic untouched
   │                          └─ yes → same request, URL → Unix socket, credentials stripped
   │                                       ▼
   │                            gateway (systemd user unit, Bun)
   │                              normalize → fallback chain → upstream adapter
   │                              openai-completions | anthropic-messages
   │◀──── Anthropic SSE stream ────────────┘
   │
   └─ gateway answers 409 + x-subagent-models-claude-fallback: <claude model>
        → mod re-sends the ORIGINAL request to Anthropic with that model,
          on the session's own login (the gateway never holds a Claude credential)
```

- **mod/** is a Claude Code plugin with one hooks module. `http.fetch` sees every
  model request the engine sends. A request for a configured id is re-aimed at the
  gateway's socket, body unchanged; any other request is passed on byte for byte.
  `session.start` registers the YAML's agents with `$.agent.register` and re-reads
  the YAML every 3 s when it changes. The YAML is validated by the gateway's own
  code (`bun gateway/src/cli.ts mod-config`), so the mod and the gateway agree.
- **gateway/** accepts Anthropic Messages requests (streaming and not) on
  `$XDG_RUNTIME_DIR/subagent-models/gateway.sock` (mode 0600) and serves them from
  the configured upstreams. It owns provider keys (memory only), retries, timeouts,
  cooldowns and fallback chains.

### What the gateway does to the engine's request (gateway/src/canonical.ts)

| Engine sends | Gateway |
| -- | -- |
| `x-anthropic-billing-header` system block | dropped (changes every prompt; would defeat upstream prefix caching) |
| `"You are powered by the model <id>."` | replaced with the serving model's real name, id and provider |
| `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | replaced with "You are an agent running in Claude Code, Anthropic's agent harness." |
| `role: "system"` messages mid-conversation | `<system-reminder>` text in the next user turn, or a system message where `supportsMultipleSystemMessages` / `supportsMidConversationSystem` |
| `tool_addition` blocks (tools loaded mid-conversation) | added to the upstream tool list |
| tools with `defer_loading` | sent only once a `tool_reference` (a ToolSearch result) names them; `DeferredToolPlaceholder` dropped |
| server tools (`type: web_search_…`, advisor) | dropped (they run on Anthropic's side) |
| `thread` (message-threads beta) | refused with `thread_unsupported_request`; Claude Code resends the turn whole and stays stateless on that model for the session |
| `thinking`, `output_config.effort` | a level (off…max), mapped per model (`reasoningEffortMap`, or a thinking budget) |
| `context_management`, `diagnostics`, `metadata` (device/account ids), `eager_input_streaming`, `cache_control` | dropped for OpenAI upstreams; `cache_control` kept for Anthropic-compatible ones unless `stripCacheControl` |
| thinking blocks | ours carry signature `smg1.<base64 {m: model, s: upstream signature}>`; sent back as `reasoning_content` (OpenAI) or with the upstream's own signature to the same model (Anthropic-compatible); Claude's and other models' are dropped |
| tool results with images, images in user turns | OpenAI: tool text in the `tool` message, images in a following user turn; text-only models get a note |
| tool names OpenAI refuses (`[A-Za-z0-9_-]{1,64}`) | mapped to safe names and back |
| `/v1/messages/count_tokens` | estimated locally (characters / 3.6) |
| `stream: false` | upstream streamed, aggregated into one Message |

Responses: OpenAI chunks become `message_start`, strictly sequential content blocks
(thinking with a `signature_delta`, text, one `tool_use` per call with
`input_json_delta`), `message_delta` with stop reason (`tool_calls`→`tool_use`,
`length`→`max_tokens`, `content_filter`→`refusal`) and usage (cached tokens moved
from `input_tokens` to `cache_read_input_tokens`; DeepSeek's `prompt_cache_hit_tokens`
read too), `message_stop`. A stream that ends without finishing is an error, never a
short answer. `ping` events go out every `pingIntervalSeconds` while the upstream is quiet.

## Model ids, agents, levels

- Every model in the YAML is `<provider>/<model key>`: `refuseless/deepseek-v4.1-flash-fast`.
  Claude Code sends that id verbatim. Ids may not contain a Claude model name
  (`claude-…`), and the provider name `anthropic` is reserved, so a routed id never
  collides with a real Anthropic id: if the mod is not loaded, Anthropic answers
  `model_not_found` (404) and nothing is answered by Claude.
- YAML agents are registered as `subagent-models:<name>` (`subagent-models:deepseek-flash`).
  A plain `~/.claude/agents/*.md` (or project `.claude/agents/*.md`) whose `model:` is
  a configured id works the same way; routing is by the id in the request.
- A level suffix (`:off :minimal :low :medium :high :xhigh :max`) picks the reasoning
  level where a model is named in an agent or a chain entry. For an agent it becomes
  the agent's `effort` (Claude Code's scale starts at `low`, so `off`/`minimal` there
  run as `low`); a chain entry's level is used as written. Otherwise the request's
  effort is used, else the model's `defaultLevel`.

## Configuration

One file: `~/.config/subagent-models/config.yml` (`$SUBAGENT_MODELS_CONFIG` overrides,
for both the gateway and the mod), optionally using omp's models and logins (see omp-native mode). `config.example.yml` is the annotated reference;
the live file starts as a copy of it. Edits are picked up within ~3 s by the gateway
and the mod. A broken edit is reported (`journalctl --user -u subagent-models`, and
a line in the Claude Code transcript) and the last good config stays in force.

```sh
bun ~/projects/exa/subagent-models/gateway/src/cli.ts check            # validate, print chains and agents
bun ~/projects/exa/subagent-models/gateway/src/cli.ts key-check refuseless   # resolve a key (prints its length only)
```

Errors name the key path, for example
`retry.fallbackChains.refuseless/deepseek-v4.1-flash-fast[0]: refuseless/nope: no such model (configured: …)`.

### Keys

`apiKey` is one of: `op://Vault/item/field` (read with `op read`, with
`OP_SERVICE_ACCOUNT_TOKEN` taken from `secrets.opServiceAccountTokenFile`), a
`!shell command` (its trimmed stdout, omp-style), or the name of an environment
variable. A literal key is refused. Keys live in the gateway's memory for
`secrets.keyCacheSeconds` and are fetched again at once after a 401/403. They are
never logged; error text is scrubbed of known keys.

The Refuseless key is `op://Agents/refuseless_api_key/credential` with the token
file `~/.config/op/token`: the same read omp does.

### Add a provider

```yaml
providers:
  someprovider:
    api: openai-completions          # POST {baseUrl}/chat/completions
    baseUrl: https://api.example.com/v1
    apiKey: SOMEPROVIDER_API_KEY     # or op://… or "!command"
    compat: { maxTokensField: max_completion_tokens }
    models:
      big-model: { name: Big Model, input: [text, image], contextWindow: 262144, maxTokens: 65536, defaultLevel: high }
```

`api: anthropic-messages` posts to `{baseUrl}/v1/messages` (compat: `authHeader`
`x-api-key`|`bearer`, `thinkingMode` `budget`|`adaptive`|`none`, `thinkingBudgets`,
`stripCacheControl`, `supportsMidConversationSystem`, `extraBody`).
`api: openai-responses` is reserved: the seam is `gateway/src/upstream.ts`
(an adapter is an async generator yielding Anthropic events and throwing
`UpstreamError`) plus `adapterFor` in `gateway/src/chain.ts`.

OpenAI compat knobs (provider level, overridable per model): `reasoningEffortMap`
(level → value, `null` = send none), `supportsReasoningEffort`, `maxTokensField`,
`reasoningContentField` (`reasoning_content`|`reasoning`), `replayReasoning`
(`tool-calls`|`all`|`none`), `supportsMultipleSystemMessages`,
`supportsUsageInStreaming`, `supportsToolChoice`, `extraBody`.
Model fields: `name`, `upstreamId` (defaults to the key), `reasoning`, `input`,
`contextWindow`, `maxTokens`, `defaultLevel`, `compat`, `timeouts`.

### Add an agent

```yaml
agents:
  reviewer:
    model: refuseless/deepseek-v4.1-flash-fast:high
    description: Reviews a diff for bugs, on DeepSeek. Give it the diff or a path.
    # optional; any agent-definition field passes through:
    # prompt: |                      # default: the general-purpose agent's prompt
    #   You are …
    # tools: [Read, Bash]           # default: every tool
    # disallowedTools, maxTurns, skills, mcpServers, permissionMode, memory, initialPrompt, autoCompactWindow
```

### Add a fallback

```yaml
retry:
  fallbackChains:
    refuseless/deepseek-v4.1-flash-fast:
      - refuseless/glm-5.3-flash-abliterated:high
      - anthropic/claude-sonnet-5-5:medium     # a real Claude model, served by the mod
```

## omp-native mode

With an `omp:` block, the gateway uses [omp](https://omp.sh)'s own machinery for
models, auth and transport, so anything omp can call is a subagent model here:

```yaml
omp:
  dir: ~/.omp/agent            # omp's agent directory (default)
  # providers: [refuseless, deepseek]   # optional restriction (default: every omp provider but anthropic)
  fallbackChains: true         # import omp's retry.fallbackChains, maxRetries, rateLimitWalksChain
  agents: []                   # omp agents/<name>.md to expose, by name
  versionCheck: warn           # warn (default) | exact (see below)
```

- **Catalogue:** omp's model registry: its built-in providers, `models.yml`, and the
  models omp discovered. Every `<provider>/<model>` it resolves routes here with no
  list to keep, e.g. `refuseless/deepseek-v4.1-flash-fast` or omp's built-in
  `deepseek/deepseek-v4-flash`. `cli.ts omp-find provider/model` shows how one resolves.
- **Auth:** omp's auth store (`agent.db`, through omp's own `AuthStorage`): API keys,
  `!command` keys and OAuth logins with refresh. omp refreshes tokens under a lease
  shared across processes, so running omp sessions and the gateway use it side by side.
  The gateway never sees a key in its own config for these providers.
- **Transport:** omp's `streamSimple`, i.e. every API family omp speaks (OpenAI
  completions and Responses, Anthropic-compatible, Google, Bedrock, ...). The gateway
  translates Claude Code's Anthropic Messages requests to omp's model-call format and
  back; omp makes one HTTP attempt per call (`maxHttpAttempts: 1`) and our retries,
  timeouts, cooldowns and fallback chains apply on top.
- **`anthropic/…` stays the Claude hand-back** on the Claude Code session's own login;
  omp's Anthropic credentials are never used, and the main session is never routed.
- **Our file still wins.** A provider defined under `providers:` (with `baseUrl` and
  `models`) is served by this gateway's own adapters and shadows omp's provider of the
  same name entirely. A chain, an agent or a retry setting defined here replaces omp's.
  Timeouts are always ours (omp's `providers.stream*TimeoutSeconds` apply to all its
  providers at once). `check` prints every routed model, chain, agent and setting with
  its origin: `[ours]`, `[omp]`, `[ours over omp]`.
- **What is read as files:** only omp's `config.yml` (chains) and the opt-in
  `agents/<name>.md`. omp agent prompts are written for omp's tools, not Claude Code's;
  read one before exposing it (omp-only frontmatter such as `tools` is ignored).
  Chain entries that do not resolve (no such model, a restricted provider) and agents
  pinned to Claude are skipped with a warning.
- **Subscription logins** (ChatGPT via `openai-codex`, a Claude subscription) route
  like any other omp provider; `check` notes any model a config names that is served
  by one. Restrict with `providers:` to keep them out.

### omp's SDK: kept in step with omp automatically

omp-native mode runs omp's SDK (`@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-ai`).
omp is a compiled binary that updates itself, so the gateway runs its own copy, and
that copy follows the installed omp version with no manual step:

- **State** (machine state, never in git): `~/.local/share/subagent-models/omp-sdk/`:
  one directory per version (`package.json`, `bun.lock`, `node_modules/`, `natives/`,
  `verified.json` with the packages' integrity and the model count it saw),
  `current` and `previous` links, and `state.json` (installed omp, sync phase,
  last error, next retry).
- **Tracked in git:** `gateway/omp-sdk/package.json` + `bun.lock`, the baseline the
  code was written and tested against (18.20.0), reused as the lockfile when the
  installed omp is that version, and the sync code. A fresh clone bootstraps itself:
  the gateway finds no SDK, starts the sync, and serves omp models once it is done.
- **Installed omp version:** read from the binary without running it (the single
  `omp/<version>` marker in `/usr/local/bin/omp`, cached by size and mtime), else
  `~/.omp/agent/last-changelog-version`.
- **Sync** (`bun gateway/src/cli.ts omp-sdk sync`, run by
  `subagent-models-omp-sync.service`): if no verified copy of the installed version
  exists, it checks both packages are published on the official registry, installs
  exactly that version in a throwaway isb sandbox that sees only a staging directory
  (`bun install --exact --ignore-scripts`; the baseline lockfile with
  `--frozen-lockfile` when versions match), checks the lockfile's integrity for both
  packages against the registry's, then **verifies on the host** in a separate process
  (the SDK loads, opens omp's auth store, lists models) and only then switches
  `current` atomically. The old version becomes `previous`; older ones are pruned.
  A version already verified on disk (a downgrade, a re-update) is switched to at once.
- **Triggers:** `subagent-models-omp-sync.path` (changes to `/opt/omp/bin/omp`,
  `/usr/local/bin/omp`, `~/.omp/agent/last-changelog-version`), the gateway itself
  when it sees a version mismatch or no SDK, and `subagent-models-omp-sync.timer`
  (every 10 minutes) for retries.
- **Failure is never an outage:** not published yet, registry or network down, an
  integrity mismatch, a failed verification: `current` stays as it was, `state.json`
  records the cause, retries back off from 1 minute to 1 hour.
- **Skew is served, not refused:** while omp and the SDK differ, the gateway keeps
  serving with the SDK it has (omp's auth store reads across versions; an older SDK
  logs a warning on a newer store and carries on), logs one warning per reload, and
  starts the sync. `omp.versionCheck: exact` refuses omp-routed models while they
  differ instead.
- **The switch:** the gateway watches `current`; when it changes it loads the new
  copy beside the old one and new requests use it, while requests in flight finish on
  the old one. If the new copy fails to load, the gateway keeps the old one.
- Each copy keeps its native addon in its own `natives/` (`PI_NATIVES_DIR`), never
  in `~/.omp/natives`, which omp prunes on update and which an SDK would prune.

```sh
bun gateway/src/cli.ts omp-sdk status        # installed omp, SDK in use, sync phase, last error
bun gateway/src/cli.ts omp-sdk sync --force  # sync now, ignoring the backoff
bun gateway/src/cli.ts omp-sdk rollback      # back to `previous`
bun gateway/src/cli.ts omp-sdk use 18.19.0   # switch to a verified version on disk
journalctl --user -u subagent-models-omp-sync -e
```

What runs where: the package fetch and unpack run in the isb sandbox; the
verification and the gateway run omp's SDK on the host, as omp itself does, because
they need omp's auth store. Disk: about 600 MB per version (two kept).

## Fallback semantics

Vocabulary follows omp (`retry.maxRetries`, `retry.rateLimitWalksChain`,
`retry.fallbackChains`, `streamFirstEventTimeoutSeconds`, `streamIdleTimeoutSeconds`).

- A request's chain is `[its model, ...fallbackChains[its model]]`.
- Each model gets `1 + maxRetries` attempts (backoff `baseDelayMs·2^n`, capped at
  `maxDelayMs`) on: connection errors, 5xx/529/408, first-event timeout, a stream
  that ends before it finishes, and 429 when `rateLimitWalksChain: false` (honouring
  `retry-after` up to `maxDelayMs`). 429 with `rateLimitWalksChain: true`, 401/403
  (after one fresh key fetch) and 404 walk on at once.
- Walking away from a model puts it in cooldown for `cooldownSeconds` (a 429's
  `retry-after` wins); later requests skip it. If every model is cooling, they are
  all tried anyway rather than refused. A success clears the model's cooldown.
- A context-length refusal is returned as Anthropic's `prompt is too long` wording,
  which Claude Code answers by compacting. Other 400/422s are returned, not walked
  past (`walkOnClientErrors: true` changes that).
- `streamFirstEventTimeoutSeconds` covers connect, headers and the first chunk.
  `totalTimeoutSeconds` (0 = off) bounds the whole walk.
- **The switch happens only before the first event is committed to Claude Code.**
  Once a model has produced an event, the response is that model's.
- **Mid-stream stall or error** (no data for `streamIdleTimeoutSeconds`, or an upstream
  error after the first event): the upstream call is aborted, the model goes into
  cooldown, and Claude Code receives an `overloaded_error` event. Claude Code discards
  the partial answer and retries the request (as `stream: false`), and the retry walks
  the chain past the stalled model. A `stream: false` request has committed nothing
  until the end, so a stall there walks the chain directly.
- **Claude entries.** When the walk reaches `anthropic/<model>[:level]`, the gateway
  answers 409 with `x-subagent-models-claude-fallback: <model>` (and
  `x-subagent-models-effort`). The mod checks that its own copy of the config names
  that Claude model in this id's chain, then re-sends the original engine request to
  Anthropic with the model (and effort) swapped, foreign thinking blocks removed and
  the identity line naming the Claude model. The credential header the engine set
  stays valid because the request goes to the origin it was raised for.
- Every gateway error carries `x-should-retry: false` (the gateway already retried),
  so Claude Code shows it at once. The final error names every attempt.

## Fail closed

- Mod not loaded: the id reaches Anthropic and fails `model_not_found`.
- Gateway down or socket missing: the mod answers 503 `subagent-models: the gateway is
  not answering on <socket> (…). Nothing was sent to Claude. Check it with: systemctl
  --user status subagent-models …`.
- The routing hook itself fails: its `.catch` answers 503 for a configured id.
- A Claude hand-back for a model the chain does not name is refused.
- No config at session start: the last good config (kept in the mod's store) keeps
  routing its ids, so they still fail loudly instead of reaching Anthropic.

## Operating it

The gateway is the systemd user unit `subagent-models.service`
(`gateway/systemd/subagent-models.service`, linked into `~/.config/systemd/user/`).
It is a user unit rather than an isb deployment because it needs the host's
1Password service-account token and a socket in the user's runtime directory that
the Claude Code process opens; it listens on no TCP port.

```sh
systemctl --user status subagent-models
systemctl --user restart subagent-models          # needed only when gateway.socket changes
journalctl --user -u subagent-models -f           # one line per request: agent, model -> served by, status, ttfb, usage
bun ~/projects/exa/subagent-models/gateway/src/cli.ts status   # chains, cooldowns, last 20 requests
tail -f ~/.local/state/subagent-models/access.jsonl   # full records incl. every attempt
```

Debugging: set `gateway.captureDir` to dump each engine request and each translated
upstream body (conversation text: turn it off afterwards). `claude --debug` shows the
mod's lines (`[subagent-models] $.ui.log: …`), the engine's `[tether]` line for the
thread refusal, and `autocompact: … effectiveWindow=` for the compaction window.

Install the unit on a new host:

```sh
mkdir -p ~/.config/subagent-models ~/.config/systemd/user
cp ~/projects/exa/subagent-models/config.example.yml ~/.config/subagent-models/config.yml
ln -s ~/projects/exa/subagent-models/gateway/systemd/subagent-models.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now subagent-models
```

## Loading the mod

For one session: `claude --plugin-dir ~/projects/exa/subagent-models/mod`.

For every session, either:

1. Add to `~/.claude/settings.json`: `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/projects/exa/subagent-models/mod" }`
   (loaded like `--plugin-dir`, hot-reloaded in interactive sessions), or
2. Install it from this folder as a local marketplace (read from the folder itself,
   so `../gateway` stays reachable):
   ```sh
   claude plugin marketplace add ~/projects/exa/subagent-models
   claude plugin install subagent-models@subagent-models
   ```
   then `/reload-plugins` in running sessions.

Then `Agent(subagent_type: "subagent-models:deepseek-flash", …)`.

## Context window and compaction

For a subagent on an id it does not recognise, Claude Code 2.1.325 assumes a 1M
window (`autocompact: effectiveWindow=980000` in `--debug`). `autoCompactWindow` can
only lower that, so the mod sets it on YAML agents whose `contextWindow` is under 1M
(100K at least, Claude Code's minimum). A `.md` agent on a smaller model should set
`autoCompactWindow` itself. Compaction requests go to the agent's own model through
the gateway like any other request.

## Known gaps

- Cost: Claude Code prices an unknown id with a placeholder (`costBasis: "unknown"`);
  token counts are right, dollar figures are not. Tokens of a Claude fallback are
  booked under the routed id.
- `[claude-code:unrecognized_model]` is printed once per session on stderr in `-p`
  runs. Silencing it needs a `modelOverrides` entry, which would make Claude Code
  treat the id as that Claude model, so it is left alone.
- The first request per model per session costs one local round trip (the thread
  refusal), and `--debug` logs it as an API error.
- `count_tokens` is an estimate.
- Documents (PDF) are replaced with a note; plain-text documents are inlined.
- Server tools (Anthropic-side web search, advisor) are not available to routed agents.
- An agent removed from the YAML stays registered (hidden from the model) until the
  mod reloads.
- `openai-responses` is not implemented in the gateway's own adapters (omp-native mode
  reaches it through omp's transport).
- Through omp's transport, tool-call arguments arrive whole when the model finishes
  each call, not streamed token by token (omp interleaves parallel calls); text and
  thinking do stream.
- omp-native mode follows omp's own reasoning levels per model; a level a model does not
  support is mapped by omp.
- The default agent prompt is a copy of the general-purpose agent's text and can
  drift from Claude Code's own between releases.

## Development

Tests run in an isb sandbox (`dev-base`, with only `gateway/` and `mod/` mounted):

```sh
bun test                                  # gateway: translation goldens, config, chains vs a fake upstream
claude plugin test mod                    # mod: routing decisions, Claude hand-back, registration
claude plugin validate mod
tsc -p mod                                # types in mod/.claude-plugin/types
```
