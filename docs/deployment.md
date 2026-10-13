# 部署、验证、更新与回退

## 运行条件

提供 macOS 和 Windows 原生 PC 的部署路径。历史真实桌面联动主要在 macOS 验证，Windows 的 DSH/Codex 桌面客户端仍需用户 PC 独立验收。CI 的 Windows 源码与安装器 fixture 检查不代表真实桌面应用联动已通过。不要用 headless、TUI 或 Web profile 的执行结果替代桌面验收。

| 条件 | 用途 |
| --- | --- |
| Node.js ≥22、Git | 运行 CLI、MCP、安装器和测试 |
| 桌面 DSH，模型与执行工具配置就绪 | 真正创建工作区与执行会话 |
| Codex；CLI 可选但 MCP 注册需要 | 使用技能、子智能体及桌面宿主工具 |
| `yaml` | 安装器安全解析并保留 profile YAML；由仓库依赖安装 |
| `@deepseek-ai/dsh-skill-filesystem` | 给 DSH 暴露共享技能目录 |
| `@deepseek-ai/dsh-hmr` | profile 配置与源码重载支持 |
| `@deepseek-ai/dsh-mcp-client`，可选 | 连接显式选择的外部 stdio MCP |

主桥和共享插件的执行代码使用 Node 内置模块；安装器有 `yaml` 依赖。DSH 本身及上述宿主插件不由本仓库发行，需要使用 DSH 支持的安装方式准备。原始接口研究检查的是 DSH `0.2.0-rc.2`；与其他发行版本兼容需要以当前运行验证为准。

## 首次安装

```sh
git clone https://github.com/G0aT-Shen/Codex-DSH-Bridge.git
cd Codex-DSH-Bridge
npm ci --ignore-scripts
npm test
```

`npm test` 是本机源码测试，不启动真实 DSH 模型任务。测试成功之后，先让活动任务收尾并退出 DSH，再安装用户技能和 profile 配置：

```sh
node scripts/install-skills.mjs --dry-run
node scripts/install-skills.mjs
node scripts/install-shared.mjs --dry-run
node scripts/install-shared.mjs
codex mcp add dsh-bridge -- node "$PWD/mcp.mjs"
```

`install-skills` 安装 `dsh-orchestrator` 和 `codex-dsh-shared`，把当前克隆的 CLI 绝对路径写入已安装技能。默认使用 `$CODEX_HOME/skills`，否则 `~/.codex/skills`。不同内容的已有技能默认拒绝覆盖；更新时显式使用 `--update` 并保留自动备份。

`install-shared` 默认操作 `~/.dsh/profiles/desktop`，协调自己拥有的插件条目，建立本地源码目录链接，并备份实际变更的 profile 文件。macOS 使用软链接，Windows 使用 junction，不需要管理员创建符号链接的权限。它不会运行模型，也不执行网络依赖安装。`--dry-run` 不创建目录、链接、备份或安装报告。实际应用变更前请退出 DSH，避免 profile 同时写入；检测到文件变化会拒绝继续。安装器不会为你选择模型或改变 DSH 的网络、审批和凭据设置。

dry-run 缺少前置 DSH 插件时会列出 missingPackages 并返回 exit 2；先安装对应宿主包再执行实际应用。实际安装发现缺包会在写入前拒绝，不会自动下载依赖。

| profile 条目 | 作用 |
| --- | --- |
| `codex-task-bridge` / `@hanyangshen/codex-bridge` | 桌面任务 worker、路径守卫与可选本地 HTTP API |
| `codex-shared` / `@hanyangshen/codex-shared` | 共享笔记、反向请求和公开会话读取 |
| `codex-shared-skills` / `@deepseek-ai/dsh-skill-filesystem` | 共享 Codex、agents 与可发现插件技能根目录 |
| `hmr` / `@deepseek-ai/dsh-hmr` | 监听当前源码目录并协调热重载 |
| `codex-shared-mcp-NAME`，可选 | 镜像用户指定且已启用的 stdio MCP 配置 |

安装只协调属于本项目的配置。若已有同名条目指向其他实现，先判断冲突来源，不要覆盖其他插件。

## 安装器参数

```text
node scripts/install-shared.mjs
  [--profile PATH]
  [--queue-dir PATH]
  [--codex-bin PATH]
  [--mcp-server NAME ...]
  [--skill-root PATH ...]
  [--no-hmr]
  [--dry-run]

node scripts/install-skills.mjs
  [--skills-dir PATH]
  [--update]
  [--dry-run]

node scripts/verify-shared.mjs
  [--root PATH]
  [--skill NAME ...]
  [--require-mcp NAME ...]
```

`--profile` 选择 profile 目录，可以是绝对或相对路径；它不是 profile ID，也不设置 DSH 的 Web 端口。`--queue-dir` 将同一个队列目录注入主桥和共享插件；省略时使用已有一致配置或默认目录。`--codex-bin` 仅在镜像 MCP 时用于调用 Codex CLI；通常可直接使用 PATH 中的 `codex`。`--skill-root` 可以重复添加共享技能根。`--no-hmr` 跳过 HMR 安装协调，不会禁用已有 HMR。

