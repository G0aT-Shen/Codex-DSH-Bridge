# 协议、状态与命令参考

实现以 `protocol.js`、`worker.js`、`cli.mjs`、`mcp.mjs`、`shared.mjs` 和 `shared-plugin/boot.js` 为准。CLI、MCP 和可选本地 HTTP 派工接口复用同一个命令实现。

## 任务定义

将路径换成你自己的已存在工作目录，ID 换成从未提交过的值：

下面使用 POSIX 路径表示。Windows JSON 使用本机绝对路径，例如 `"cwd":"C:\\项目工作区\\示例"`，writeScope 同样填写 Windows 路径。不能把另一台机器的路径直接搬到本机。

```json
{
  "id": "example-001",
  "goal": "创建 hello.txt，内容为 bridge ok，并汇报实际验证",
  "cwd": "/absolute/workspace",
  "plan": ["检查目录", "创建文件", "验证内容并交付"],
  "acceptance": ["hello.txt 内容为 bridge ok", "提交真实验证结果"],
  "boundaries": "只处理此文件，不联网、不安装、不提交",
  "writeScope": ["/absolute/workspace"],
  "authorization": {
    "network": false,
    "install": false,
    "commit": false,
    "push": false,
    "publish": false,
    "delete": false,
    "credentials": false
  },
  "maxSteps": 20,
  "timeoutSeconds": 600,
  "wrapUpSteps": 5,
  "wrapUpSeconds": 60,
  "dependsOn": [],
  "dependencyPolicy": "accepted"
}
```

| 字段 | 校验与语义 |
| --- | --- |
| `id` | 必填，1–100 个 ASCII 字母、数字、下划线或连字符；不得重复提交，拒绝 Windows 设备名如 CON/NUL/COM1/LPT1 |
| `goal` | 非空字符串 |
| `cwd` | 非空绝对路径，worker 启动时要求目录存在 |
| `plan`、`acceptance` | 必填非空字符串数组 |
| `boundaries`、`notes` | 可选文字；协作流程要求明确范围 |
| `maxSteps` | 1–200，默认 40；每次尝试的硬步数预算 |
| `timeoutSeconds` | 1–7200，默认 1800；每次尝试的硬时间预算 |
| `wrapUpSteps` | ≥0 且小于 maxSteps；默认 min(配置值 8, floor(maxSteps/3)) |
| `wrapUpSeconds` | ≥0 且小于 timeoutSeconds；默认 min(配置值 120, floor(timeoutSeconds/4)) |
| `dependsOn` | job ID 数组，去重且不允许依赖自身 |
| `dependencyPolicy` | 默认 `accepted`，也支持 `completed` |
| `authorization` | 仅允许上例七个布尔字段；未设 true 的动作在提示词中禁止 |
| `writeScope` | 路径字符串数组，相对路径按 cwd 解析，并处理现有符号链接；未声明或空数组均不启用守卫 |

批量文件可为任务数组，或 `{ "tasks": [...] }`，通过 `submit --batch` 提交。设计为 DAG，但当前实现不做完整批量拓扑/循环检测，也不是整批事务：提交中途校验失败时前面的任务可能已入队。主协调员需先检查依赖有效性，失败后先查询已提交 ID，再处理剩余项。

### Windows PowerShell 任务文件

从克隆目录执行；下例读取 package.json，不要求 DSH 修改项目文件。实际 submit 会调用桌面 DSH 模型，须由活动的 Codex 监督：

```powershell
$BridgeRepo = (Get-Location).Path
$Task = Get-Content -LiteralPath "$BridgeRepo\examples\task.json" -Raw | ConvertFrom-Json
$Task.id = "example-" + [Guid]::NewGuid().ToString("N")
$Task.cwd = $BridgeRepo
$TaskFile = Join-Path $env:TEMP ($Task.id + ".json")
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($TaskFile, ($Task | ConvertTo-Json -Depth 10), $Utf8)
node cli.mjs submit "$TaskFile" --json
node cli.mjs watch $Task.id --timeout 50 --json
node cli.mjs requests $Task.id --json
node cli.mjs digest $Task.id --json
```

