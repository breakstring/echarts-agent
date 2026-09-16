# ECharts Agent

单个 Node.js 容器，通过 HTTP、MCP 和可选 A2A 接收 ECharts JSON option、ChartSpec 或“结构化数据＋自然语言意图”，直接返回 SVG/PNG。调用方负责保存图像。

TypeScript + Fastify + ECharts SSR + Sharp；Mastra 负责可选模型设计，官方 SDK 负责 MCP/A2A 协议。基础渲染不依赖模型、浏览器、数据库或外部网络。百炼 `qwen3.8-flash` 已完成真实联调。

## 本地运行

需要 Node.js 24.16.x。

```bash
npm ci
ALLOW_ANONYMOUS=true HOST=127.0.0.1 npm run dev
```

`npm run dev` 自动读取已有 `.env.local`，不会修改文件。配置说明见 [.env.example](.env.example)。支持现有小写 `llm_provider / llm_default_model / llm_api_key / llm_base_url`，也支持大写 `LLM_PROVIDER / LLM_MODEL / LLM_API_KEY / LLM_BASE_URL`，大写优先。未提供模型 key 时禁用 AI；`LLM_ENABLED=false` 可强制关闭。配置状态 `ready` 表示配置完整，供应商可达性以实际请求为准。

默认要求 `SERVICE_API_KEY`；仅本地调试时显式设 `ALLOW_ANONYMOUS=true`。设置了 key 时，即使开启匿名开关仍要求 Bearer 认证。除健康检查外，HTTP、OpenAPI、MCP、A2A 和 Agent Card 都使用同一 key。

## HTTP 调用

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/charts \
  -H 'Content-Type: application/json' \
  --data '{"spec":{"type":"bar","title":"月度数量","data":[{"month":"一月","count":12},{"month":"二月","count":18}],"encoding":{"x":"month","y":["count"]}},"output":{"format":"png","width":960,"height":540,"pixelRatio":2}}' \
  --output chart.png
```

开启鉴权时增加 `Authorization: Bearer <SERVICE_API_KEY>`。

| 入口 | 返回 |
| --- | --- |
| `POST /v1/render` | `{option,style?,output?}` → SVG/PNG 字节 |
| `POST /v1/charts` | `{spec,style?,output?}` → SVG/PNG 字节 |
| `POST /v1/generate` | `{data,intent,style?,output?}` → 最终 spec/option/warnings/artifact JSON |
| `GET /v1/capabilities` | 图表类型、主题、限额、AI 配置状态 |
| `GET /openapi.json` | 从共享 Zod Schema 生成的 OpenAPI 3.1 |
| `GET /health/live`、`GET /health/ready` | 存活与渲染进程就绪 |

`artifact` 含 `mimeType / width / height / bytes`，SVG 使用 `svg` 文本，PNG 使用 `base64`。成功图片带 attachment、no-store、nosniff、request ID；错误为有明确状态码的 JSON。无文件下载地址和服务器本地路径。

支持 **12 类静态图表**：`bar / line / pie / scatter / radar / gauge / funnel / heatmap / tree / treemap / sunburst / sankey`，主题 `light / dark / report`。字段与数据语义见 [冻结合同](docs/specs/2026-09-16-echarts-agent-design.md)，可运行例子见 [examples](examples)。SVG 的字体仍依赖接收方；需要固定中文外观时使用 PNG。

新增仪表盘、漏斗图、热力图、树图、矩形树图、旭日图和桑基图，三种协议与自然语言生成共用同一能力。新增类型的请求示例见 [examples/extended](examples/extended)。层级图传入节点表（`id / parent / name / value`，根节点 parent 为空字符串）；桑基图传入边表（`source / target / value`）。服务校验结构，不替调用方补写节点或聚合数值。

## MCP

入口 `http://127.0.0.1:3000/mcp`，无状态 Streamable HTTP。已验证官方 TypeScript SDK 1.30.0，协议修订 `2025-11-25`。

