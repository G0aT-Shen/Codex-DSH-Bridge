# 排障

先区分源码测试、profile 安装和真实宿主运行。安装器成功只证明文件变更；`npm test` 成功只证明本次测试覆盖范围；`health`、共享服务与实际桌面执行要分别验证。

## 主桥离线或版本不对

```sh
node cli.mjs health --json
node cli.mjs shared-status --json
```

`alive:false`：打开正确的桌面 DSH profile，确认主桥条目启用、源码链接存在、队列目录一致。`health.version:1` 表示仍加载旧主桥代码，重新启用或重启后再派工。共享插件自己的 `version:1` 不等于主桥落后。

自定义队列时，每个 CLI 调用加同一个 `--root`，同时确认 MCP 的 `DSH_CODEX_BRIDGE_ROOT` 与两套 DSH 插件 queueDir 相同。不同队列会造成“插件运行但我查不到”的现象。

共享状态失败但主桥在线：检查共享插件和桌面 webServer，不要当作整个主桥离线。CLI 内部负责认证；只提供 hasToken、状态和脱敏错误，不读取或打印 token。

## 安装器缺包、冲突或路径改变

- `yaml` 不能解析：在克隆目录执行 `npm ci --ignore-scripts`，再重试 dry-run。
- 缺 DSH skill-filesystem/HMR/MCP-client：通过 DSH 插件管理器准备相应包。默认安装不要求 LMS 或 MCP-client。
- profile 目录错误：使用 `--profile PATH`；不要传应用二进制路径或 profile 名字符串冒充目录。
- 相同条目指向其他包或源码链接指向旧克隆：核对来源与实际差异，只处理本项目拥有的配置，不覆盖未知目录。
- 技能已有不同内容：先比较，再用 `install-skills --update`，保留其输出的备份。

先运行 `--dry-run` 并检查变更。重载后用 `verify-shared` 核对当前宿主，不要用旧安装报告证明状态。

Windows 请用 `npm.cmd` 避免 npm.ps1 执行策略问题。`--codex-bin` 使用真实 codex.exe 或标准 npm codex.cmd；自定义 cmd/bat/ps1 不作为通用 shell 执行。含空格/中文的路径保留 PowerShell 引号。安装器创建 junction，不需管理员 symlink 权限；但目标 profile 目录本身仍须可写。不要把 Mac 配置里的绝对执行路径原样复制到 PC。

Windows 入队/回包硬链接失败时，核对队列是否在本地 NTFS；FAT/exFAT 或部分网络盘不适用。0600/0700 不等于 Windows ACL，检查私人用户目录的实际 NTFS 权限。PowerShell JSON parse error 常见于旧版本原生命令引号或 UTF-16 重定向；用 ConvertTo-Json + [IO.File]::WriteAllText 写 UTF-8，respond/memory-put 使用 --file。

## 技能已列出但工具不可用

技能只是操作说明，不会创建宿主工具。检查当前已广告工具表。DSH 直接可用的 stdio MCP 使用独立实例；Codex 桌面、CUA、浏览器或会话 Node 能力需要活动监督者处理 `codex_request`。

Codex 没有子智能体工具或会话不允许派工时，主智能体承担监督，不要创建侧栏聊天替代子智能体。MCP 工具表可能被长期进程缓存；CLI 可先使用新命令，之后重连该 MCP 服务。

## watch 返回非零、pending 或终态

watch 默认等待可长达 120 秒，技能采用每次 ≤50 秒。非终态无请求时退出码 `2` 表示等待结束，不能推断 job 失败；查看 JSON 的 state、terminal、progress 和 requests。MCP 会把这个非零退出码呈现为 isError，需要读取具体结果再判断。

```sh
node cli.mjs watch JOB_ID --timeout 50 --json
node cli.mjs progress JOB_ID --json
node cli.mjs requests JOB_ID --json
```

四次 pending、请求未过期且联络者仍活跃：继续阻塞等待，联络者处理具体请求。不要因此撤走监督者，也不要连续发重复请求。

`terminal:true` / `state:completed`：只表示桥执行回合已结束。必须补查 requests、关联原生会话和当前真实文件，交主审独立验证。CLI exit 0 也可能只表示请求出现或信号已写入。存在未处理请求或晚到改动时，不宣称项目完成。

## 请求已经回包，DSH 却没有继续

`respond` 返回 completed 只证明一次性结果保存。正在 `codex_request_wait` 的 DSH 可以读到结果；已经结束的原生回合不会被自动唤醒。

通过 sessions/session-events 确认来源和公开活动。桥拥有的结束 job 可以经主审决策 repair 原 job；原生 session 的 `jobId:null` 不能使用 job watch/digest/repair。没有原生继续接口时，报告“结果已保存，无法继续原会话”的具体阻碍，不另建 job 冒充原会话续跑。

