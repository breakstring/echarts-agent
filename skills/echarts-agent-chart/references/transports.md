# 传输与保存

使用已确认的服务目标和宿主连接。认证值由宿主密钥配置或本地进程环境提供，不能进入请求 JSON、对话、日志或命令参数。HTTP 辅助脚本要求 Node.js 22+，只依赖 Node.js 内置模块。

## MCP

使用宿主实际发现的工具；服务端名称及参数对应关系：

| 工具 | 输入 |
| --- | --- |
| `get_chart_capabilities` | `{}` |
| `render_chart` | `{spec, style?, output?}` |
| `render_echarts` | `{option, style?, output?}` |
| `generate_chart` | `{data, intent, style?, output?}`；仅 AI 就绪时提供 |

不要增加 HTTP 路径、`operation` 或 `request` 包装；它们不是 MCP 工具参数。可选对象内的未填字段由服务应用默认值。检查结果的 `isError`；出错内容是 JSON 文本，不是 SVG。

- PNG：寻找 `content` 的 `type: "image"` 项，确认 `mimeType: "image/png"`，将 `data` 的 base64 解码后保存。
- SVG：`content` 的 `type: "text"` 项包含 SVG 文本，确认实际是 SVG 后以 UTF-8 保存。不要把错误文本当 SVG。
- `structuredContent` 包含 `requestId`、`mimeType`、尺寸与字节数；生成工具还包含 `spec`、`option`、`warnings`。这些内容用于记录与复核，不是下载 URL。

优先用宿主原生图片展示/保存能力。若宿主只显示图片、无法导出，可如实交付当前可见图片并说明文件未保存；需要落盘时在同一已授权目标上使用 HTTP 重新渲染，并说明这是一次新调用。不要为了保存失败自动重复调用会产生模型费用的生成接口。

## HTTP 辅助脚本

在宿主环境中配置 `CHART_URL`（必填，服务 origin，例如 `https://charts.example.com`）和需要时的 `SERVICE_API_KEY`。URL 不含路径、查询参数、片段或凭据；没有默认 localhost。不要把示例域名原样用于请求，也不要将密钥写进示例命令。

以下路径需换成技能实际安装位置与用户选择的文件路径：

```bash
node /已安装技能目录/echarts-agent-chart/scripts/chart-client.mjs capabilities
node /已安装技能目录/echarts-agent-chart/scripts/chart-client.mjs chart /工作目录/request.json /工作目录/chart.png
node /已安装技能目录/echarts-agent-chart/scripts/chart-client.mjs render /工作目录/option-request.json /工作目录/chart.svg
node /已安装技能目录/echarts-agent-chart/scripts/chart-client.mjs generate /工作目录/generate-request.json /工作目录/generated.png
```

先从 [报告样例](../assets/report-bar.json) 复制并修改请求，再运行 `chart`。输出扩展名须匹配请求的 `output.format`，不填格式则默认 SVG。脚本不覆盖已有输出、不隐式重试；选择新的文件名后再提交。整次调用默认限时 90 秒，可用环境变量 `CHART_TIMEOUT_MS` 设置 100–120000 的整数毫秒数。`generate` 只有满足主技能的 AI 就绪与数据使用要求时使用。

| 命令 / HTTP 接口 | 成功响应与保存 |
| --- | --- |
| `capabilities` → `GET /v1/capabilities` | JSON 能力信息 |
| `chart` → `POST /v1/charts` | PNG 二进制或 SVG 文本，直接保存对应图片 |
| `render` → `POST /v1/render` | 同上 |
| `generate` → `POST /v1/generate` | JSON，图片在 `artifact`；PNG 解码 `artifact.base64`，SVG 保存 `artifact.svg` |

原生 HTTP 调用应检查状态与 `Content-Type`，发送 JSON 时用 `Content-Type: application/json`。生成接口的完整 JSON 不能直接写成 `.png`。模型生成接口还返回最终 `spec`、`option`、`warnings`；通过原生 HTTP/MCP 调用时应保存或记录以便复核。脚本的 `generate` 只保存图片并输出安全元数据，不导出这些规划字段；如果需要精确检查映射或继续修改同一计划，优先原生 HTTP/MCP，或由当前 Agent 编写 ChartSpec 后使用 `chart`。HTTP/MCP/A2A 均不托管图片。

## 失败处理

- `401 UNAUTHORIZED`：检查认证注入，停止尝试；不要向新 origin 转发密钥。
- `422 INVALID_INPUT`：查看字段路径/语义，修正已确定的格式或映射；口径不明则先确认，不猜测聚合。
- `413 REQUEST_TOO_LARGE` / `OUTPUT_TOO_LARGE`：保留数据口径，按需求减小尺寸、改格式或拆图；不能静默截断数据。
- `429 QUEUE_FULL` / `AI_BUSY`：停止自动重试，报告服务繁忙。
- `503 AI_UNAVAILABLE`、`502 AI_FAILED` / `AI_INVALID_PLAN`：报告生成不可用；在原任务允许的范围内可由当前 Agent 设计 ChartSpec 并使用确定性渲染，不重复调用模型碰运气。
- 超时或取消：保存已知请求标识；A2A 有 ID 时先查任务。不要把客户端未收到结果等同于服务完全未执行，也不要自动重提。

修正必须针对已经定位的原因；一次修正仍出现同类错误时，先复核能力与请求合同，再决定下一步，不进行无界试错。