## Windows 原生部署

先安装 Windows 版本的 Node.js ≥22、Git、Codex 和可用桌面 DSH。打开 DSH 创建/初始化实际桌面 profile，配置模型和执行工具，并用 DSH 插件管理方式准备依赖，然后退出 DSH。示例从 PowerShell 执行：

```powershell
git clone https://github.com/G0aT-Shen/Codex-DSH-Bridge.git
Set-Location Codex-DSH-Bridge
$BridgeRepo = (Get-Location).Path
$DshProfile = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
$CodexCli = Join-Path $env:APPDATA "npm\codex.cmd"
npm.cmd ci --ignore-scripts
npm.cmd test
node scripts/install-skills.mjs --dry-run
node scripts/install-skills.mjs
node scripts/install-shared.mjs --profile "$DshProfile" --dry-run
node scripts/install-shared.mjs --profile "$DshProfile"
& $CodexCli mcp add dsh-bridge -- node "$BridgeRepo\mcp.mjs"
```

`npm.cmd` 可以避开 PowerShell 对 `npm.ps1` 的执行策略问题。`$CodexCli` 是标准 npm 安装路径示例；若使用原生 Codex，则设置为实际 `codex.exe`。安装器调用 MCP 清单时支持原生 exe、PATH 命令或标准 npm codex.cmd；对于 codex.cmd，它通过 Node 运行相邻的已知 Codex JS 入口，不把任意 cmd 文本交给 shell。非标准 cmd、bat 或 ps1 需换成原生 exe 或标准 npm shim。

队列通过硬链接发布任务和一次性回包，使用本地 NTFS 目录；FAT/exFAT 和部分网络盘不满足此条件。profile 和队列宜放在当前用户私人目录并继承合适的 NTFS ACL。Node 文件 mode `0600/0700` 在 Windows 不建立同等 Unix 权限，也不自动限制其他 Windows 用户。

如果 profile 位于中文或空格路径，显式赋值并保留引号，例如：

```powershell
$DshProfile = "D:\桌面工具\DSH 配置\desktop"
node scripts/install-shared.mjs --profile "$DshProfile" --dry-run
```

这是目录格式示例，须换成实际包含 package.json 与 cordis.patch.yml 的目录。普通桌面安装不需要 `--codex-bin`；只有显式镜像外部 MCP 时才传：

```powershell
node scripts/install-shared.mjs --profile "$DshProfile" --codex-bin "$CodexCli" --mcp-server lms --dry-run
node scripts/install-shared.mjs --profile "$DshProfile" --codex-bin "$CodexCli" --mcp-server lms
```

可选服务必须已配置且能在该 PC 独立运行。安装器复制配置，不会迁移另一台 Mac 的绝对路径、会话实例或账号登录态。

重新打开实际桌面 DSH；重连 Codex MCP 并新开 Codex 聊天，再验证：

```powershell
node cli.mjs health --json
node cli.mjs shared-status --json
node scripts/verify-shared.mjs
```

只有这些当前宿主检查和受监督的真实任务验收，才能证明用户 PC 的桌面联动。GitHub Actions 结果以对应提交的实际运行结果为准；CI 使用 fake DSH，不安装桌面应用，不访问账号或调用模型。

Windows 任务与回包 JSON 使用 `ConvertTo-Json` 配合 `[IO.File]::WriteAllText` 输出 UTF-8，再用 CLI 文件参数；不要用 PowerShell 5.1 的默认重定向写 JSON，它可能产生 UTF-16。完整任务与 `respond --file` 示例见[协议](protocol.md)。

### 自定义队列

默认队列是用户目录下的 `.local/share/dsh-codex-bridge`。如果更改队列，DSH 主桥、共享插件、CLI 与 Codex MCP 必须使用同一目录。macOS shell 示例：

```sh
node scripts/install-shared.mjs --queue-dir "$HOME/.local/share/my-dsh-bridge" --dry-run
node scripts/install-shared.mjs --queue-dir "$HOME/.local/share/my-dsh-bridge"
node cli.mjs health --root "$HOME/.local/share/my-dsh-bridge" --json
codex mcp add dsh-bridge --env DSH_CODEX_BRIDGE_ROOT="$HOME/.local/share/my-dsh-bridge" -- node "$PWD/mcp.mjs"
```

`mcp.mjs` 从 `DSH_CODEX_BRIDGE_ROOT` 读取队列；CLI 通过 `--root` 选择队列。安装器不会因为你给 DSH 设置自定义队列就自动改 Codex MCP 配置。活动任务存在时不要切换队列。

Windows PowerShell 对应命令：