watch 非终态时继续等待并处理所属请求，终态后再交主审。JSON 文件必须是 UTF-8；解析支持 UTF-8 BOM，但不支持 PowerShell 5.1 默认 `>` / `Out-File` 产生的 UTF-16。不要依靠 `writeScope:[]` 强制只读，示例的只读约束来自任务范围及宿主权限。

默认 `accepted` 要求依赖处于可审查执行终态且 review 已 accepted。`completed` 策略仅要求依赖属于 `completed` / `step_limit` / `timeout`，会跳过主审关口，也不等于结果必定满足验收。一般项目保持默认策略。

## 配置与预算

配置位于队列根的 `config.json`：

```sh
node cli.mjs config --json
node cli.mjs config --set maxConcurrent=2 --set defaultMaxSteps=50 --json
```

| 配置 | 默认值 | 范围或用途 |
| --- | --- | --- |
| `maxConcurrent` | 1 | 1–4 |
| `pollMs` | 1000 | 100–60000 ms |
| `healthWindowMs` | 15000 | 5000–300000 ms |
| `defaultTimeoutSeconds` | 1800 | 1–7200 |
| `defaultMaxSteps` | 40 | 1–200 |
| `wrapUpSteps` | 8 | 0–200，再按任务预算收紧 |
| `wrapUpSeconds` | 120 | 0–3600，再按任务预算收紧 |
| `steerGraceMs` | 2000 | 中途指令宽限时间 |
| `journalBriefChars` | 300 | 40–4000 |
| `resultMaxChars` | 60000 | 结果文本上限配置 |
| `clientTimeZone` | 系统 IANA 时区，无法获取时 UTC | 有效 IANA 时区；用于桌面 prompt，非法值回退系统默认 |

worker 在启动时读取配置；变更并发等运行参数后，应在活动任务收尾后重载插件并检查 health。CLI 写配置不保证当前 worker 立即应用。主桥插件的 `queueDir`、`pollMs`、`httpApi` 和 `enforceWriteScope` 属于 profile 层；不要依靠 profile 中的 `maxConcurrent` 覆盖 worker。

软预算在接近上限时发收尾提醒，硬预算会终止当前尝试。返工的 attempt 预算重新计时和计步，项目总预算需要主协调员额外管理。

## 三种状态

| 维度 | 值 | 含义 |
| --- | --- | --- |
| 执行 `state` | `queued`、`running` | 排队/运行，未结束 |
| 执行终态 | `completed`、`step_limit`、`timeout` | 当前执行停止，可以提交主审；不代表验收成功 |
| 其他终态 | `failed`、`cancelled`、`blocked`、`interrupted`、`needs_input` | 失败、取消、受阻、中断或等待回答；不当作完成 |
| 交付 `outcome` | `completed`、`partial`、`blocked`、`needs_input` | 执行者结构化自述，需独立验证 |
| 人工 `review.state` | `pending`、`accepted`、`changes_requested` | 尚未审查、主审通过、要求返工 |

`terminal:true` 只表示当前 job 执行终态，不包含关联原生会话或晚到请求的完整状态。watch 已在终态时可能直接返回，未查询反向请求，因此必须另查 `requests JOB_ID`。请求完成与 job 完成也是两套状态。

DSH 最终消息应以唯一权威 `bridge-result` 代码块结束：

````text
```bridge-result
{"outcome":"completed","summary":"实际交付摘要","changes":[{"path":"/absolute/workspace/hello.txt","kind":"create","note":"内容为 bridge ok"}],"verification":[{"command":"实际命令","exitCode":0,"result":"实际结果"}],"blockers":[],"questions":[],"next":[]}
```
````

缺失或损坏时会生成 `structured:false` 的降级结果；生成结果文件不能证明契约或验收标准满足。

## 证据与本地布局

默认根为 `~/.local/share/dsh-codex-bridge`：

