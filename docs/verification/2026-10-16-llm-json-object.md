# JSON Object、有限纠错与诊断日志验收

日期：2026-10-16。环境：当前源码启动的本机临时服务，通过现有 `.env.local` 连接百炼 `qwen3.8-flash`；仅发送合成数据。未修改私有配置，未切换常驻服务、构建发布镜像或提交推送 Git。

## 实现范围

- 实际模型请求显式发送 `response_format: {"type":"json_object"}`，保留 `enable_thinking: false`、完整 Schema 提示与本地 Zod/图表语义校验。未启用原生 JSON Schema。
- Mastra 明确的结构化输出错误与输出截断可进入一次纠错；与字段映射纠错共享最多两次模型调用和默认 60 秒总时限。HTTP、认证、网络失败不重试，取消或超时后不启动下一次调用。
- 增加 `LLM_LOG_LEVEL=info`，支持 `debug/info/warn/error/off`。各次生成用 `generationId` 关联模型、校验、渲染和最终结果，记录尝试次数、耗时、可用 token 用量、结束原因及安全的上游 HTTP 状态。
- 日志采用允许字段投影；所有级别均不记录意图、样例数据、模型正文、异常原文或凭据。日志写入或自定义回调抛错不改变模型调用次数、业务结果或并发名额。

## 自动化验证

- `npm run typecheck` 通过。
- 最终 `npm test`：67 项通过，0 失败、0 跳过，含 17 项 LLM 回归。
- 真实 Mastra + localhost 假上游捕获了首次和纠错请求，均有 JSON Object、关闭思考和 Schema 提示。
- 覆盖非法 JSON、缺必填字段、额外 `data`、不存在字段、连续错误、格式与语义错误混合、输出截断、401/503、断连、取消、总时限和并发限制。
- 敏感标记同时放入意图、数据、模型结果、上游报文和假密钥，验证诊断、console、stderr 及对外错误均不泄露；验证日志级别与回调抛错隔离。
- 首轮集成测试命中了尚未同步到新日志包装接口的函数引用相等断言；修正该测试并增加直接抛错回调回归后，最终全量通过。

## 真实百炼与协议验证

运行扩展后的 `scripts/smoke-live.mjs`，通过临时 fetch 观察器仅提取允许的请求参数及响应元数据，不保存认证头、提示词或模型正文。观察器设置 `LLM_LOG_LEVEL=debug`，共 4 次生成、4 次模型调用，无纠错。

| 入口 | 结果 | 模型阶段 ms | 含交付验证 ms | 输入 / 输出 token |
| --- | --- | ---: | ---: | ---: |
| HTTP | 折线图 SVG | 3721 | 3764 | 4647 / 108 |
| HTTP | 环形图 PNG | 2323 | 2385 | 4638 / 79 |
| MCP | 柱状图 PNG | 1915 | 1981 | 4646 / 107 |
| A2A 1.0 | 柱状图 PNG、GetTask 读回 | 2705 | 2773 | 4648 / 110 |

4 次请求均实际使用 `qwen3.8-flash`、`json_object`、`enable_thinking:false`、`max_tokens:1500`，Schema 提示存在；响应模型名匹配，HTTP 200，`finish_reason=stop`，无 `reasoning_content` 正文。SDK 归一化的 reasoning token 为 0；原始响应未提供该细分计数，不能将其表述为供应商显式返回 0。

HTTP/MCP 验证图表类型、字段映射、指定中文标题和原始数据相等，环形图确认 `donut=true`。所有图片校验为 960×640，PNG 完整解码成功。A2A 官方 SDK 协商 1.0，任务完成，GetTask 的图片与首次交付逐字节相同。人工查看环形图与 A2A 柱状图：中文可读，40/60 标签、月份顺序和 12/18/25 柱高与合成数据一致。A2A 不返回 ChartPlan，因此该入口未另行比较 spec。

本地忽略产物：

- `artifacts/live/evidence.json`：图像尺寸、SHA-256、协议结果和耗时。
- `artifacts/live/wire-evidence.json`：4 次实际请求与响应的允许元数据。
- `artifacts/live/diagnostics.json`：本轮 debug 诊断。
- `artifacts/live/trend.svg`、`share.png`、`mcp.png`、`a2a.png`。

## 验证边界

这是一轮真实联通性和行为验收，不是延迟基准或稳定性保证。格式错误与纠错边界由本地假上游验证；真实模型本轮均首次成功。未运行新镜像或变更现有部署；原生 JSON Schema 适配不在本轮范围。

可重复运行 `npm run smoke:live` 验证 HTTP/MCP/A2A；它会向当前配置的供应商发送 4 次生成请求，每次最多调用模型两次，产物写入 `artifacts/live`。
