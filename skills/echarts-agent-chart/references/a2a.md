# A2A 任务合同

仅在宿主具备 A2A 调用能力或用户明确选择此协议时使用。以 Agent Card 为发现入口，服务可能未启用 A2A。技能不替用户开启服务功能。

## 发现与发送（1.0）

对用户确认的服务 origin 请求 `GET /.well-known/agent-card.json`，携带安全配置提供的 Bearer 和 `A2A-Version: 1.0`。读取 `supportedInterfaces` 中 `protocolBinding: "JSONRPC"`、`protocolVersion: "1.0"` 的接口 URL；通常是该 origin 的 `/a2a`。接口若指向未经确认的其他 origin，先确认目标，不自动转发凭据。

POST 接口时使用 `Content-Type: application/json`、相同 Bearer 和 `A2A-Version: 1.0`。示例是可渲染的最小请求，数据仅用于示范；每次新任务替换唯一的 JSON-RPC `id` 和 `messageId`：

```json
{
  "jsonrpc": "2.0",
  "id": "chart-request-unique-id",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "chart-message-unique-id",
      "role": "ROLE_USER",
      "parts": [{
        "data": {
          "operation": "chart",
          "request": {
            "spec": {
              "type": "bar",
              "data": [{"category":"甲","value":12},{"category":"乙","value":18}],
              "encoding": {"x":"category","y":["value"]}
            },
            "output": {"format":"png","width":960,"height":540}
          }
        }
      }]
    },
    "configuration": {"returnImmediately": true, "historyLength": 0}
  }
}
```

每条消息恰好一个结构化 data part。`operation` 选择 `chart`、`render` 或 `generate`，`request` 分别等同于 HTTP `/v1/charts`、`/v1/render`、`/v1/generate` 的完整请求体。不接收自然语言 text part、文件或图片输入。选择 `generate` 前必须发现对应能力并确认 AI 就绪；仅 `render` 技能存在不说明 AI 可用。A2A 生成任务只返回图片 artifact，不返回规划的 `spec`、`option`、`warnings`；需要这些字段时使用 MCP/原生 HTTP，或由当前 Agent 明确生成 ChartSpec。

`returnImmediately: true` 先返回任务；省略或 false 则等待结束。不要依靠重复 `messageId` 实现幂等：遇到超时先找已返回的任务 ID，不重复发送。

## 查询、取消和完成

先检查 JSON-RPC `error`；HTTP 200 不代表业务成功。

- `SendMessage` 的 wire 响应是 `result.task`。保存 `task.id`（UUID）。
- `GetTask` 用 `params: {"id":"任务UUID","historyLength":0}`；其 `result` 直接是 Task，没有 `task` 包裹。只在任务未终结时有界轮询，例如每 2 秒查一次、最多等 90 秒。达到边界后保留 ID，报告未完成，不自动新建任务。
- `CancelTask` 用 `params: {"id":"任务UUID"}`；用于用户取消正在运行的任务。确认返回状态，不能把关闭本地连接当作 A2A 任务已取消。重复取消已取消的任务会返回取消状态，已完成/失败的任务不可取消。
- 1.0 完成状态为 `TASK_STATE_COMPLETED`；`TASK_STATE_FAILED`、`TASK_STATE_CANCELED`、`TASK_STATE_REJECTED` 都是非成功终态。失败的结构化错误位于 `status.message.parts[].data.error`，含代码与消息。
- 不发送旧的 `taskId`、`contextId`、引用任务或非空 tenant 进行修改/续写；每次改图是新的结构化请求。

完成后遍历 `artifacts[].parts[]`，使用 `mediaType` 为 `image/png` 或 `image/svg+xml` 的图片 part。1.0 JSON wire 的 `raw` 是 base64，PNG 与 SVG 都要先解码；`filename` 只作建议，实际保存在用户指定的新路径，不能直接信任其路径成分。没有下载 URL。

官方 JS SDK 的内部对象与 wire JSON 不同：1.0 SDK `sendMessage` 返回 Task 本身；图片内容为 `part.content.$case === "raw"` 时的 `part.content.value` 二进制。使用宿主 SDK 时先按其实际返回类型操作，不对二进制再次做 base64 解码。

## 0.3 兼容边界

只有宿主使用 0.3 时才选择这一路径；不要仅因版本错误静默换协议。

| 项目 | A2A 1.0 | A2A 0.3 |
| --- | --- | --- |
| 版本请求头 | `A2A-Version: 1.0` | `A2A-Version: 0.3`，或省略 |
| Card 接口字段 | `supportedInterfaces` | 旧 `url`、`protocolVersion: "0.3.0"` 等 |
| 方法 | `SendMessage` / `GetTask` / `CancelTask` | `message/send` / `tasks/get` / `tasks/cancel` |
| 消息 | `role: "ROLE_USER"`，无 `kind` | `kind: "message"`、`role: "user"` |
| 结构化 part | `{ "data": 输入 }` | `{ "kind": "data", "data": 输入 }` |
| 异步配置 | `configuration.returnImmediately: true` | `configuration.blocking: false` |
| 发送响应任务 | `result.task` | `result` |
| 成功状态 | `TASK_STATE_COMPLETED` | `completed` |
| 图像 wire part | `raw` base64、`mediaType`、`filename` | `file.bytes` base64、`file.mimeType`、`file.name` |

两版 `GetTask`/`tasks/get` 和取消方法的 `result` 都直接为 Task。0.3 任务失败为 `failed`、取消为 `canceled`；业务错误在 `status.message.parts[].data.error`。版本头、方法名和消息格式必须一致。1.0 用 `A2A-Version: 1.0`，不能写成 `1.0.1`；0.3 请求头用 `0.3`，不是 Card 展示的 `0.3.0`。

## 生命周期限制

不支持任务列表、流式、推送通知、续写、文件输入、图片托管或消息历史；`historyLength` 只能省略或为 0。任务保存在服务内存，终态最多保留 10 分钟，容量压力可能提前淘汰，重启丢失。立即保存产物，别把任务 ID 当长期下载凭据。

同一服务 key 的调用方共享任务访问权限，不支持通过非空 tenant 创建租户隔离。每次服务端生成最多会调用模型两次；A2A 只是任务传输，不改变数据外发与费用边界。
