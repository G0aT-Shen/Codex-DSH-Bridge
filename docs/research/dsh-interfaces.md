> Publication note: this is an authored historical research summary, not an official or stable host API contract. Proprietary extracted application sources, local manifests, protocol dumps and private machine data are not distributed in this repository. Artifact paths and source offsets below refer to the original local investigation and are retained as historical references.

# DSH shipped-artifact interface findings

Scope: read-only inspection of `<user-home>/Desktop/DeepSeek Harness.app/Contents/Resources/app.asar`, identified as `@deepseek-ai/dsh-desktop` version `0.2.0-rc.2`, build commit `5e9e301dd9dc8923b2762f76dacfc5751f6ca851`. ASAR SHA-256: `18d5036bbb58eaff41d351ede99314b8d06505aec06fb2e164c49874ada30f9e`.

The ASAR header was parsed and selected members read by offset/length. Extracted sources and hashes are in `artifact-ledger.json`. No application bootstrap, task execution, model request, message dispatch, app restart, or credential inspection was performed.

## Registered tool API — answered statically

`modules/dsh-tools/lib/types/index.js:459` defines `ctx.tools.register(definition)`. Mandatory fields: `name`, `description`, `parameters` (object-root raw JSON Schema), `output: { schema, render }`, and `execute(args, exec)`. `output.render` returns content blocks; the execution body returns a canonical JSON value satisfying `output.schema`. An optional positive finite `timeoutMs` is validated. `run_code` is reserved. Scope-local definitions shadow global definitions; duplicates inside one scope fail.

Registration returns an unregister function and internally creates a Cordis context effect, so tools automatically disappear when the plugin context is disposed. Bind separately owned sockets, subprocesses and AbortControllers using `ctx.effect`.

```js
export const name = 'codex-shared';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({
    name: 'codex_shared_status',
    description: 'Read the shared Codex capabilities.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object', properties: { status: { type: 'string' } },
        required: ['status'], additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      return { status: 'ready' };
    },
  });
}
```

`defineTool` is exported from `@deepseek-ai/dsh-tools` and accepts a convenience parameter DSL (see shipped `modules/dsh-tools/README.md:32`). The raw schema form above avoids another dependency and is exercised by the shipped MCP adapter.

## MCP plugin — answered statically

`modules/dsh-mcp-client/lib/index.js:780` exports a union `Config`, `apply`, `inject = ['tools']`, `name = 'mcp-client'`, and `createMcpToolDefinition`. Each plugin instance connects to one server. StdIO config fields: `transport: 'stdio'`, `serverName`, `command`, `args`, `env`, `cwd`, `toolCallTimeoutMs`, `failOnStartupError`, `maxInstructionBytes`, `reconnect`. Streamable HTTP fields replace command/args/env/cwd with `transport: 'streamable-http'`, `url`, `headers`.

Public tools are named `mcp__<serverName>__<rawName>`. Server namespaces must be unique within the same scope; discovery swaps are atomic. `createMcpToolDefinition(ctx, options)` maps upstream input/output schemas and `call(args, exec)` into the same canonical output API. The caller owns transport lifecycle and deadlines. MCP result validation happens before projection, and `isError: true` rejects as a tool failure. StdIO scrubs credential-shaped ambient variable names and `DSH_*` before explicitly configured env merges.

Portable third-party MCP servers can be connected independently. A Codex desktop-specific connector requiring its client/task runtime is not established as portable by this inspection.

## Skill API and shared roots — answered statically

`modules/dsh-skill/lib/index.js:234`: `ctx.skills.snapshot({ scope?, cwd?, signal? }) -> { skills, complete }`. `:250`: `ctx.skills.get(name, options) -> full definition | undefined`. `:147`: `registerProvider(create)` is synchronous, scoped, automatically disposed, and names must be unique in one layer. A provider control has `signal` and `invalidate()`.

