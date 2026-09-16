# 新增静态图表示例

每个 JSON 都是可直接提交到 `POST /v1/charts` 或 MCP `render_chart` 的完整请求。默认 PNG，可将 `output.format` 改为 `svg`。

| 文件 | 图表 | 输入 |
| --- | --- | --- |
| [gauge.json](gauge.json) | 仪表盘 | 单行名称/数值，显式 min/max 与可选 unit |
| [funnel.json](funnel.json) | 漏斗图 | 阶段名称/非负数值，按传入顺序 |
| [heatmap.json](heatmap.json) | 热力图 | x/y 分类/数值，每个坐标一行 |
| [tree.json](tree.json) | 树图 | id/parent/name 节点表 |
| [treemap.json](treemap.json) | 矩形树图 | 节点表加 value |
| [sunburst.json](sunburst.json) | 旭日图 | 节点表加 value |
| [sankey.json](sankey.json) | 桑基图 | source/target/value 边表 |

在项目根目录、本地匿名模式下运行：

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/charts \
  -H 'Content-Type: application/json' \
  --data-binary @examples/extended/sankey.json \
  --output sankey.png
```

有鉴权时增加 Bearer 请求头。A2A 的 data part 使用 `{operation:"chart",request:上述JSON}`。自然语言生成只取示例的 `spec.data` 作为 `data`，另提供 `intent`，不直接提交整份 ChartSpec。

层级图只能有一个根（parent 为 `""`），不能有环或断链。面积图的 value 必须提供，父值不能小于直接子节点之和。桑基图不能有环、自环、重复边或非正流量。服务不会自动求和、补点或修改原数值；完整限制见 [设计合同](../../docs/specs/2026-09-16-echarts-agent-design.md)。