```powershell
$BridgeQueue = Join-Path $env:USERPROFILE ".local\share\my-dsh-bridge"
node scripts/install-shared.mjs --profile "$DshProfile" --queue-dir "$BridgeQueue" --dry-run
node scripts/install-shared.mjs --profile "$DshProfile" --queue-dir "$BridgeQueue"
& $CodexCli mcp add dsh-bridge --env "DSH_CODEX_BRIDGE_ROOT=$BridgeQueue" -- node "$BridgeRepo\mcp.mjs"
node cli.mjs health --root "$BridgeQueue" --json
node scripts/verify-shared.mjs --root "$BridgeQueue"
```

### 可选 LMS 或其他 MCP

默认不镜像任何外部 MCP，也不要求 LMS。已在 Codex 配置并启用可移植 stdio 服务后，可以显式选择：

```sh
node scripts/install-shared.mjs --mcp-server lms --dry-run
node scripts/install-shared.mjs --mcp-server lms
node scripts/verify-shared.mjs --require-mcp lms
```

镜像的是启动配置，在 DSH 创建独立连接；不会共享 Codex 内存中的实例。LMS 的账号/profile 需要在该连接中单独确认，Canvas 客户端登录态并不等于 LMS 登录态。浏览器、CUA、会话 Node 环境与 Codex 桌面 UI 等宿主能力应通过监督者处理反向请求，不能靠复制 MCP 配置获得。

## 激活与验证

重新打开对应桌面 profile；未加载时重新启用插件或重启 DSH。新开 Codex 聊天并重连 MCP，让技能和工具表生效。安装报告只证明文件配置结果；HMR 支持也不保证当前版本已经成功重载。

```sh
node cli.mjs health --json
node cli.mjs shared-status --json
node cli.mjs shared-skill dsh-orchestrator --json
node cli.mjs shared-skill codex-dsh-shared --json
node scripts/verify-shared.mjs
```

主桥必须是 `alive:true`、`version:2`；共享服务的 `version:1` 是独立协议版本。共享状态应有四个 `codex_shared_memory` / `codex_shared_memory_put` / `codex_request` / `codex_request_wait` 工具。`portableMcp.lms:0` 在没有选择 LMS 时正常。

`verify-shared` 是当前宿主只读验证：不改 profile、不运行安装器、不发起模型任务、不写共享笔记，也不要求存在个人报告或历史笔记。它只检查当前基础能力、两套技能，以及你通过参数额外要求的技能/MCP。这些检查不能代替一次真实执行和主审验收。

在活动 Codex 监督下，可以另行运行会产生模型调用、临时文件及桥任务的真机测试：

```sh
node scripts/smoke-v2.mjs
node scripts/smoke-v2.mjs --full
node scripts/guard-check.mjs
node scripts/mcp-e2e.mjs
```

三个真机脚本都支持 `--root PATH` 选择自定义队列与 `--help` 查看参数。`--full` 包含返工验证；守卫测试尝试常见越界写入并检查拒绝证据，不证明完整 OS 隔离。以你本次真实输出为验收记录，不要引用历史测试数量证明当前部署通过。

## 更新

1. 先确认自己负责的任务和反向请求已收尾，保存主审证据；不要在任务运行时热改 worker。
2. 在克隆目录获取更新并检查差异，运行 `npm ci --ignore-scripts` 和 `npm test`。
3. 退出 DSH，运行 `install-skills --update --dry-run`、`install-shared --dry-run`，确认修改范围后分别执行实际安装；Windows 使用同样的 Node 命令并传实际 profile。
4. 等待 HMR 或重新加载桌面插件，重新执行 `health`、`shared-status`、`verify-shared`。
5. Codex MCP 进程可能持有旧源码或工具清单；重连这个服务，必要时用 CLI 兜底。

若移动克隆目录，技能、profile 依赖、软链接、HMR 根目录和 Codex MCP 路径都需要重新核对。旧路径冲突由安装器明确报错时，先处理本项目对应链接，不能通过覆盖未知目录消除冲突。

## 回退与卸载

profile 备份在原文件旁，后缀为 `.codex-bridge-backup-<timestamp>-<random>`。技能更新备份也在技能目录旁，使用同样形式。实际路径以安装器输出为准。

停止本项目拥有的任务并确认停止状态，然后关闭或禁用对应插件。对照备份恢复 profile 的 `package.json` 与 `cordis.patch.yml`；如果安装后有其他有效配置改动，逐项合并，只回退本项目条目，避免整份旧备份覆盖后来配置。移除本项目建立的源码链接前确认它确实是本项目软链接，保留其他包。

恢复技能备份或仅移除本项目安装的两个技能目录；若不再使用 MCP，执行 `codex mcp remove dsh-bridge`。之后重载 DSH 并检查状态。运行时队列包含任务证据与显式笔记，默认保留；不要为了卸载清空用户会话或共享数据。

本仓库没有一条可保证自动撤销所有后续 profile 改动的通用回退命令。不要手工读取或打印桥令牌；CLI 会内部处理本机服务认证。
