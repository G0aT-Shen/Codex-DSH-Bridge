> Publication note: this is an authored historical research summary, not an official or stable host API contract. Proprietary extracted application sources, local manifests, protocol dumps and private machine data are not distributed in this repository. Artifact paths and source offsets below refer to the original local investigation and are retained as historical references.

# Codex local interfaces — 2026-10-13

## Scope and evidence

Read-only inspection of the shipped `<user-home>/Desktop/ChatGPT.app/Contents/Resources/app.asar`, plus the bundled Codex CLI's help and generated protocol schema. No credentials, cookie stores, auth.json, user conversation records, or raw reasoning were read. No model turn, tool call, or app configuration change was made.

The ASAR header was parsed structurally: 21,089 members. 45 selected files, 9,360,224 relevant text bytes, were extracted to `extracted/`. Every extracted file's SHA-256 matches the member integrity value in the ASAR header. See `asar-inventory.json` and `extraction-manifest.json` for exact archive byte offsets and digests.

All 44 selected JS files parsed with no syntax failure. The large main/source/worker bundles exhausted semantic heap/result budgets; application and semantic coverage are partial. Source-byte observations below are not runtime execution claims.

## Available local protocol

`codex app-server generate-json-schema --experimental --out protocol-schema` succeeded and emitted 447 schema files. This is the actual installed CLI protocol, not a guess from remote documentation.

`codex app-server --help` advertises `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, and `off`. `codex app-server proxy --sock PATH` forwards stdio to an already-running control socket.

Relevant client request methods in `protocol-schema/ClientRequest.json` include `thread/read`, `thread/turns/list`, `thread/items/list`, `skills/list`, `plugin/installed`, `plugin/read`, `plugin/skill/read`, `mcpServerStatus/list`, `mcpServer/resource/read`, and `mcpServer/tool/call`.

There is no observed `skills/read` method. Local `skills/list` provides paths; a local integration can read the SKILL.md files itself. `plugin/skill/read` is an explicit remote-marketplace skill interface.

`v2/McpServerToolCallParams.json` requires `server`, `threadId`, and `tool`; `arguments` and `_meta` are optional. `v2/ListMcpServerStatusParams.json` documents `serverName`: “With a thread ID, reuse that thread's MCP connection.” This supports a possible same-thread tool bridge when an existing app-server endpoint is available. It does not establish that an independently started app-server can reuse the current desktop thread's host tools.

Static corroboration: `extracted/.vite/build/src-BJv5Mk7n.js`, character offset 998834, `callMcpTool` sends `mcpServer/tool/call`, adding both `thread_id` and `threadId` to `_meta` for a known thread. Offset 1209248 implements paged `thread/turns/list`; offset 1204283 implements `skills/list`.

## Runtime connection limit

Read-only process discovery found two bundled local app-server processes, using default stdio and explicit `--listen stdio://`. `lsof` for these processes returned no named Unix-domain socket. `<user-home>/.codex/app-server-control/` does not exist. `codex app-server daemon version` failed because `<user-home>/.codex/app-server-control/app-server-control.sock` does not exist.

Therefore no existing app-server control socket could be proxied, and same-thread MCP discovery/calling was not runtime-tested. Starting another server would be a separate instance and would not verify shared desktop tool state.

`<user-home>/.codex/ipc/ipc.sock` exists, but it is the desktop IpcRouter protocol, not the app-server protocol. Shipped source `ipc-support/.vite/build/application-network-startup-CfAQmSYg.js`, character offsets 275051 and 276183, establishes the path and 4-byte little-endian length-prefixed JSON framing. `extracted/.vite/build/src-BJv5Mk7n.js` around offset 7900 identifies thread owner/follower/history/model-settings methods. A generic app-server/MCP forwarding method was not observed in this bounded inspection. No requests were sent to that socket.

For an existing app-server endpoint, the minimal NDJSON lifecycle is:

1. Send `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"dsh-codex-bridge","version":"1"},"capabilities":{"experimentalApi":true}}}`.
2. After successful response, send `{"method":"initialized"}`.
3. Send `{"id":2,"method":"mcpServerStatus/list","params":{"threadId":"<verified existing thread id>","detail":"toolsAndAuthOnly"}}`; filter output to server/tool names and connection state.
4. Close the client/proxy input and terminate only the owned proxy process. `ClientNotification.json` only defines `initialized`; no `shutdown` request is defined. Do not shut down a shared daemon.

## Skills, plugins, and memory

`extracted/.vite/build/skills-BztaK_h8.js`, character offset 730, scans the workspace root, `$HOME/.agents/skills`, `$CODEX_HOME/skills`, and `$CODEX_HOME/plugins/cache` for SKILL.md files. This supports sharing the skill directories directly with DSH, avoiding copy drift.

Shipped main bundle, character offset 2674887, reads `$CODEX_HOME/memories/memory_summary.md` via the execution host. That file and its containing `memories/` directory are absent in this local profile. Main bundle offsets 188702 and 208782 identify automation-specific `$CODEX_HOME/automations/<automation_id>/memory.md`; those are per-automation memories, not one global Codex memory.

Only schema was read from `memories_1.sqlite`, using SQLite `mode=ro&immutable=1` and `sqlite_master`. The ordinary read-only open failed; immutable mode succeeded without creating WAL/SHM files. `stage1_outputs` has `raw_memory` and `rollout_summary` TEXT fields with thread/source timestamps; `jobs` carries internal job metadata. No rows were read or exported. These internal stage-one records do not provide an established user-facing shared-memory contract. See `memory-sqlite-schema.json`.

`v2/MemoryStatusResponse.json` exposes only `v2Ready` and `v2ConsolidatedThreads`, not memory text. A deliberately created shared-memory file is the concrete reliable option here.

Portable stdio MCP servers can be instantiated separately in DSH. Desktop browser/native services, session-scoped environments, in-memory analysis sessions, and Codex UI state require explicit host/session-aware adapters; merely copying command/config entries does not share those instances.
