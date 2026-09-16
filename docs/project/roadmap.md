# Roadmap

## 当前基线

截至 2026-09-16，已实现双结构化输入、12类静态图表、SVG/PNG、HTTP/MCP、可选百炼生成、单 Docker 容器及默认关闭的 A2A。实际验收证据见 progress log；动态状态以 Linear 为准。

采用 TypeScript/Node、Mastra Agent、官方 MCP/A2A SDK、ECharts＋Sharp。已完成 R0 技术验证，合同以 [设计方案](../specs/2026-09-16-echarts-agent-design.md) 为准。

## 方向与顺序

1. **R0 技术与合同验证**：确认依赖版本、中文 SSR/PNG、MCP 图片传递和进程终止，冻结首版接口与限额。
2. **R1 确定性渲染**：option 直传、ChartSpec 模板和风格、SVG/PNG、资源边界；交付可独立使用的单容器 HTTP/MCP 服务。
3. **R2 可选智能生成**：数据＋自然语言→ChartPlan→受控渲染，Provider 关闭和异常不影响 R1；作为首版可选配置能力交付。
4. **R3 A2A 接入**：复用应用服务，验证 Agent Card、协议版本、任务及 artifact 合同；作为默认关闭的可选能力交付。

首版可以分阶段验收 R1 与 R2，但完整首版范围包含 R2 的可选能力。

## 暂缓

长期文件存储、可视化编辑器、PDF/交互 HTML、地图与 GL、批量异步队列、数据源连接器和多 Agent 视觉评审。仅在明确需求出现后扩展。

Roadmap 记录方向，不在这里维护任务状态、负责人或排期。
