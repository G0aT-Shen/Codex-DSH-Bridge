---
name: dsh-orchestrator
description: 协调用户交给桌面 DSH 的工作：主智能体规划和独立验收，专职子智能体持续对接 DSH、处理能力请求并推动同会话返工。
---

用户要求由 DSH 执行任务时使用。用户选择的协作方式是：Codex 主智能体担任项目协调员和审核员，派出子智能体与 DSH 持续协作，DSH 负责实际执行。用户选择仅使用桌面端：通过已运行的桌面插件创建会话，不使用 headless、TUI 或 Web profile 作为执行替代。普通问题无需派工。

## 主智能体与子智能体分工

当前环境有 collaboration 工具且会话指令允许派工时，主智能体创建一名专职 DSH 联络子智能体；这是当前任务的子代理，不是新建侧栏聊天。主智能体负责目标、阶段计划、任务依赖、范围决策和最终验收，子智能体负责 submit、watch、能力请求、进度纠偏和按主审意见 repair。主智能体可并行处理其他项目协调工作，持续接收子智能体的实质进展与阻碍。

- 派给子智能体的指令包含目标、cwd、验收标准、授权、writeScope、预算和停机条件。要求读取本技能及 codex-dsh-shared；沿用既有 job/session，不冷启动重复派工。同一 job/session/request 只指定一名联络负责人，避免多个子智能体重复操作；这项归属由主智能体管理，当前桥本身没有请求认领租约。
- 子智能体记录 jobId、sessionId、attempt 和事件 cursor。任务运行时反复阻塞 watch（每次不超过 50 秒）；单次等待超时不是任务失败，不因连续几次 pending 就撤走监督者。每轮按 jobId 查询能力请求，只接手本任务或主智能体明确交付的原生 session 请求。
- 有反向请求时，子智能体先核对来源、授权、有效期并执行对应技能，再 respond，随后继续等待 DSH。如果所需桌面工具只存在于主智能体，立即向主智能体报告 requestId、所需操作和 expiresAt，由主智能体完成宿主操作并回包；子智能体负责跟进 DSH 是否继续。
- watch 看到终态时仍补查一次 requests JOB_ID：现有实现可能先返回终态而未查询请求。交付到“待主审”前确认关联 DSH 回合确已结束，仍未解决的能力请求有明确状态；子任务 accepted 不代表原生会话或较晚改动也已验收。
- 子智能体交付审查包：job/session/attempt、当前状态、真实产物与 diff、证据路径、验证命令和退出码、能力请求状态、阻碍及下一步。终态后向主智能体交付待审结果，不自行写 accepted，也不放行依赖任务。
- 主智能体独立读取真实文件／diff，并执行能决定正确性的检查；放行前再读 status、关联 requests 和来源会话状态，确认 attempt、已核验的文件版本／哈希和会话进展没有变化，再 bridge_review，审查备注记录对应版本。若产生新改动或请求，先处理并重验，不能用一次终态补查排除后续变化。发现缺口就 changes_requested，并通过 collaboration.followup_task 让同一联络子智能体 repair 原 job、继续监督；保留联络上下文。下游默认 dependencyPolicy=accepted，只由主审通过后放行。
- 主智能体在本次项目目标未完成时保持工作回合，等待子智能体、处理依赖和验收；结束前核对自己负责的 DSH 任务及请求已收尾，或报告确实无法解除的阻碍。不要以“已派工／已回包”代替项目交付，也不要把请求编号转给用户要求其手动催办。

这套协作在当前 Codex 任务运行期间生效。子智能体和队列不会自行唤醒已经结束的 Codex 回合。DSH 独立原生会话的 jobId 可能为 null，此时不能调用 repair JOB_ID；对已经结束的原生会话，respond 只保存结果，没有自动续跑行为。需要独立后台唤醒或原生会话续跑时，先确认实际可用接口，不能声称本流程已实现这些能力。没有子代理工具时，由主智能体执行同样的持续监督与独立验收流程，并如实说明执行方式。

## 连通性（先做）

CLI：`node "{{BRIDGE_REPO}}/cli.mjs"`；安装后的 `scripts/bridge.mjs` 也会转发到这个入口。支持 macOS / Windows 原生路径；不要在 PowerShell 中依赖 `~` 字符串展开，保留路径引号。

先 `health`：`alive:false` 表示桌面 DSH 未运行或未加载插件，不能声称已经派工。`version` 必须是 `2`；若为 `1`，说明应用还停留在旧插件模块，请让用户重启 DSH 或重新启用插件后再派工。
MCP（若已注册）：`codex mcp add dsh-bridge -- node "{{BRIDGE_REPO}}/mcp.mjs"`，对应工具 `bridge_*`；有 MCP 时优先用 MCP。

## 派工

任务 JSON 字段：唯一 `id`、`goal`、绝对路径 `cwd`、非空字符串数组 `plan` 与 `acceptance`、文字 `boundaries`；可选
`maxSteps`（1–200，默认 40）、`timeoutSeconds`（1–7200，默认 1800）、`wrapUpSteps`（剩余多少步开始提醒收尾）、
`wrapUpSeconds`、`dependsOn`（DAG）、`dependencyPolicy`（默认 `accepted`：下游等验收）、
`authorization`（network/install/commit/push/publish/delete/credentials，默认全 false）、`writeScope`（非空数组启用应用层路径护栏，依赖宿主 `tools.guard`；已识别的文件工具和 bash/PowerShell 静态写目标会被校验，复杂表达式和解释器不保证覆盖，不是 OS 沙箱。临时目录也要列入；不声明或空数组不限制）。

