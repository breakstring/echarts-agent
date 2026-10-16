# 连接合同与样例

这里的路径均相对于用户确认的服务 origin。服务地址和认证信息由部署者提供，本技能不会部署、重启或更改服务。

## 健康、能力与认证

| 接口 | 用途 | 认证 |
| --- | --- | --- |
| `GET /health/live` | 进程存活，返回 `status: alive` | 无需认证 |
| `GET /health/ready` | 渲染池就绪，成功为 `status: ready`；不可用返回 503 | 无需认证 |
| `GET /v1/capabilities` | 类型、主题、格式、字体、限额、AI 状态 | 服务配置了 key 时需要 Bearer |
| `GET /openapi.json` | 当前部署的 HTTP 请求 schema | 同上 |
| `/mcp` | 无状态 Streamable HTTP MCP | 同上 |
| `GET /.well-known/agent-card.json`、`POST /a2a` | 可选 A2A 发现与任务 | 必须 Bearer；服务可能未启用 A2A |

认证头是 `Authorization: Bearer <安全配置中的值>`。不要把该占位符作为实际值发送。`SERVICE_API_KEY` 是 HTTP 辅助脚本读取的环境变量；MCP/A2A 宿主需要用自己的安全机制注入请求头，设置环境变量不一定会自动配置它们。

健康接口无需认证，所以健康成功不代表凭据有效。`ai.status` 为 `disabled` 或 `misconfigured` 时仍可尝试确定性渲染；`ready` 不等于模型供应商已经在线验证。检查脚本不调用模型。

## MCP

填写 `${CHART_URL}/mcp`，选择 Streamable HTTP；不要配置为 stdio、SSE 专用旧接口或猜测可执行命令。工具名称由宿主加前缀后可能变化，应以发现结果为准：

| 服务工具名 | 接入时的用途 |
| --- | --- |
| `get_chart_capabilities` | 以 `{}` 查询能力 |
| `render_chart` | 发送下面的 ChartSpec 样例 |
| `render_echarts` | 受约束的 ECharts JSON option；接入验证无需使用 |
| `generate_chart` | 服务模型就绪时才会发现；接入验证无需使用 |

参数就是 HTTP 请求体，不加额外的 `request` 包裹。PNG 在 MCP `content` 的 `image` 项中，`data` 为 base64；SVG 在 `text` 项中。`structuredContent` 只有请求标识、格式、尺寸等元数据；不能把它保存为图片。错误可能以 `isError: true` 返回，即使 HTTP 成功也要检查。宿主没有保存图片能力时，报告“返回已确认，文件保存未验证”，不要杜撰下载地址。

这是无状态 MCP；关闭执行请求的连接会取消下游工作，单独的取消通知不保证跨请求关联。需要保留任务 ID 并查询/取消时用 A2A。

## 合成数据渲染样例

将以下对象直接交给 MCP `render_chart`，或作为 JSON 请求体 POST 到 `/v1/charts`。HTTP 使用 `Content-Type: application/json`；成功响应是 PNG 二进制，可以保存为一个尚不存在的 `.png` 文件。

```json
{
  "spec": {
    "type": "bar",
    "title": "连接验证（合成数据）",
    "data": [{"category": "甲", "value": 12}, {"category": "乙", "value": 18}],
    "encoding": {"x": "category", "y": ["value"]},
    "labels": {"value": "样例数量"}
  },
  "style": {"theme": "report"},
  "output": {"format": "png", "width": 960, "height": 540, "pixelRatio": 1}
}
```

检查状态和 `image/png` 后再保存；HTTP 错误 JSON 不能改名当图片。能查看图片时确认中文标题与两根柱形可见。没有原生 HTTP 工具但有终端时，可用 Node.js 自带 `fetch` 读取既有环境变量发送上述对象，认证值只能在进程内使用；不要通过 shell 展开密钥构造命令。

## A2A

