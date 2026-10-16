# 在自己的 Agent 中使用 ECharts Agent

[English](consumer-guide.en.md) · [返回 README](../README.md)

服务部署完成后，安装消费者技能并连接服务，就可以让自己的 Agent 整理数据、选择图表、调用渲染和交付图片。技能不需要服务端源码或 npm 依赖；确定性渲染不需要服务端配置模型。

## 安装两个技能

从本仓库下载或复制以下**完整目录**，保留其中的脚本、参考资料和样例。已存在同名技能时先比较版本和本地修改，再决定更新。

| 目录 | 用途 |
| --- | --- |
| [echarts-agent-connect](../skills/echarts-agent-connect/SKILL.md) | 连接已部署的服务，诊断认证和网络问题，验证可用能力 |
| [echarts-agent-chart](../skills/echarts-agent-chart/SKILL.md) | 将数据画成 SVG/PNG，保存结果并按反馈修改 |

| 本地宿主 | 个人技能目录 | 项目技能目录 |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | 用户工作项目的 `.agents/skills/` |
| Claude Code | `~/.claude/skills/` | 用户工作项目的 `.claude/skills/` |
| 其他支持 Agent Skills 的宿主 | 使用其技能安装入口或指定目录 | 以宿主文档为准 |

安装后的结构应为 `技能目录/echarts-agent-chart/SKILL.md`，不能只复制 `SKILL.md`。按宿主要求刷新技能或重新启动会话。两个技能可单独安装；已连接服务的用户只需画图技能。不支持技能的 Agent 仍可使用 MCP 工具或将技能内容作为任务参考，但需有网络调用能力。目录依据：[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Claude Code Skills](https://code.claude.com/docs/en/skills)（2026-10-16 核对）。

## 准备地址和认证

- 使用从 **Agent 实际执行环境**可访问的服务地址。远程容器或云端 Agent 的 `127.0.0.1` 指向它自身，不是用户电脑。
- MCP 地址为 `https://charts.example.com/mcp`；脚本使用服务 origin `CHART_URL=https://charts.example.com`。示例域名必须换成自己的部署。
- 需要认证时，通过宿主的凭据存储或启动环境提供 `SERVICE_API_KEY`，其值与服务端相同。不要把真实值写进技能、共享配置、命令参数或对话；也不要打印环境变量来排障。
- HTTP、MCP、A2A 共用服务端鉴权模式：有 `SERVICE_API_KEY` 时均要求 Bearer，即使 `ALLOW_ANONYMOUS=true`；无 key 且显式 `ALLOW_ANONYMOUS=true` 时均可匿名访问，否则服务拒绝启动。健康检查始终无需认证；OpenAPI 和两版 Agent Card 按当前模式声明安全要求。
- 桌面宿主不一定继承终端环境。确认变量存在于启动 Agent 的进程环境；仅在另一个终端设置通常无效。仅对部署方已明确启用匿名的服务省略认证。

技能提供工作流，不会自动安装 MCP/A2A 协议支持。优先选择已有的原生 MCP，已有 A2A 编排器时用 A2A；只有终端/HTTP 工具或需要可靠保存图片时，可使用下面的脚本。

## Codex：远程 MCP

在已注入 `SERVICE_API_KEY` 的环境中注册服务（只传变量名）：

```bash
codex mcp add echarts-agent --url https://charts.example.com/mcp --bearer-token-env-var SERVICE_API_KEY
codex mcp list
```

也可将以下节合并到现有 `~/.codex/config.toml`，不要覆盖其他配置；这与上面的注册方式二选一。此处增加 90 秒工具时限，以覆盖可选生成操作的耗时。

```toml
[mcp_servers.echarts-agent]
url = "https://charts.example.com/mcp"
bearer_token_env_var = "SERVICE_API_KEY"
tool_timeout_sec = 90
```

匿名服务省略 Bearer 配置。固定服务 key 不使用 OAuth 登录流程。重载连接后可以说：

> 使用 $echarts-agent-connect 检查已配置的图表服务，用合成数据生成一张样例 PNG。

> 使用 $echarts-agent-chart，把这份 CSV 按月份汇总金额，生成报告用柱状图，保存为 monthly.png。

配置字段依据：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，CLI 参数另经本机 `codex mcp add --help` 核对。宿主工具名可能带服务前缀，技能会按实际发现的工具使用。

## Claude Code：远程 MCP

在用户工作项目的 `.mcp.json` 中合并以下配置，保留其他服务器。`${SERVICE_API_KEY}` 是由 Claude Code 从启动环境展开的引用，不要替换成明文密钥。

```json
{
  "mcpServers": {
    "echarts-agent": {
      "type": "http",
      "url": "https://charts.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${SERVICE_API_KEY}"
      }
    }
  }
}
```

匿名服务移除 `headers`。重新加载连接并用 `/mcp` 检查状态；遵循客户端自己的项目配置确认流程。可以使用 `/echarts-agent-connect` 或 `/echarts-agent-chart` 显式调用技能，也可以自然语言提出需求。配置与环境展开依据：[Claude Code MCP](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)。其他桌面产品的配置文件不一定兼容此格式。

## 通用 MCP 客户端

选择 **Streamable HTTP**，填写 `/mcp` 地址和 Bearer 凭据。服务不提供 stdio 或独立的旧式 SSE 地址。连接后先列举工具并调用 `get_chart_capabilities`：

| 输入/目标 | 选择 |
| --- | --- |
| 数据和画图需求 | 当前 Agent 生成 ChartSpec，调用 `render_chart`，无需服务端模型 |
| 已有 ECharts JSON option 或精细布局 | `render_echarts`，遵守静态 option 限制 |
| 将选图规划委托给服务端模型 | 仅在工具存在时调用 `generate_chart` |

`ai.status=ready` 表示配置完整，不证明供应商可达。`generate_chart` 会把意图、字段信息、行数和前 5 行有界样例发送给配置的模型供应商；其他两种渲染不会调用服务端模型。

PNG 在 MCP `image` 内容中，SVG 在 `text` 中，`structuredContent` 提供元数据；服务没有下载 URL，也不会直接写入用户电脑。有的客户端能展示图片但无法保存工具的原始字节，此时可用 HTTP 脚本重新提交同一请求并保存，报告实际路径。不要把 `requestId` 当成图表 ID；再次修改需提交完整请求。

## 只有终端能力：独立 HTTP 脚本

需要 Node.js 22 或更高版本，无需 `npm install`。以下从下载后的仓库根目录执行；安装技能后将脚本路径替换为实际技能目录。脚本只读取环境中的凭据，不读取项目 `.env.local`。

```bash
export CHART_URL=https://charts.example.com
node skills/echarts-agent-connect/scripts/check-service.mjs
node skills/echarts-agent-chart/scripts/chart-client.mjs capabilities
node skills/echarts-agent-chart/scripts/chart-client.mjs chart skills/echarts-agent-chart/assets/report-bar.json report.png
```

`SERVICE_API_KEY` 应预先由安全的启动环境注入。`check-service` 检查渲染就绪和带认证的能力查询；能力检查成功后，还需实际生成图片才算画图验证完成。示例使用合成数据。

客户端支持 `chart request.json output.png`、`render request.json output.svg` 和 `generate request.json output.png`，请求体分别对应 `/v1/charts`、`/v1/render`、`/v1/generate`。输出后缀须与请求格式一致；生成接口返回的 JSON 会先提取图片再保存。程序拒绝覆盖已有文件，换一个输出路径即可保留旧版。

脚本的 `generate` 仅保存图片，不导出最终规划与 warnings。需要复核生成的字段映射、保留完整规划并精确修改时，使用原生 MCP/HTTP 获取这些字段，或由当前 Agent 生成可复用的 ChartSpec 后运行 `chart`。

脚本要求 `CHART_URL` 为 origin，不接受凭据、查询参数或路径前缀；HTTP 重定向也会拒绝。默认整次检查 15 秒、画图客户端 90 秒；可用 `CHART_TIMEOUT_MS` 设置 100–120000 毫秒。超时或失败不自动重试，不把错误响应保存成图片。输入文件限 1 MiB，响应读取有大小上限。

## 已有 A2A 编排器

请部署方先设置 `A2A_ENABLED=true` 并配置正确的 `A2A_PUBLIC_URL`；此开关独立于鉴权模式，消费者技能不自行修改服务部署。有服务 key 时，发现卡片和调用都需要 Bearer；显式匿名模式下均可省略：

1. `GET /.well-known/agent-card.json`，带 `A2A-Version: 1.0`，检查支持的接口与操作。
2. 向 `/a2a` 发送 `SendMessage`，仍带版本头。消息只包含一个结构化 `data` part，内容为 `{operation:"chart"|"render"|"generate", request:对应HTTP请求体}`；不能只发一句自然语言或上传 CSV。
3. 需要异步时设置 `configuration.returnImmediately=true`，保存返回的任务 ID，使用 `GetTask` 查询；仅在用户取消时调用 `CancelTask`。按终态停止轮询并设置总期限，不因查询失败重新提交任务。
4. 成功后从 `result.task.artifacts[].parts[].raw` 解码图片；`GetTask` 的任务直接位于 `result`。检查 `mediaType` 并保存，不把 base64 当成下载链接。

完整消息样例、0.3 兼容路径及状态处理见画图技能内的 [A2A 参考](../skills/echarts-agent-chart/references/a2a.md)。已有 SDK 项目可参考 [官方 JS SDK 客户端示例](../examples/a2a-client.mjs)，该示例需仓库依赖，与无依赖 HTTP 脚本不同。

A2A 默认关闭，任务只在内存保留，终态最多 10 分钟且可能提前淘汰，重启丢失。没有任务续写、文件输入、流式或推送通知。有 key 时，相同 key 的调用方共享任务访问范围；匿名时，所有可访问实例的调用方共享任务范围，知道任务 ID 即可读取或取消任务。Agent Card 中的 `skills` 声明服务能力，安装到本机的 `SKILL.md` 提供操作指导。

## 验收与排障

用合成数据完成一次能力查询、PNG 保存以及“换横向、加单位”的重绘，再接入实际业务数据。结果应能打开，数值与输入相符，能指出文件位置；宿主具备视觉能力时再检查标签、图例和截断。

| 现象 | 下一步 |
| --- | --- |
| 连接失败或 404 | 核对执行环境能否访问地址、MCP 路径和代理；A2A 还需确认部署方已启用 |
| 401 | 核对宿主进程中的凭据与目标服务，不打印密钥，不重复提交相同请求 |
| 无 `generate_chart` / AI 不可用 | 当前 Agent 生成 ChartSpec 并用确定性渲染；无需为画图启用服务模型 |
| 422 / MCP `isError` | 检查实际错误、字段类型和图表语义；模型 schema 不涵盖所有运行时限制 |
| 413 / 输出超限 | 缩小图片；MCP/A2A base64 封装也占体积，必要时用 HTTP 获取二进制 |
| 429 / 超时 | 降低并发或复杂度；有界重试前先判断原因，A2A 查询已有任务避免重复提交 |
| 图片显示但没有文件 | 检查宿主是否能取到工具原始内容；必要时走 HTTP 保存，不编造下载 URL |

服务只接受整理好的 JSON 数据，不负责 CSV/Excel 解析、聚合、补点或长期存储。图表支持范围、尺寸与数据语义见 [README](../README.md#支持哪些图表)。技能安装和客户端配置说明经官方文档核对；具体桌面宿主的权限、凭据注入及图片展示仍需在消费者环境验收。
