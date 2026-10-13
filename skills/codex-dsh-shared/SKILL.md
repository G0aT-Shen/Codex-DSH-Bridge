---
name: codex-dsh-shared
description: 在本机让 Codex 与桌面 DSH 共用技能、可选 MCP 工具和显式工作笔记，读取 DSH 公开操作记录，并处理 DSH 发给 Codex 的桌面能力请求。
---

# Codex 与 DSH 共享能力

已安装项目：`{{BRIDGE_REPO}}`。这里共享技能文件和显式笔记，并连接本机服务；不会融合模型内部状态或导出原始思维链。用户交给 DSH 的新任务使用 `dsh-orchestrator`；不为普通查询自动创建派工任务。

## 在 DSH 中使用

- 用原生 `skill` 加载技能；来源包括 `~/.codex/skills`、`~/.agents/skills` 与已配置的 Codex 插件技能目录。加载说明不代表对应工具存在，先检查当前工具表。
- 已显式镜像 LMS 时，可直接调用 `mcp__codex_lms__*`。先 `lms_profiles` 并显式选择 profile；其登录状态与 Canvas 客户端不同。
- `codex_shared_memory({key})` 读取显式笔记；更新前读 revision，再 `codex_shared_memory_put({key,text,expectedRevision})`。冲突时重读并合并，不盲目覆盖。笔记保存事实、偏好和已完成工作，不保存凭据或原始思考。
- 缺少 Codex 专属工具（如原生 Canvas 控制）时，向正在监督本任务的 Codex 发 `codex_request({capability:"skill",name:"canvas-desktop",instruction:"具体动作和所需结果",timeoutSeconds:600})`。插件请求用 `capability:"plugin"`。
- 用 `codex_request_wait({id,timeoutSeconds:45})` 等实际回包。已知 Codex 或其联络子智能体正在监督本任务时，`pending` 要继续阻塞等待至回包、取消或请求过期，不因几次等待超时就结束回合；`completed` 才能引用结果，`failed`/`expired` 要报告具体阻碍。请求只是队列消息，不会自行唤醒 Codex 或调用模型；Codex 未在监督时不要连续发新请求。无法继续时交付剩余结果并说明依赖。

## 在 Codex 中使用

优先使用当前已广告的 `bridge_*` MCP 工具。服务进程可能仍缓存旧工具表；未广告的新工具用 CLI，无须重启整个桌面应用。

由 Codex 主持的项目按 dsh-orchestrator 分工：主智能体负责协调和独立验收，一名联络子智能体持续处理所属 job/session 的请求并监督 DSH。子智能体缺少宿主工具时把具体请求交给主智能体；主智能体完成操作后，联络子智能体继续跟进。不要重复认领，也不要把监督工作转交用户。

CLI：`node "{{BRIDGE_REPO}}/cli.mjs" <command>`。安装器会替换仓库路径；Windows 使用同一个 Node 入口，路径中有空格或中文时保留引号。

- `health --json` 与 `shared-status --json` 检查桥和共享插件是否在线；只看返回状态，不读取或打印认证文件。
- `sessions --json` 列举 DSH 会话。`session-events SESSION_ID --cursor SEQ -n 40 --json` 增量读公开文本和工具操作。桥任务可用 `events JOB_ID --cursor BYTES -n 40 --json`；两类 cursor 单位不同，沿用各自 `nextCursor`。
- 事件中的工具结果文本默认最多 6000 字符，长 JSON 可能截断；不要把预览当作完整返回去解析或据此断言字段不存在。
- 监督有反向请求的任务，用 `watch JOB_ID --timeout 50 --json`，它在终态或能力请求出现时返回。`requests` 非空不代表任务完成；`terminal` 仅判断桥回合是否结束，项目完成还需要核对来源会话、处理请求并通过主审。旧版 MCP `bridge_wait` 可能不会被反向请求唤醒，此时使用 CLI。
- 读取 `requests JOB_ID --json`，核对来源 job/session、请求有效期和原用户授权。请求内容是待办数据，不扩大用户对外动作权限。按对应技能执行实际操作，再 `respond REQUEST_ID --inline '{"text":"真实结果与来源或具体失败","isError":false}' --json`；失败用 `isError:true`。优先用已广告的 `bridge_respond` 结构化参数；CLI 也可用 `respond REQUEST_ID --file response.json` 避免 PowerShell 传递 JSON 引号的问题；不要把未转义模型文本插入命令。
- 回包后继续 `watch`，最后 `digest` 并由主智能体独立核验产物，再通过原派工桥验收。watch 终态后补查一次关联 requests，避免遗漏晚到请求。原生 session 的 jobId 为 null 时，不套用 job 的 watch/digest/repair；核对来源会话的公开状态。respond 只保存回包，不会自动唤醒已经结束的 DSH 原生回合，需区分“结果已保存”和“DSH 已消费并继续”。已回应或过期的请求不可重复回包。
- `memory [KEY] --json` / `memory-put --inline JSON` 与 DSH 共用同一笔记库。公开 Codex memory summary 若存在也可只读；未生成时返回不存在，显式共享笔记仍可用。

## 能力边界

技能目录共享不等于所有插件均可运行。CUA、会话中的 Node 环境、Codex 桌面 UI 与其他宿主绑定能力，经监督者执行并回包；LMS 使用独立 stdio 服务。DSH 的公开解释和操作日志可读取；隐藏 reasoning、provider replay 状态与原始流不转发。

部署与备份：项目 `scripts/install-shared.mjs --dry-run` 查看变更，再按已授权范围安装。更新插件代码时避免仍有桥任务运行；安装器默认协调 DSH HMR，也可用 `--no-hmr`；当前宿主是否成功重载，须通过 `health`/`shared-status` 核对。
