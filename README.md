# ECharts Agent

**简体中文** · [English](README.en.md)

把结构化数据变成可直接保存的图表图片。ECharts Agent 是一个可自行部署的单容器服务：通过 HTTP、MCP 或 A2A 接收数据，输出 **SVG / PNG**，支持 **12 类静态图表**。可选接入大模型，让调用方用自然语言描述图表需求。

适合为 AI Agent、报告系统和后端应用生成图表。基础渲染无需模型、浏览器或数据库；图片直接返回给调用方，不需要配置对象存储。

## 选择一种输入方式

| 你已有的内容 | 使用方式 | 是否需要模型 |
| --- | --- | --- |
| 数据和明确的图表类型 | ChartSpec：指定类型与字段映射 | 否 |
| ECharts JSON option | 直接渲染支持范围内的 option | 否 |
| 数据和一句图表需求 | 自然语言生成：模型选择类型和字段映射 | 是 |

模型不生成业务数据。程序会把原始数据绑定到图表计划中；数据聚合、补全和清洗应由调用方提前完成。

## 快速开始

需要 **Node.js 24.16.x** 和 npm。以下命令使用本机匿名模式，不调用模型。

```bash
git clone https://github.com/breakstring/echarts-agent.git
cd echarts-agent
npm ci
ALLOW_ANONYMOUS=true HOST=127.0.0.1 LLM_ENABLED=false npm run dev
```

在另一个终端进入项目目录，生成第一张图片：

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/charts \
  -H 'Content-Type: application/json' \
  --data-binary @examples/chart.json \
  --output chart.png
```

打开 `chart.png` 即可查看结果。检查服务状态：

```bash
curl --fail-with-body http://127.0.0.1:3000/health/ready
```

`npm run dev` 会编译代码并读取已有 `.env.local`。如果该文件配置了 `SERVICE_API_KEY`，请求仍需 Bearer 认证，即使设置了 `ALLOW_ANONYMOUS=true`。

## 使用 Docker

### 使用 GHCR 预构建镜像

正式版镜像地址：`ghcr.io/breakstring/echarts-agent`，支持 Linux AMD64 和 ARM64。镜像设为 Public 后无需登录即可拉取：

```bash
docker pull ghcr.io/breakstring/echarts-agent:0.1.0
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  -e ALLOW_ANONYMOUS=true -e LLM_ENABLED=false \
  ghcr.io/breakstring/echarts-agent:0.1.0
```

`latest` 指向最近一次发布的正式版；需要可复现部署时使用版本标签或 digest。首次发布的镜像可见性与代码仓库独立；若拉取提示需要认证，请维护者按[发布说明](docs/container-release.md)将 Package 设为 Public。

### 从源码构建

在项目根目录构建并启动：

```bash
docker build -t echarts-agent:local .
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  -e ALLOW_ANONYMOUS=true -e LLM_ENABLED=false \
  echarts-agent:local
```

启动后可以使用同一组 HTTP 请求。镜像内置中文字体，使用非 root 用户运行；无需安装浏览器。上面的端口只绑定本机。

供其他服务访问时，设置随机 `SERVICE_API_KEY` 并通过环境变量或 secret 注入，用 Bearer 请求头访问。客户端与服务端使用同一个值：

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/capabilities \
  -H "Authorization: Bearer $SERVICE_API_KEY"
```

模型配置也可通过环境变量注入。若使用 Node 格式的 `.env.local`，可只读挂载到容器并由 Node 解析：

```bash
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  --mount type=bind,src="$PWD/.env.local",dst=/run/provider.env,readonly \
  echarts-agent:local node --env-file=/run/provider.env dist/main.js
```

文件需允许容器用户读取，并配置 `SERVICE_API_KEY` 或显式本地匿名模式。不要把真实密钥写入镜像或提交到 Git。Docker `--env-file` 与 Node 的引号解析方式不同，上面的挂载方式使用 Node 解析。

## 支持哪些图表

