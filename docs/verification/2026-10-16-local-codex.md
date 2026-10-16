# 本机 Docker 与 Codex 消费者验收

日期：2026-10-16。用户明确授权本机部署、读取既有 `.env.local` 配置真实 LLM、启用 MCP/A2A、安装消费者技能并实际调用。仅使用合成数据验收。

## 持久部署与安装

| 项目 | 实际状态 |
| --- | --- |
| Docker | 本机 OrbStack，ARM64；容器 `echarts-agent-local` |
| 镜像 | `echarts-agent:consumer-skills-local`，当前工作区构建 |
| 镜像 ID | `sha256:e9567ef4571160d31edc2fffee4548c464b99250eb3ee29ce92f9fd348a161cc` |
| 服务 origin | `http://127.0.0.1:3300`，仅绑定本机 |
| MCP | `/mcp`，Streamable HTTP，Codex 注册名 `echarts-agent-local` |
| A2A | `/.well-known/agent-card.json`、`/a2a`，1.0 与 0.3 |
| 模型 | 从原有 `.env.local` 只读挂载到 `/run/provider.env`，由 Node 解析；LLM 已启用 |
| 认证 | 独立随机服务 key；匿名关闭；Codex header helper 在进程内注入 Bearer |
| 运行限制 | 用户 `node`、只读根、移除 capabilities、`no-new-privileges`、768 MiB、2 CPU、128 PID |
| 持久配置 | `~/.config/echarts-agent/local/compose.yaml`、`service.env`、`http-headers.mjs`；目录 0700、文件 0600 |
| 重启策略 | `unless-stopped`；验收结束后保持运行 |
| 技能 | `~/.agents/skills/echarts-agent-connect`、`~/.agents/skills/echarts-agent-chart`；完整 9 文件与源码一致 |
| Codex 配置 | 在既有 `~/.codex/config.toml` 中添加单个目标 MCP；原配置备份于私有部署目录 |

LLM 凭据没有写入镜像、技能或 Codex 的 MCP 配置。私有 header helper 不依赖桌面进程继承终端环境；其标准输出仅供 Codex 读取，不作为诊断命令执行。

本机管理命令（在本次部署的用户账号下执行）：

```bash
docker compose -p echarts-agent-local -f ~/.config/echarts-agent/local/compose.yaml ps
docker compose -p echarts-agent-local -f ~/.config/echarts-agent/local/compose.yaml stop
docker compose -p echarts-agent-local -f ~/.config/echarts-agent/local/compose.yaml up -d --wait
```

## 当前 Codex 桌面原生 MCP

4 个工具均由当前聊天实际发现并调用；没有用 HTTP 请求替代原生 MCP 证据。

| 调用 | 结果 | 请求标识 |
| --- | --- | --- |
| `get_chart_capabilities` | 12 类、SVG/PNG、AI `ready` | 能力响应不含请求标识 |
| `render_chart` | 1200×720 PNG，38,117 字节 | `6b0948bd-d401-4e40-abe9-6379ecc51cc6` |
| `generate_chart` | 真实模型约 5,550 ms，1200×720 PNG，36,651 字节 | `098d678f-a453-408f-9d04-e39496c91704` |
| `render_echarts` | 960×540 SVG，3,618 字节 | `c6132b3f-44e2-49bf-a3b9-74dfb66b1054` |

模型生成结果为折线图：2026-07/08/09 对应销售额 120/156/180 万元，逐项与原始合成输入一致。保存并复核完整 `spec`、`option` 和 `warnings`，没有忽略模型复核提示。两张 PNG 已直接查看，中文标题、单位、月份与图形可见，无标签遮挡；SVG 已确认真实 XML 图片内容与尺寸。

图像、完整请求和返回元数据保存在 Git 忽略的 `artifacts/consumer-skills/mcp-live/`。原生 MCP 返回的图片由客户端解码保存；服务没有下载 URL。日志检查只输出统计，已检查的容器日志未匹配配置中的密钥值。

## 全新 Codex 进程的技能实测