```text
health.json             worker 心跳、版本、槽位、任务概况
config.json             本机配置
worker.lock             队列单实例锁
token                   内部本地认证文件；不要读取/打印/提交
http.json               可选本地接口发现信息
inbox/<id>.json         原子入队任务
jobs/<id>/
  task.json             任务定义
  status.json           state / attempt / session / review
  progress.json         步数、工具、预算、等待原因
  result.md             执行者最终文本
  result.json           结构化或降级交付
  evidence.json         worker 采集的文件/命令/拒绝/用量等
  journal.ndjson        紧凑操作证据
  events.jsonl          原始本地事件，仅必要时深挖
  attempts/<n>/         历史交付归档
  steer/ ask/ answer/   中途指令、问题、回答
  resume / cancel       续跑与取消信号
shared/
  host.json             共享宿主发现与存活标记
  requests/<id>/        request.json 与一次性 response.json
  memory/<key>.json     显式笔记及 revision
```

入队与一次性回包依赖同目录硬链接；Windows 队列使用支持硬链接的本地 NTFS 目录。FAT/exFAT 或部分网络盘不适用。Windows 文件 mode 0600/0700 不等于 ACL 设置，需依靠私人用户目录与实际 NTFS 权限。

`digest --json` 返回 status、progress、result、evidence、journal、paths 和 digest 文本。先看审查包，需要时再读增量公开事件。result 是执行者声明，evidence 来源于工具事件和真实文件哈希，但主审还需自己的复现。

命令证据的 exitCode 从可识别的宿主输出中提取，可能 `null`；不要把缺失值当成 `0`。当前 digest 文本在没有明确失败标记时可能显示 `ok`，应检查 JSON 的 `exitCode`、`ok`、`error`，并独立执行决定正确性的检查。文件哈希是在采集时计算；后续改动需重新读取。`bridge_read` 只允许证据清单内文件并重新计算哈希；大文件内容可能截断。

路径守卫仅用于 bridge 拥有的活动会话，并需任务有非空 writeScope、宿主 `tools.guard` 注册成功。它检查可识别的 write/edit 与常见 shell 重定向、tee、rm/cp/mv/touch/mkdir/dd/sed 等目标，不是完整 OS 沙箱；任意解释器、复杂 shell 和其他工具不保证被覆盖。授权矩阵主要是提示词约束，不能替代宿主审批和系统权限。

Windows 的 pwsh/powershell 及原生 shell 检测支持常见 Set-Content、Add-Content、Out-File、Tee-Object、New-Item、Remove-Item、Copy-Item、Move-Item 等写入目标。这是静态启发式过滤，不求值 PowerShell 变量、通配符、表达式或脚本块，也不能完整预测命令副作用。

## 20 个 Codex MCP 工具

通过 `mcp.mjs` 暴露，stdio 使用每行 JSON-RPC 2.0（NDJSON），协议版本标记 `2025-06-18`。下表列出原始工具名，客户端实际广告名可能有 MCP 命名空间前缀。

| 工具 | 主要参数 | CLI 对应 |
| --- | --- | --- |
| `bridge_health` | 无 | `health --json` |
| `bridge_submit` | `task` 或 `tasks` | `submit FILE [--batch]` |
| `bridge_list` | `all?` | `list [--all] --json` |
| `bridge_status` | `id` | `status ID --json` |
| `bridge_wait` | `id, timeoutSeconds?` | `watch ID --timeout S --json` |
| `bridge_digest` | `id` | `digest ID --json` |
| `bridge_read` | `id, path?` | `read ID [PATH] --json` |
| `bridge_steer` | `id, text` | `steer ID TEXT` |
| `bridge_repair` | `id, note, fresh?` | `repair ID NOTE [--fresh]` |
| `bridge_questions` | 无 | `questions --json` |
| `bridge_answer` | `id, text, seq?` | `answer ID TEXT [--seq N]` |
| `bridge_review` | `id, verdict, note` | `review ID accepted\|changes_requested NOTE` |
| `bridge_cancel` | `id` | `cancel ID` |
| `bridge_events` | `id, cursor?, limit?` | `events ID --cursor BYTES -n N` |
| `bridge_requests` | `jobId?` | `requests [JOB_ID]` |
| `bridge_respond` | `id, text, isError?` | `respond ID --inline JSON` |
| `bridge_memory` | `key?` | `memory [KEY]` |
| `bridge_memory_put` | `key, text, expectedRevision` | `memory-put --inline JSON` |
| `bridge_sessions` | 无 | `sessions` |
| `bridge_session_events` | `sessionId, cursor?, limit?` | `session-events SESSION_ID --cursor SEQ -n N` |