| 类型 | 图表 | 主要字段映射 | 用途 |
| --- | --- | --- | --- |
| `bar` | 柱状图 | `x`、`y:[]` | 类别比较，可横向、堆叠 |
| `line` | 折线图 | `x`、`y:[]` | 趋势，可面积、堆叠 |
| `pie` | 饼图 / 环形图 | `name`、`value` | 部分占整体比例 |
| `scatter` | 散点图 | `x`、`y` | 两个数值字段之间的关系 |
| `radar` | 雷达图 | `name`、`metrics:[]` | 至少三个非负指标的比较 |
| `gauge` | 仪表盘 | `name`、`value` | 单个范围内数值 |
| `funnel` | 漏斗图 | `name`、`value` | 按输入顺序展示阶段数值 |
| `heatmap` | 热力图 | `x`、`y`、`value` | 两个分类维度的数值分布 |
| `tree` | 树图 | `id`、`parent`、`name` | 层级关系，`value` 可选 |
| `treemap` | 矩形树图 | `id`、`parent`、`name`、`value` | 层级面积分布 |
| `sunburst` | 旭日图 | `id`、`parent`、`name`、`value` | 层级环形占比 |
| `sankey` | 桑基图 | `source`、`target`、`value` | 无环的正数流量关系 |

映射中的值是你提供的数据列名，无需把原始列改名。完整请求见 [基础示例](examples/chart.json) 和 [新增七类示例](examples/extended/README.md)。

数据约定：

- `data` 是非空对象数组，单元格为字符串或有限数值；不接受 `null`，被引用字段不能缺失。
- 不隐式聚合、排序或补点。柱状图/折线图分类必须唯一，热力图每个坐标只能出现一次。
- 层级图传入节点表：唯一 `id`，根节点的 `parent` 为 `""`；其他父节点必须存在，只能有一个根且不能有环。矩形树图和旭日图必须提供非负 `value`，父值不能小于直接子节点之和。
- 桑基图传入边表，流量必须为正数，不接受重复边、自环或有向环。
- 仪表盘只接受一行，默认范围为 0–100；`unit` 只是显示后缀，不会把 `0.78` 自动换算成 `78%`。

## HTTP API

除健康检查外，配置了服务 key 时所有入口都需要 `Authorization: Bearer <SERVICE_API_KEY>`。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `POST /v1/charts` | `{spec, style?, output?}` | SVG / PNG 图片字节 |
| `POST /v1/render` | `{option, style?, output?}` | SVG / PNG 图片字节 |
| `POST /v1/generate` | `{data, intent, style?, output?}` | JSON：最终 `spec`、`option`、`warnings`、`artifact` 和 `requestId` |
| `GET /v1/capabilities` | 无 | 类型、主题、限额、模型配置状态 |
| `GET /openapi.json` | 无 | OpenAPI 3.1 接口定义 |
| `GET /health/live` | 无 | 进程存活状态 |
| `GET /health/ready` | 无 | 渲染进程就绪状态与 AI 配置状态 |

### 数据与字段映射

保存以下 JSON 为 `request.json`，提交到 `/v1/charts`：

```json
{
  "spec": {
    "type": "bar",
    "title": "月度数量",
    "data": [
      {"month": "一月", "count": 12},
      {"month": "二月", "count": 18}
    ],
    "encoding": {"x": "month", "y": ["count"]}
  },
  "style": {"theme": "report"},
  "output": {"format": "png", "width": 960, "height": 540, "pixelRatio": 2}
}
```

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/charts \
  -H 'Content-Type: application/json' \
  --data-binary @request.json --output chart.png
```

这会生成 1920 × 1080 的 PNG。示例使用本地匿名服务；开启认证后添加 Bearer 请求头。

### 已有 ECharts option

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/render \
  -H 'Content-Type: application/json' \
  --data-binary @examples/render.json --output chart.svg
```

`option` 只支持上表中的静态类型和受约束配置，**不是任意 ECharts 配置的执行环境**。函数、脚本、外部图片/URL、地图、GL、自定义绘图和浏览器交互不支持。

### 图片样式与大小

- 主题：`light`、`dark`、`report`；默认 `light`。
- `style.palette`：1–20 个十六进制颜色；`fontSize`：10–32，默认 14；`background`：十六进制颜色或 `transparent`。
- 默认输出：SVG，960 × 540。宽 240–2400，高 180–2400。
- PNG 的 `pixelRatio` 为 1–3，实际像素尺寸须为整数，总像素不超过 1600 万；SVG 的 `pixelRatio` 只能为 1。
- PNG 固定中文外观；SVG 保留文本，显示效果依赖接收方字体。密集图表或长标签可能截断，建议调整画布或减少数据。