使用本机 Codex CLI 0.163.0 启动 `exec --ephemeral --json`，工作目录为隔离的临时目录，读取真实保存的用户配置；只在该次进程中关闭无关 MCP/插件。任务明确调用 `$echarts-agent-connect` 与 `$echarts-agent-chart`，输入为五行合成 CSV。进程正常结束，退出码 0。

- `item_2`：实际读取 `~/.agents/skills/` 内两个技能的 `SKILL.md`、所需 references 和样例。
- `item_3`：通过保存的 `echarts-agent-local` 配置调用原生 `get_chart_capabilities`。
- `item_9`、`item_11`：分别调用原生 `render_chart`，生成纵向、横向 PNG。按月汇总为 2026-01＝20,000 元、02＝24,000 元、03＝25,000 元，单位和总量保留。
- 主代理直接读取原始事件：保存的请求与实际工具参数一致；两份请求唯一差异为 `spec.horizontal: false → true`。保存图片与原始 MCP image block 解码字节完全一致，均为 1200×720；文件大小分别 37,679 与 39,012 字节。图片已视觉检查。

图片保存分工明确：验收运行器从原生 MCP 的 image block 解码为文件，再由 CLI 复制成命名产物并核对；没有用 HTTP 重新画图或本地渲染替代 MCP。此项证明真实技能指导、MCP 调用与有图片保存能力的宿主组合可用，不把它表述为 CLI 自动导出所有 MCP 图片。

CLI 未使用 `generate_chart`，服务端 LLM 验证由前述桌面原生 MCP 和后述 A2A 独立完成。完整事件、简化事件、请求、图片与 `verification.json` 保存在 `artifacts/consumer-skills/codex-live/`。最初一次 CLI 临时覆盖参数错误在初始化前退出，修正运行器的 dotted key 后使用同一已保存配置通过，未改写目标配置。

## A2A 实际链路

通过 Node.js 24 的 `fetch` 发起真实 JSON-RPC wire 请求，使用服务的同一 Bearer，按版本分别读取 Agent Card、提交任务并每 2 秒查询。两版 Card 均指向本机 `/a2a`，包含 `render` 和 `generate`；未带认证的 A2A POST 返回 401 / `UNAUTHORIZED`。

| 路径 | 终态 | 耗时（含查询间隔） | PNG | Task ID |
| --- | --- | --- | --- | --- |
| 1.0 `chart` | `TASK_STATE_COMPLETED` | 2.027 s | 960×540 | `7272c224-4291-4fc0-8c2a-e237e1e350d2` |
| 0.3 `render` | `completed` | 2.018 s | 800×480 | `0cb1f9f4-90fb-4628-9f61-490d2d4736ee` |
| 1.0 真实 `generate` | `TASK_STATE_COMPLETED` | 4.022 s | 960×540 | `12f33464-0245-4590-bf3d-7533369a83c6` |

确认 1.0 `raw` 与 0.3 `file.bytes` 的 base64 解码；全部图片经文件长度、PNG 魔数、实际尺寸、SHA-256 读回检查。三张图均已视觉复核；真实生成图按输入月份展示收入 120/150/180 万元与成本 80/90/110 万元，中文标题和图例完整。A2A 只交付图片，不提供模型的 `spec` / `option`，因此没有将图片视觉检查描述成模型方案结构检查。

证据、图片和可复现脚本在 `artifacts/consumer-skills/a2a-live/`；最终成功记录为 `evidence-2026-10-16T03-03-53.276Z.json`。首次沙箱本机访问在发出服务请求前返回 `EPERM`，提升本机网络权限后通过；未重提或自动重试任何模型生成任务。未查询供应商计量，不推断模型内部实际调用次数。

## 验证范围

本次部署和验收针对本机 ARM64 与当前 Codex；不代表其他 Agent 宿主、远程网络或生产负载已经验收。原有 typecheck 和 52 项自动化测试结果见 [消费者技能验收](2026-10-16-consumer-skills.md)，本次没有改变业务代码。上述验收阶段未提交或推送 Git、发布镜像、部署生产；GitHub 提交与推送由后续单独授权执行。