`bridge_wait` 实现允许 1–600 秒、默认 120 秒；协作技能使用每次 ≤50 秒，便于持续回应和处理宿主请求。短等待返回非终态或 MCP `isError:true` 时，先看状态与请求，不能直接推断任务失败。旧 MCP 进程可能未广告新工具，使用 CLI 兜底并重连该服务。

服务器也暴露 `dsh-bridge://jobs/ID` 资源；读资源返回状态、进度、结果与证据。

## 完整 CLI 参考

所有命令从仓库目录用 `node cli.mjs ...` 调用。全局 `--root PATH` 选择队列；常规查询可用 `--json` 获取结构化返回。

| 命令 | 用途 |
| --- | --- |
| `health` | 当前 worker 存活、版本、槽位、队列概况，仅输出 hasToken |
| `submit FILE [--batch]` / `submit --inline JSON` / `submit --file FILE` | 唯一 ID 入队，主桥必须在线 |
| `list [--all]` | 列出 job；`--all` 包含默认隐藏的旧失败等状态 |
| `status ID` / `progress ID` | 完整状态/进度 |
| `watch ID [--timeout S]` | 等待终态、进度变化或所属反向请求 |
| `tail ID [-n N]` | journal 尾部，默认 20 条 |
| `digest ID` / `result ID` | 审查包/结构化结果包 |
| `read ID [PATH]` | 证据内产物清单或真实内容 |
| `steer ID TEXT` | 排队/运行中纠偏 |
| `repair ID NOTE [--fresh]` | 已结束 job 返工；返回成功只表示续跑信号已写入 |
| `resume ID [NOTE]` | 与 repair 相同续跑机制，用于中断恢复 |
| `cancel ID` | 取消本项目拥有的任务，之后查询确认 |
| `review ID accepted\|changes_requested NOTE` | 主审记录证据与结论 |
| `questions` / `answer ID TEXT [--seq N]` | 查询问题与回答同会话续跑 |
| `config [--set k=v ...]` | 配置读取/更新；运行 worker 需重载 |
| `events ID [--cursor BYTES] [-n N]` | 桥任务公开事件分页 |
| `requests [JOB_ID]` | 默认仅列未过期 pending，最多 40 条 |
| `respond REQUEST_ID --inline JSON` / `respond REQUEST_ID --file FILE` | 一次性真实结果或错误回包 |
| `memory [KEY]` / `memory-put --inline JSON` / `memory-put --file FILE` | 显式共享笔记读写 |
| `sessions` | 最多 100 个原生会话元数据，有 hasMore |
| `session-events SESSION_ID [--cursor SEQ] [-n N]` | 原生会话公开事件分页 |
| `shared-status` | 当前共享工具、技能与宿主状态 |
| `shared-skills` / `shared-skill NAME` | 可见技能清单/具体技能内容 |
| `mcp` | 以 CLI 入口启动 stdio MCP，也可直接运行 mcp.mjs |

常见退出码：`0` 表示命令已处理；`1` 是输入/执行异常；`health` 离线、`submit` 离线、`watch` 等待结束仍非终态且无请求时为 `2`。`watch` 遇到请求也返回 `0`，因此 shell 成功不等于项目完成。MCP 将非零命令退出码映射到 `isError:true`。

`--file FILE` 读取 UTF-8 JSON 参数，支持 UTF-8 BOM，用于 submit、respond、memory-put 和 shared-status/shared-skills/shared-skill/sessions/session-events 等共享宿主参数。动态 payload 优先使用结构化 MCP，或先写文件再传路径，避免 PowerShell 5.1 原生命令引号处理破坏 JSON；不要同时传 --inline 和 --file。

## 反向请求与显式笔记

DSH 侧注册四个工具：`codex_shared_memory`、`codex_shared_memory_put`、`codex_request`、`codex_request_wait`。请求类型为 `skill` 或 `plugin`，包含 name、instruction、来源 sessionId/jobId、createdAt 和 expiresAt。请求有效期 30–1800 秒，默认 600 秒；单次等待 0–50 秒，默认 45 秒。

