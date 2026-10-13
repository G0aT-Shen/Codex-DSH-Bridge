# 架构与验证

本仓库提供桌面 DSH 插件、Codex stdio MCP 入口与可直接使用的 CLI。模型由 DSH 宿主运行，桥负责调度与证据，不包含 DSH 或 Codex 应用程序。

| 模块 | 职责 |
| --- | --- |
| `boot.js` | 主插件入口，注册 worker、应用层路径守卫和可选 HTTP 路由 |
| `worker.js` | 单队列 worker，桌面会话创建、预算、状态、事件采集、纠偏与返工 |
| `protocol.js` | 任务校验、状态与证据存储、原子入队、审查包、路径规则 |
| `cli.mjs` | 共用命令实现及 CLI 入口；UTF-8 JSON 文件参数 |
| `mcp.mjs` | 20 个工具与 job 资源，以 NDJSON stdio 对接 Codex |
| `http.mjs` | 挂在 DSH webServer 的本地派工命令接口与服务发现 |
| `shared.mjs` | 公开视图、显式笔记 revision、一次性能力回包、共享服务客户端 |
| `shared-plugin/boot.js` | DSH 侧四个共享工具、技能与公开原生会话读取 |
| `scripts/` | 可复用安装、技能展开、只读宿主核查与可选真机测试 |
| `skills/` | 主协调审核与子智能体联络工作约定；安装器绑定实际仓库路径 |

CLI、MCP 和 HTTP 派工接口复用命令实现。任务通过文件队列原子入队，worker 在桌面工作区执行，状态和证据写回本机。共享插件关联当前 bridge session，使反向请求携带 job ID；原生会话请求可能没有 job ID。主智能体独立审查后写入 review，默认下游依赖主审 accepted。

## 跨平台实现

所有入口使用 Node.js 22+。路径通过 `node:path` 和文件 URL 处理；Windows 路径比较识别驱动器、大小写及已有 junction。安装器在 Windows 建立 directory junction，在 macOS/Linux 建立目录软链接。标准 npm Codex cmd shim 通过已知 JavaScript 入口启动，避免 shell 拼接。

PowerShell 常见文件命令支持静态目标检测，包括字面数组路径；动态变量、通配符、表达式、脚本块及未知工具不保证覆盖。Windows 设备名不用于 job ID 或共享笔记 key。JSON 接受 UTF-8 BOM，复杂回包可从 `--file` 读取；时区默认使用系统 IANA 设置。Windows 队列使用支持硬链接的本地 NTFS，目录隐私依赖实际 ACL。

## 验证层次

| 检查 | 能证明什么 | 不覆盖什么 |
| --- | --- | --- |
| `npm ci --ignore-scripts` | 锁文件与安装器依赖可复现 | 桌面宿主插件是否存在 |
| `npm test` | fake DSH 下的队列、返工、依赖、请求、协议、路径与隔离安装 fixture | 真实应用、模型、账号与宿主版本兼容 |
| GitHub Actions | Ubuntu/macOS/Windows，各 Node 22 与 24 的上述检查 | Windows PC 的真实 DSH 联动 |
| `verify-shared` | 当前桌面心跳、共享工具广告、两套技能实际加载 | 模型执行、学校 API 请求、端到端任务 |
| live smoke 与主审 | 本次实际任务产物、所采集证据与独立验收 | 所有副作用、完整 OS 沙箱、其他版本宿主 |

本次本地发布核查在 macOS / Node 24.21.0 运行，76 项测试通过；JavaScript 语法、JSON、文档链接与两套技能结构已核对。跨平台 CI 是否通过，以 [对应提交的实际 Actions 结果](https://github.com/G0aT-Shen/Codex-DSH-Bridge/actions/workflows/ci.yml) 为准，不用历史结果证明新提交。

本次还通过专职联络子智能体监督桌面 DSH 完成只读发布审查，由主智能体独立核对可操作发现。该审查不替代测试；现场一次 steer 入队后未送达，journal 记录 AbortSignal 接口错误。发布源码为初始 prompt 与 steer 都传入 signal，fake host 回归检查成功；本次未重部署活动桌面插件，因此不声称现场纠偏已修复。

原始审查报告、请求回包、用户历史、认证与原生事件保留在本机。本仓库仅发布可复用实现和汇总说明。