`modules/dsh-skill-filesystem/lib/index.js:31` accepts `providerName`, `includeDefaultRoots`, `dshHome`, `agentsHome`, `customSkillDirs`, `watch` and watcher tuning fields. Additional roots are supported directly. It only discovers `<root>/<skill>/SKILL.md` and flat `<root>/<skill>.md`, not recursively nested SKILL files. Valid skill names match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`. Skill source metadata may contain `disable-model-invocation` and `user-invocable` controls.

Default roots already include `~/.agents/skills`. Shared Codex roots need `~/.codex/skills`, its `.system` directory and each plugin's actual `skills` root separately. A new host provider with a unique name `codex-shared` and `includeDefaultRoots: false` can scan these roots without overlapping default providers.

Important scope detail: `modules/dsh-web-app/cordis.patch.yml:484` disables the base host entry `skill-filesystem`; presets own the local provider. Adding a unique global provider is appropriate because the registry merges the global and preset scope layers, as the shipped patch documents at `:475`.

## Public events and history — answered statically

`ctx.on('session/event', (session, event) => ..., { global: true })` receives durable envelopes with `type`, `seq`, `time`, and `data`. Source definitions: `modules/dsh-agent-loop/lib/index.js:682`, `:697`, `:1144`.

- `assistant/message`: `data.turn`, `data.step`, `data.message.content`. For shared public observations, whitelist text and tool-call blocks. Do not forward the compact provider stream, private reasoning, source replay state or unknown block types.
- `tool/call`: `data = { turn, step, callId, name, arguments }`.
- `tool/result`: `data = { turn, step, message: { callId, content, isError }, error?, meta? }`.
- `ctx.on('tools/result', (exec, result) => ...)` observes the frozen final tool outcome (`modules/dsh-tools/lib/types/index.js:1070`).
- `agent/status`: `{ agent, status }`; `agent/error`: `{ agent, error }`.
- `agent/assistant-stream`: `{ agent, frame }`, with start/chunk/end frames. Chunks may include non-public provider content, so forwarding raw frames is unsuitable for a public bridge.

Preferred cold-safe history API: `await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })`, then inspect `observation.header` and `observation.events`, disposing the lease with `observation[Symbol.dispose]()` in finally. `ctx.sessions.get/list` are live-only; new production code should avoid deprecated `snapshotEvents`, `eventAt`, and `ownEvents`.

`sessionController` uses Remote namespace `session`. Read methods include `list({}, signal)`, `inspect(id, signal)`, `page({ address: { kind: 'session', sessionId }, throughSeq, beforeSeq?, maxMessages? }, signal)`, `follow(request, signal)`, and `projections({ sessionId }, signal)`. `inspect` is cold-safe but still internally calls a deprecated live reader. Prompt/create/cancel APIs exist but were not invoked. History records carry `{ type: 'event', event }`.

## Profile and HMR — answered statically; live activation unverified

Current desktop profile manifest: `<user-home>/.dsh/profiles/desktop/package.json`; patch: `<user-home>/.dsh/profiles/desktop/cordis.patch.yml`. The legacy `cordis.yml` is an empty mapping. The manifest enables the base/web bundles and the existing Codex bridge. The patch has no HMR or skill-filesystem override at inspection time; only plugin identifiers and config key names were inspected.

`modules/dsh-base/cordis.patch.yml:28` enables HMR when launcher-owned `profileContext` exists and sets `root: []`. `modules/dsh-hmr/lib/index.js:339` watches the profile manifest, profile patch, and home patch. Changes reconcile the profile on one serialized queue, applying newly inserted plugins without restarting existing unchanged entries. Configuration watches use Chokidar's default two-second write-stability window. Module replacement and installed-package upgrades have separate limitations; no live HMR event was observed by this worker.

## Memory — bounded finding

No universal memory engine API was established in the inspected shipped packages. The desktop profile enables the third-party `dsh-mnemon` bundle. Its installed SDK's `mnemonMemory` service accepts contribution definitions through `installContributions`; it is not a naked read/write memory engine (`.../dsh-mnemon/lib/types/src/sdk/service.d.ts`). A separate shared memory tool/storage remains a design choice. No existing personal memory entries or credential settings were opened.

## Evidence coverage and limitations

Static coverage by subject:

- MCP client: application coverage complete; semantic relationships have 793 unknowns.
- Tools: application and semantic graph coverage partial due to parent result capacity; static facts retained. 8 application unknowns and 4514 semantic unknowns remain. Source readings above are exact positive observations, not broad absence claims.
- Skill filesystem: inventoried coverage complete, 997 semantic unknowns.

All findings are from shipped or installed bytes and static source inspection; runtime reachability, current profile service availability, actual hot-reload success and end-to-end bridge behavior require independent runtime verification. No private thought content is exposed by this report.