请求状态为 `pending`、`completed`、`failed` 或 `expired`。成功回包进入 completed，`isError:true` 进入 failed；已回应或过期请求不能再次回应。CLI requests 默认只列 pending，因此不在列表中也可能是已回应或过期。没有显式消费确认字段；结合原生会话公开事件判断 DSH 是否消费与继续。

shared-status 的 portableMcp 按 `mcp__codex_NAME__...` 工具名统计已镜像的服务，不限于 LMS。计数是广告工具数，不证明账号登录、远端 API 成功或宿主实例共享；未安装 LMS 时 lms 为 0 属正常状态。

结构化 `bridge_respond` 优先；CLI 的静态 JSON 可用可靠的单引号：

```sh
node cli.mjs respond REQUEST_ID --inline '{"text":"实际结果与来源","isError":false}' --json
```

不要把未转义的动态模型文本拼入 shell 命令，优先使用 MCP 结构化参数。回包不调用模型、不唤醒 Codex，也不继续已结束的原生 DSH 回合。jobId 为 null 时，通过 sessions/session-events 核对原生来源，不能调用 job repair。

PowerShell 5.1/7 的文件回包示例：将 RequestId 设置为本任务真实且未过期请求的 ID，text 写实际执行结果。

```powershell
$RequestId = "REPLACE_WITH_REAL_REQUEST_ID"
$Response = @{ text = "实际结果与来源"; isError = $false }
$ResponseFile = Join-Path $env:TEMP "dsh-response.json"
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($ResponseFile, ($Response | ConvertTo-Json -Depth 10), $Utf8)
node cli.mjs respond $RequestId --file "$ResponseFile" --json
```

共享笔记可用相同方式将 key、text、刚读取的 expectedRevision 写进 UTF-8 JSON，然后调用 `memory-put --file FILE`。文件内容本身仍是用户数据，留在本机，不提交到仓库。

笔记 key 为 1–80 个小写字母、数字、点、下划线或连字符，首字符必须是字母或数字；拒绝 Windows 设备名及其扩展名变体（如 nul.note）。新 key 读取为 revision 0。写入要求 expectedRevision 与当前一致，成功后加 1；冲突或 busy 时重读并合并，禁止盲目覆盖。text 最长 16000 字符。

```sh
node cli.mjs memory example-note --json
node cli.mjs memory-put --inline '{"key":"example-note","text":"经用户授权记录的项目事实","expectedRevision":0}' --json
```

上例写入仅用于不存在的 key；已有笔记使用刚读到的 revision。笔记是显式事实与偏好，不是模型内部状态。公开 Codex memory summary 如果存在可只读访问，但不是这套桥的必需条件。

## 公开事件与游标

| 入口 | cursor 单位 | 续读 |
| --- | --- | --- |
| `events JOB_ID` / `bridge_events` | events.jsonl 字节偏移 | 直接保存并传回 nextCursor |
| `session-events SESSION_ID` / `bridge_session_events` | 原生事件 seq | 直接保存并传回 nextCursor |

默认 40、最多 100 条公开事件。不要混用两种 cursor。attempt 切换或事件文件变化导致字节 cursor 无效时，从 0 重新读取并结合 attempt 去重。被过滤的事件也可能推进游标，不能根据行数自行推算偏移。

公开视图只转发允许的文本和工具活动，过滤非文本 reasoning 与常见凭据；每条结果文本默认最多 6000 字符，长 JSON 可能截断。它不是完整工具返回，也不能证明截断部分不存在字段。脱敏是尽力过滤，不是任意秘密识别系统；原始本地 events/journal 不应上传。

## 本地服务通道

主桥可选 `/codex-bridge` 接口只支持派工 CLI 的有限命令白名单；共享服务 `/codex-shared` 提供 status/skills/skill/sessions/events。两者依赖桌面 webServer，本地认证由 CLI 内部处理。没有将服务暴露给外网的部署流程，不要手工打印 token，也不要把本地认证文件作为排障附件。
