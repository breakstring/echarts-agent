# 消费者技能与接入说明验收

日期：2026-10-16。验证运行时为 Node.js 24.16.0；客户端脚本使用 Node.js 22+ 内置模块，无额外 npm 依赖。

## 交付范围

- `skills/echarts-agent-connect`：已部署服务的连接、认证与能力诊断，独立健康检查脚本，MCP/A2A/HTTP 参考及合成数据验证请求。
- `skills/echarts-agent-chart`：选图、数据准备、12 类 ChartSpec 映射、图片交付和请求修改；独立 HTTP 客户端及报告柱状图样例。
- 中英文消费者指南、README 入口和 MCP 工具/参数说明。服务端改动仅为描述元数据，未改变请求字段、校验、默认值、模型调用条件或响应结构。

## 自动化与合同检查

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 52 项通过，0 失败、0 跳过；含新增消费者客户端 9 项 |
| 两个技能的 `quick_validate.py` | 均通过，名称/frontmatter/未完成模板检查通过 |
| README、双语指南和技能文档检查 | 10 个 Markdown 文件、53 个相对链接、8 个顶层 JSON 代码块、2 个 TOML 配置块、35 个 shell 代码块通过解析或语法检查 |
| 技能样例合同 | 4 个完整请求通过 `chartRequestSchema`、`compile` 和 `prepareOption` |
| 实际 MCP 工具发现 | 无模型服务发现 3 个基础工具；描述和 `spec`/`output`/`option` 参数说明可由官方 SDK 读取 |
| `git diff --check` | 通过 |

消费者客户端测试将两个脚本复制到临时目录执行，证明不依赖仓库源码或 node_modules。覆盖真实 PNG/SVG、ChartSpec/raw option、生成接口 artifact 解码、已有文件保护、401/422、1 MiB 输入限制、origin/后缀检查、重定向拒绝、错误日志脱敏、响应大小/MIME/图片结构检查、总超时及 SIGINT 取消。失败不保存错误响应，不隐式重试。

上述自动化生成测试使用本地 mock planner；网络测试仅监听本机随机端口，使用合成数据和测试凭据，不读取 `.env.local` 或访问真实模型供应商。后续真实模型验收单独记录如下。

## 独立消费者试用

将两个完整技能复制到临时目录，给独立代理一份 5 行合成 CSV、已启动服务的 origin 和合成测试凭据。代理只读取技能及输入材料，通过终端 HTTP 路径完成连接检查、合成样例、按月汇总和两次制图；未提供项目源码上下文。

- 月份升序汇总：2026-01 为 30 元，2026-02 为 45 元，2026-03 为 50 元；总计 125 元，无丢行或单位换算。
- 保存纵向与横向 PNG，均为 2400×1440；主代理读取图片字节并检查实际像素。
- 两份可复用请求只相差 `spec.horizontal: true`，数据、标题、单位和样式保持一致。
- 逐张查看图片，标题、金额单位图例和柱形可见；横向默认类别顺序为自下而上递增。
- AI 状态 disabled，整个试用未调用模型。没有把 HTTP 验证表述为原生 MCP/A2A 宿主接入成功。

合成 CSV、请求与两张图片保留在本地被 Git 忽略的 `artifacts/consumer-skills/` 中。

## 本机 Docker、Codex 安装与真实模型验收

用户追加授权后，从当前工作区构建并启动本机 ARM64 容器，使用既有 `.env.local` 的真实模型配置。详细结果见 [本机 Codex 验收记录](2026-10-16-local-codex.md)。

- 服务固定监听 `127.0.0.1:3300`，启用 MCP、A2A 和真实 LLM；使用独立随机服务 key，关闭匿名访问。模型配置只读挂载，不写入镜像或 Codex 配置。
- 两个完整技能安装到 `~/.agents/skills/`；与仓库的 9 个文件逐一校验一致。Codex 的 `echarts-agent-local` 使用 Streamable HTTP 和私有 header helper 注入认证。
- 当前 Codex 桌面聊天实际发现并调用 4 个工具；ChartSpec 返回 PNG、raw option 返回 SVG，真实 `generate_chart` 返回 PNG 以及 `spec`、`option`、`warnings`，均保存为本地证据。
- 真实模型请求采用三行合成数据，返回约 5.6 秒，月份及数值 `120、156、180` 与输入一致，中文标题和单位可见。
- 全新 Codex CLI 0.163.0 实际读取已安装技能，通过原生 MCP 完成合成 CSV 月汇总、纵向 PNG 及横向重绘；原始事件、请求参数与图片字节均核对通过。图片由验收运行器解码 MCP image block，再由 CLI 保存、校验。
- A2A 1.0 结构化制图、真实模型生成和 0.3 兼容渲染均完成并交付 PNG；Agent Card、401 认证拒绝、终态查询和实际图像读回均通过。

## 验证边界

Codex/Claude Code 安装与配置示例依据当日官方文档；Codex CLI 参数另经本机帮助核对。本机已实际安装和调用 Codex；其他宿主、机器的权限、凭据继承和图片展示仍需单独验收。Node.js 22 的最低运行版本未单独执行矩阵测试。

本次没有发布镜像或部署生产。HTTP 脚本的 `generate` 仅保存图片，不导出计划；A2A 同样只返回图像 artifact，需要复核/保留 `spec`、`option`、`warnings` 时使用原生 MCP/HTTP 生成响应，或由调用方生成明确的 ChartSpec。