## 启用自然语言生成

在本地 `.env.local` 中配置模型。例如百炼：

```dotenv
ALLOW_ANONYMOUS=true
LLM_ENABLED=true
LLM_PROVIDER=dashscope
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen3.8-flash
LLM_API_KEY=replace-with-your-provider-key
```

这里的匿名模式仅用于本机调试。已有服务 key 时保留认证配置。重启 `npm run dev`，然后：

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/generate \
  -H 'Content-Type: application/json' \
  --data-binary @examples/generate.json --output generated.json
node --input-type=module -e "import fs from 'node:fs'; const r=JSON.parse(fs.readFileSync('generated.json','utf8')); fs.writeFileSync('generated.png',Buffer.from(r.artifact.base64,'base64'));"
```

生成接口返回 JSON，不能直接保存为 PNG。`artifact` 含 `mimeType`、`width`、`height`、`bytes`，以及 PNG 的 `base64` 或 SVG 的 `svg` 文本。

模型会收到意图、字段类型、行数和前 5 行有界样例；**这些内容会发送到你配置的模型供应商**。完整原始数据由本地程序绑定，不由模型重写。每次生成最多调用模型两次，默认总时限 60 秒，并发上限 2。调用方仍应复核图表类型和字段选择。

已实测百炼 `qwen3.8-flash`。其他 OpenAI-compatible 服务需自行验证。未配置模型时仍可使用确定性渲染；`LLM_ENABLED=false` 强制禁用模型。

## 接入 MCP 客户端

连接地址：`http://127.0.0.1:3000/mcp`，传输方式为 **Streamable HTTP**。在支持远程 MCP 的客户端填写 URL；有认证时附加 Bearer 请求头。不提供 stdio 模式。

| 工具 | 功能 |
| --- | --- |
| `get_chart_capabilities` | 查询支持范围 |
| `render_chart` | 从 ChartSpec 生成图片 |
| `render_echarts` | 从 JSON option 生成图片 |
| `generate_chart` | 从数据与意图生成图片，仅模型配置完整时提供 |

工具参数与对应 HTTP 请求体相同。PNG 返回 MCP `image` 内容，SVG 返回 `text`；元数据在 `structuredContent` 中。生成工具还返回最终 spec/option/warnings。

运行仓库内的客户端示例：

```bash
CHART_URL=http://127.0.0.1:3000 node examples/mcp-client.mjs
```

开启认证时先在客户端环境中设置 `SERVICE_API_KEY`。输出文件为 `chart-mcp.png`。服务使用无状态请求；关闭执行请求的连接会取消下游工作，独立取消通知不保证跨请求关联。需要按任务 ID 查询或取消时使用 A2A。

## 接入 A2A Agent

A2A 默认关闭，需要服务 key。将以下配置加入服务环境后重启：

```dotenv
SERVICE_API_KEY=replace-with-a-random-service-key
A2A_ENABLED=true
A2A_PUBLIC_URL=http://127.0.0.1:3000
```

`A2A_PUBLIC_URL` 必须是调用方可访问的服务 origin，不带路径、查询参数或凭据。远程部署时替换本机地址。

- Agent Card：`/.well-known/agent-card.json`，也需要 Bearer 认证。
- JSON-RPC：`/a2a`；协议为 **A2A 0.3.0**。
- 支持 `message/send`、`tasks/get`、`tasks/cancel`。
- 输入为一个结构化 data part：`{operation:"render"|"chart"|"generate", request:对应HTTP请求体}`。
- 图片在 Task artifact 的 `file.bytes` 中，以 base64 返回，不提供下载 URL。

```bash
CHART_URL=http://127.0.0.1:3000 node examples/a2a-client.mjs
```

客户端环境需设置与服务端一致的 `SERVICE_API_KEY`，输出为 `chart-a2a.png`。设置 `configuration.blocking=false` 可先拿任务 ID 再查询。任务完成后最多保留 10 分钟，内存最多 100 条/64 MiB，容量压力时提前淘汰，重启后丢失。不支持流式、推送通知、续写或文件输入。同一个 key 的调用方共享任务访问权限。