1. 获取 Agent Card 时携带 Bearer 和 `A2A-Version: 1.0`。读取 `supportedInterfaces`，确认 `JSONRPC`/`1.0` 接口及其 URL。应与用户确认的服务目标一致；不要把密钥自动发送到未经确认的其他 origin。
2. 对该 `/a2a` 接口 POST JSON-RPC 2.0，仍发送相同的认证与版本头。`method` 为 `SendMessage`，`params` 可使用下面的完整样例：

   ```json
   {
     "message": {
       "messageId": "connect-sample-unique-id",
       "role": "ROLE_USER",
       "parts": [{"data": {"operation": "chart", "request": {
         "spec": {
           "type": "bar",
           "data": [{"category":"甲","value":12},{"category":"乙","value":18}],
           "encoding": {"x":"category","y":["value"]}
         },
         "output": {"format":"png","width":960,"height":540}
       }}}]
     },
     "configuration": {"returnImmediately": false, "historyLength": 0}
   }
   ```

   每次新发送生成唯一 `messageId` 和 JSON-RPC `id`；这不保证重复提交幂等。
3. `SendMessage` 的 1.0 wire 响应位于 `result.task`。检查 `status.state`，完成是 `TASK_STATE_COMPLETED`。图片在 `artifacts[].parts[].raw`，为 base64，即使 SVG 也需解码；按 `mediaType` 与 `filename` 保存。
4. `returnImmediately: true` 可先获取 ID，再用 `GetTask`、`params: {"id":"任务UUID","historyLength":0}` 查询。`GetTask` 的 `result` 直接是 Task，不再套 `task`。只在任务未终结时有界轮询，例如最多等待 90 秒、每 2 秒查一次，到限后保留 ID 并报告未完成，不重新提交。用户要求停止时用 `CancelTask`、`params: {"id":"任务UUID"}`；确认取消状态，不能把关闭本地连接当作任务取消。失败、取消、拒绝均不算完成。

服务也兼容 0.3：省略版本头或用 `A2A-Version: 0.3`；Card 为旧结构，方法是 `message/send`、`tasks/get`、`tasks/cancel`。消息用 `kind: "message"`、`role: "user"`、`parts: [{"kind":"data","data":输入}]`；异步设置 `configuration.blocking: false`，默认等待结束；任务直接在 `result`，完成状态为 `completed`，图像是 `parts[].file.bytes` base64。不要混用两套方法、消息结构或版本头。

两版都只接受一个结构化 data part：`{operation:"chart"|"render"|"generate", request:对应HTTP请求体}`。不支持自然语言 text part、文件上传、续写旧任务、任务列表、流式、推送通知或图片托管。`historyLength` 只能省略或为 0。终态任务最多保留 10 分钟，容量压力可提前淘汰，重启丢失；拿到图片后立即保存。同一服务 key 的调用方共享任务访问权限，不是独立租户。

## 有边界地排查

| 现象 | 下一步 |
| --- | --- |
| 无法解析、连接被拒、TLS 失败 | 核对 origin、网络和证书；不要关闭证书校验或换到未知地址 |
| 健康成功，能力/MCP/Card 返回 401 | 核对宿主是否实际注入 Bearer；不打印密钥、不遍历候选密钥 |
| `/mcp` 失败，但 HTTP 能力成功 | 核对远程 Streamable HTTP 支持、URL 和代理路径；健康检查不等于 MCP 握手成功 |
| Card 返回 404 | A2A 可能未开启或代理未暴露；报告部署者需要检查的接口，不自行改服务 |
| 版本或参数错误 | 对照 1.0/0.3 结构修正一次可定位的问题；不反复盲试 |
| 422、`INVALID_INPUT` | 检查请求是否完整、数值是否 JSON number、字段映射是否存在 |
| 429、503、超时 | 报告服务状态并停止自动重试；A2A 已有 ID 时先查询其状态 |

交付时区分“健康可达”“认证和能力已确认”“协议已连通”“样例图片已保存”四项结果，只报告实际完成的项。