- 任务范围与外部动作权限必须来自用户；未授权的动作会被提示词明确禁止，DSH 侧审批策略为自动拒绝。
- 预算按工作实际设定：`maxSteps` 略高于预期步数，让 `wrapUpSteps` 生效，执行者会在预算耗尽前先交付、再停机。
- 多步工作用 `dependsOn` 组 DAG 批量提交（一次 `submit --batch`），不要把一个目标拆成互不相关的冷启动任务。
- 简短展示计划后 `submit TASK.json`，保存返回的 id。每个 id 只能提交一次；返工用 `repair`，不要换 id 重派。
- 任务会在对应目录的桌面工作区显示，标题以 `Codex ·` 开头。

## 等待与干预（不要忙轮询）

- MCP：`bridge_wait(id, timeoutSeconds≤50)` 阻塞到状态变化或终态；返回 `terminal:false` 就再调一次。
  没有 MCP 时用 `watch ID --timeout 50 --json`。已接入共享能力的任务优先用这个 CLI 等待，兼容当前缓存的旧 MCP 服务。
- 共享插件允许 DSH 发 `codex_request` 请求 Codex 专属桌面能力。`watch` 会被本任务请求唤醒，exit 0 此时也可能 `terminal:false`；先处理返回的 `requests`，不要把它当作完成。按 `codex-dsh-shared` 技能核对授权和有效期，实际执行后 `respond REQUEST_ID --inline JSON`（text、isError），再继续 watch。新工具已广告时可用 `bridge_requests`/`bridge_respond`，否则 CLI 兜底。
- 需要了解细节用 `status ID` / `progress ID`（步数、当前工具、剩余预算、等待原因）。
- 执行跑偏（范围膨胀、方向错误）时用 `steer ID "收敛范围：只修 X，先出报告"`。返回只表示已入队；通过 journal 核对实际送达或错误，再判断是否需要其他干预。
- 任务提问（`outcome=needs_input`）用 `questions` 查看、`answer ID "决策内容"` 回答；worker 会在同一会话继续。

## 审查

终态后用 `digest ID`（MCP `bridge_digest`）取审查包：交付结论 + 独立证据（文件 sha256、命令与退出码、被拒绝/失败的调用、越界写入、steer 次数、token 用量）+ journal 末尾 + 深挖路径。需要时再读 `events.jsonl`，不要默认整份读。

- 必须独立核验：读真实文件或 Git diff，运行会决定正确性的验证命令；不要仅依据 DSH 的成功声明或测试摘要。只读或文案任务采用对应的轻量核查。
- 状态语义：`completed` 仅表示回合结束；`step_limit`/`timeout` 也可能带可用交付（`outcome=partial`），按 `blockers`/`next` 判断返工范围；`needs_input` 等回答；`interrupted`/`failed`/`cancelled`/`blocked` 不能当作完成。
- 通过：`review ID accepted "具体产物和独立验证证据"`。`dependencyPolicy=accepted` 的下游任务此时才会启动。
- 返工：`review ID changes_requested "问题与验收缺口"`，再 `repair ID "精确缺口与要求"`——worker 优先在**同一会话**续跑（保留上下文），必要时才 fork 或冷启动。只有在任务被污染或需要全新上下文时才加 `--fresh`。
- 应用重启后 `interrupted` 的任务用 `resume ID` 恢复；先核对会话与文件的实际状态，防止重复副作用。
- 同一阻碍两次返工后仍无进展时，报告具体阻碍，不无限重复。
- 用户要求停止时用 `cancel ID` 并确认终止状态。不要取消用户手工会话。

## 环境

源码：`{{BRIDGE_REPO}}`（包名 `@hanyangshen/codex-bridge`，入口 `boot.js`）。队列与证据：`~/.local/share/dsh-codex-bridge/jobs/ID`（`task.json`、`status.json`、`progress.json`、`journal.ndjson`、`result.md`、`result.json`、`evidence.json`、`events.jsonl`、`attempts/`）。
本地 HTTP 兜底由 CLI 内部处理认证；不要读取或打印 token 文件。`health --json` 只输出 `hasToken`。
该插件只通过本地文件与本地端口收发任务，不监听外部网络。真机冒烟：`node "{{BRIDGE_REPO}}/scripts/smoke-v2.mjs"`；守卫复验：`node .../scripts/guard-check.mjs`。
安装器默认协调 `@deepseek-ai/dsh-hmr` 监听桥源码目录，也可用 `--no-hmr`；升级包版本或未开启 HMR 的环境仍可能需要重启。避免在任务运行中热改源码；更新后先跑 `health` 确认 `version: 2`，共享服务另用 `shared-status` 确认。

部署细节见仓库 `docs/deployment.md`。Windows 队列使用支持硬链接的本地 NTFS 目录；文件 mode 不提供 NTFS ACL 保证。多行/复杂 JSON 优先使用 MCP 结构化参数或 CLI `--file`，文件编码为 UTF-8（接受 BOM）。