## 配置参考

完整模板见 [.env.example](.env.example)。`npm run dev` 读取 `.env.local`；`npm start` 只使用进程环境，不自动加载文件。

| 变量 | 默认值 / 说明 |
| --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000`；本机运行建议显式 `HOST=127.0.0.1` |
| `SERVICE_API_KEY` | 无；服务与客户端共用的 Bearer key |
| `ALLOW_ANONYMOUS` | 默认关闭；仅值 `true` 开启，无 key 时启动所需 |
| `RENDER_WORKERS` | `2`，范围 1–4 |
| `RENDER_QUEUE_LIMIT` | `8`，范围 0–32 |
| `RENDER_TIMEOUT_MS` | `10000`，范围 100–30000，包含排队时间 |
| `LLM_ENABLED` | 无 key 时禁用；`false` 强制关闭 |
| `LLM_PROVIDER` | `openai-compatible`，供应商标识 |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | 启用模型时均需配置 |
| `LLM_TIMEOUT_MS` | `60000`，范围 100–60000 |
| `A2A_ENABLED` / `A2A_PUBLIC_URL` | 默认关闭；启用时必须配置服务 origin 和服务 key |

兼容小写 `llm_provider`、`llm_base_url`、`llm_default_model`、`llm_api_key`；对应大写变量优先。AI 状态 `ready` 只表示配置完整，不表示供应商已通过在线探测。

## 常见问题与限额

| 现象 | 检查方法 |
| --- | --- |
| 启动失败 | 配置服务 key 或本地匿名开关；检查端口、数值配置和 A2A 必填项 |
| `401 UNAUTHORIZED` | 在请求中携带正确 Bearer key；MCP 和 Agent Card 同样需要 |
| `422 INVALID_INPUT` | 检查字段名、数值类型和图表语义；查看错误中的 `details` |
| `503 AI_UNAVAILABLE` | 检查模型配置是否完整或被 `LLM_ENABLED=false` 关闭 |
| `502 AI_FAILED` / `AI_INVALID_PLAN` | 检查供应商配置，或用 ChartSpec 明确指定字段和类型 |
| `429 QUEUE_FULL` / `AI_BUSY` | 降低调用并发，稍后重试 |
| `504 RENDER_TIMEOUT` / `AI_TIMEOUT` | 减少数据/图表复杂度，检查模型服务耗时 |
| PNG 正常但 SVG 中文字体不同 | 接收方安装相应字体，或改用 PNG |

请求体最多 1 MiB，最多 20 个 series、10,000 个数据点，单图像最多 10 MiB。MCP/A2A 的封装响应也受大小限制，base64 会增加体积。层级图最多 1000 节点/8 层，桑基图最多 500 节点/2000 边。

不提供图片托管、数据库、CSV/Excel 上传解析、PDF、地图、GL、自定义脚本或交互 HTML。单个服务 key 适用于共同信任域，不提供多租户隔离。

## 开发与验证

```bash
npm run typecheck
npm test
```

当前已通过 29 组自动化测试，并验证了真实 MCP/A2A 客户端、百炼请求、Linux ARM64 与 AMD64 仿真容器。可选实测命令：

```bash
npm run smoke:live  # 会向 .env.local 配置的模型发送请求
npm run build && node --env-file-if-exists=.env.local scripts/smoke-extended.mjs
node scripts/smoke-docker.mjs echarts-agent:local --a2a
node scripts/smoke-docker.mjs echarts-agent:local --a2a --live
```

带 `--live` 的容器验证会访问模型；不带时使用断网容器。验收数据是样例结果，不代表所有输入下的性能保证。

更多资料：[接口与数据合同](docs/specs/2026-09-16-echarts-agent-design.md) · [首版验收](docs/verification/2026-09-16.md) · [新增类型验收](docs/verification/2026-09-16-extended.md) · [示例目录](examples)

## 许可证

项目采用 [MIT License](LICENSE)。随附 Noto Sans CJK SC 字体使用独立的 [SIL Open Font License](assets/fonts/LICENSE)，来源见 [字体说明](assets/fonts/README.md)。