- `get_chart_capabilities`：查询能力。
- `render_echarts`、`render_chart`：与 HTTP 共用合同。
- `generate_chart`：仅 AI 配置完整时注册。

PNG 返回标准 `image` content；SVG 返回原始 `text` content；`structuredContent` 包含尺寸、MIME 和 request ID，生成工具还包含最终 spec/option/warnings。每次请求均携带 Bearer key，无需单独配置 MCP 模型。没有 stdio、OAuth 或服务端持久会话。关闭执行请求的连接会取消下游；独立的取消通知不提供跨请求关联保证，需要按任务ID取消时使用A2A。示例：[MCP 客户端](examples/mcp-client.mjs)。

## Docker

```bash
docker build -t echarts-agent:local .
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  -e ALLOW_ANONYMOUS=true -e LLM_ENABLED=false \
  echarts-agent:local
```

镜像固定 Node 基础镜像摘要与 npm lock，内置 OFL 许可的 Noto Sans CJK SC，非 root 运行，tini 负责信号与子进程回收。上例是 loopback 本地服务。服务间部署设置随机 `SERVICE_API_KEY`，通过环境变量或 secret 注入；有模型时需要允许访问部署者设置的 Provider。

使用已有 Node `.env.local`（允许引号）的本地容器调用可挂载该文件，让 Node 解析：

```bash
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  -e ALLOW_ANONYMOUS=true \
  --mount type=bind,src="$PWD/.env.local",dst=/run/provider.env,readonly \
  echarts-agent:local node --env-file=/run/provider.env dist/main.js
```

此方式需要容器用户能读取挂载文件。生产环境使用 secret 注入；不把 `.env.local` 放入镜像。Docker 自带 `--env-file` 与 Node 的引号解析规则不同，应使用其要求的无引号格式。

## 可选 A2A

设置 `A2A_ENABLED=true`、`A2A_PUBLIC_URL=http://127.0.0.1:3000` 和 `SERVICE_API_KEY` 后启用。默认关闭；匿名模式不能启用。

Agent Card：`/.well-known/agent-card.json`；JSON-RPC：`/a2a`。锁定官方 SDK 0.3.14 / A2A wire 0.3.0，仅支持 `message/send`、`tasks/get`、`tasks/cancel`。单个结构化 data part：`{operation:"render"|"chart"|"generate",request:对应HTTP请求体}`。响应 Task 的 artifact 内含 `file.bytes`（base64），不返回 URL。

设置 `configuration.blocking=false` 可先取得任务 ID，再查询或取消。任务结束后内存最多保留10分钟，最多100条、序列化内容合计64MiB，容量压力时提前淘汰已结束任务；重启丢失。每个服务 key 是一个共同信任域，不提供多租户隔离。无任务续写、外部文件输入、streaming、push notifications。示例：[A2A 客户端](examples/a2a-client.mjs)。

## 验证

```bash
npm run typecheck
npm test
npm run smoke:live                         # 会发送真实模型请求；读取 .env.local
npm run build && node --env-file-if-exists=.env.local scripts/smoke-extended.mjs  # 新增七类真实模型验收
node scripts/smoke-docker.mjs echarts-agent:local
node scripts/smoke-docker.mjs echarts-agent:local --a2a --live
```

Docker smoke 自动创建、验证并移除本项目临时容器；无 `--live` 时使用 `--network none`。测试输出仅记录安全元数据。模型只接收意图、字段类型、行数和前5行有界样例；真实数值由本地代码绑定，最多两次模型调用、60秒总时限、并发2。Provider 错误不自动重试，本地计划字段校验失败允许一次修正。

[新增七类验收](docs/verification/2026-09-16-extended.md) · [首版验收证据与限制](docs/verification/2026-09-16.md) · [设计合同](docs/specs/2026-09-16-echarts-agent-design.md) · [Roadmap](docs/project/roadmap.md) · [Linear](docs/project/linear.md) · [完成记录](docs/project/progress-log.md)
