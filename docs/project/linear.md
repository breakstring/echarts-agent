# Linear 项目与执行约定

## 在线核验的绑定

- Workspace：[KennZhang](https://linear.app/kennzhang)
- Team：KennZhang（KENN），ID `e0caa5d5-8cba-4fe1-b97b-dc0247e3312f`
- Project：[ECharts Agent](https://linear.app/kennzhang/project/echarts-agent-cab33af29f59)
- Project ID：`3e2a6040-49b4-4901-8997-fc70dd5dc663`
- 核验日期：2026-09-16。创建前查重，创建后按 ID 读回项目、全部 Issue 及依赖。

## 文档职责

- [Roadmap](roadmap.md)：方向、推荐顺序与暂缓项。
- [设计方案](../specs/2026-09-16-echarts-agent-design.md)：冻结合同、取舍与验收边界；当前已实现。
- Linear：动态任务、依赖、状态、负责人和排期。
- [Progress log](progress-log.md)：已完成工作和实际验证证据。

用户于同日追加授权按顺序实现任务，并允许使用根目录 .env.local 发送实际百炼请求。任务状态按实现和验收证据更新；镜像发布、生产部署与 Git push 不在本轮授权范围。

## 任务入口

下表仅作静态导航；状态和依赖以 Linear 在线数据为准，不在文档维护第二份 backlog。

| Issue | 范围 |
| --- | --- |
| [KENN-419](https://linear.app/kennzhang/issue/KENN-419/r0-验证技术组合并冻结首版接口合同) | [R0] 验证技术组合并冻结首版接口合同 |
| [KENN-420](https://linear.app/kennzhang/issue/KENN-420/r1-实现共享合同与-echarts-option-svg-渲染-http-接口) | [R1] 实现共享合同与 ECharts option SVG 渲染 HTTP 接口 |
| [KENN-421](https://linear.app/kennzhang/issue/KENN-421/r1-实现-chartspec-模板与主题风格编译) | [R1] 实现 ChartSpec 模板与主题风格编译 |
| [KENN-422](https://linear.app/kennzhang/issue/KENN-422/r1-实现-png-转换并验证中文字体与排版) | [R1] 实现 PNG 转换并验证中文字体与排版 |
| [KENN-423](https://linear.app/kennzhang/issue/KENN-423/r1-实现渲染进程池资源边界和统一鉴权) | [R1] 实现渲染进程池、资源边界和统一鉴权 |
| [KENN-424](https://linear.app/kennzhang/issue/KENN-424/r1-通过-mastra-暴露无需-llm-的-mcp-图表工具) | [R1] 通过官方 MCP SDK 暴露无需 LLM 的 MCP 图表工具 |
| [KENN-425](https://linear.app/kennzhang/issue/KENN-425/r2-实现可选-provider-与自然语言图表设计) | [R2] 实现可选 Provider 与自然语言图表设计 |
| [KENN-426](https://linear.app/kennzhang/issue/KENN-426/r1r2-交付单容器-docker-与首版端到端验收) | [R1/R2] 交付单容器 Docker 与首版端到端验收 |
| [KENN-427](https://linear.app/kennzhang/issue/KENN-427/r3-设计并接入-a2a-图表-agent) | [R3] 设计并接入 A2A 图表 Agent |
| [KENN-428](https://linear.app/kennzhang/issue/KENN-428) | 扩展七类静态图表及共享输入合同 |

## 后续同步

修改产品范围或公共合同先更新设计与对应 Issue；完成实施后在 Issue 留下具体验证结果，再记录本地完成证据。没有新方向不改 Roadmap。工具暂时不可用时仅在这里记录短期待同步动作，恢复后回放并读回，不另外建立长期任务列表。

KENN-419～KENN-427 的完成状态已在线读回。镜像标识与详细验收数据最初被自动审批拦截，用户随后明确授权，已补充至 KENN-426/427 并逐项读回确认；本地完整证据见 docs/verification/2026-09-16.md。没有待同步动作。用户追加授权创建公开 GitHub 仓库并推送；本地 Git 已初始化；用户已创建公开仓库 [breakstring/echarts-agent](https://github.com/breakstring/echarts-agent)，origin 使用 SSH，默认分支 main。远端初始化提交含 MIT 许可证，首次推送保留该历史。


KENN-428 新增七类图表已完成并在线读回 Done；验收见 docs/verification/2026-09-16-extended.md，无待同步动作。