请求已过期或已回应会拒绝再次 respond。requests 默认只列最多 40 条未过期 pending，消失不等于已消费；结合回包结果与会话公开状态判断。不要接手本项目外的请求，除非主智能体明确交付且来源授权已核对。

## digest 显示 ok，但无法证明检查通过

```sh
node cli.mjs digest JOB_ID --json
node cli.mjs read JOB_ID --json
```

检查 evidence.commands 的 exitCode、ok、error。`exitCode:null` 是退出码未知；文本 `ok` 不能证明命令返回 0。result.verification 是模型声明，不能替代 worker 记录和主审自己的验证。

主审读取真实文件/diff，并执行决定正确性的检查。独立复现失败就 changes_requested，由同一联络子智能体 repair 原 job；不能因为子智能体称修复成功而 accepted。晚于已审版本的修改同样需要重新验证。

steer 命令返回成功也只表示入队。查看 journal 的 steer 条目是否出现 error，再结合 DSH 的后续操作确认送达。旧宿主模块缓存可能使当前源码已有的 AbortSignal 接口仍未生效；在任务收尾后重新加载插件，不把队列成功解释成 DSH 已接受纠偏。

`bridge_read` 文件不在证据清单：worker 可能未识别该写入工具或 shell 副作用。主审可在授权内直接核对真实工作区；不要把证据缺失解释成文件一定不存在。公开工具文本或 read 内容截断时，使用合适的文件读取方式；不要解析被截断 JSON 并断言字段不存在。

## writeScope 没有拦住某个操作

守卫只用于本桥拥有的活动会话，需要非空 writeScope 和可用 tools.guard。`writeScope:[]` 与未声明都不启用路径守卫，空数组不是只读策略。检查队列根的 guard 注册状态与 DSH 插件日志中的脱敏错误。

它能拦截已识别的文件工具和常见 shell 写入目标，但不是完整 OS 沙箱。复杂 shell、脚本解释器、未知工具、其他进程和时间竞态不保证受保护。authorization 主要约束提示词，不能替代系统权限。需强隔离时使用宿主/操作系统提供的实际隔离，不通过“守卫测试通过”宣称所有副作用被阻止。

Windows 常见 PowerShell 文件命令也做静态路径检测；变量、通配符、表达式和脚本块不求值，不保证覆盖。时区默认为系统 IANA 时区，需要覆写时通过 CLI config 的 clientTimeZone 设置有效时区，并在任务结束后重载 worker。

符号链接和 macOS 临时目录 `/var` → `/private/var` 会影响路径比较，代码使用真实路径规范化。临时输出应放在授权 scope 内。

## 任务一直等待依赖

```sh
node cli.mjs list --all --json
node cli.mjs status JOB_ID --json
node cli.mjs questions --json
```

默认下游等待依赖 review accepted；上游 completed 但 pending 正常。若上游 failed/blocked/interrupted/needs_input，下游不会当成可用完成。处理真实阻碍或回答问题，再由主审验收。保持 DAG 无环且 ID 正确；当前桥不会完整检测循环依赖。

不要为了解除等待把 dependencyPolicy 改成 completed 或跳过独立验收。批量提交可能部分成功，失败后先查已入队 ID，避免重复 submit。

## 中断、旧锁或返工异常

应用重启后，原 running job 会变为 interrupted。先核对原生会话和当前文件、副作用，再 resume/repair；不要盲目重放。

worker.lock 防止同队列多 worker。旧锁的 PID 已死亡时可自动回收；PID 仍活跃时先确认对应进程/队列，不手工删除活动锁或终止其他会话。运行中 job 用 steer，不用 repair；needs_input 用 questions/answer。

同一阻碍两次返工仍无进展：主智能体报告可复现的问题、已做检查、具体依赖与下一步，停止无效重复。用户要求停止时 cancel 本项目任务并确认终止状态。

## 笔记冲突和游标错误

`Memory conflict` / `Memory update busy`：重读 key 的 revision，合并事实再写；不要把 expectedRevision 固定为 0 重试。共享笔记只保存显式项目事实和偏好，不能包含凭据或原始思考。

job events cursor 是字节，原生 session cursor 是 seq。分别保存 nextCursor，不能混用。事件文件变化导致 cursor 失效时从 0 重新读并结合 attempt 去重。过滤掉的事件也可推进 cursor，不能根据显示条数计算下次位置。

## 提交排障材料

提供本次 health/shared-status 的必要状态、Node/DSH 版本、命令与退出码、脱敏错误、源码版本、相关文件 diff，以及不包含个人内容的最小复现。不要提交 token、认证配置、原始会话/事件日志、课程文件或个人共享笔记。公开视图的过滤是尽力脱敏，分享前仍需检查实际内容。

研究资料说明特定发行版本的静态接口证据，不保证当前应用运行可达。平台差异或宿主升级问题须以当前真机复现为准；本仓库不声称后台自动唤醒、全平台宿主兼容或完整 OS 沙箱。
