# ChartSpec 字段映射与语义

先查服务能力；以下是当前合同，当前部署返回的类型、限额和 `/openapi.json` 优先。顶层请求为 `{ "spec": {...}, "style": {...}, "output": {...} }`。ChartSpec 是严格对象，不添加表中未声明的字段。

## 数据与共同字段

- `spec.data` 是 1–10,000 个行对象的数组，最多 64 个不同字段。单元格只能是字符串（最多 512 字符）或有限 JSON number；不接受 `null`、布尔、日期对象或嵌套对象。数值字段不能用 `"12"` 代替 `12`。
- 字段名长 1–64 字符，以字母（含中文）或下划线开头，其后可含字母、数字、下划线、空格和连字符；不使用 `__proto__`、`prototype`、`constructor`。源列名不符合时在本地建立明确映射，保留原列名用于说明。
- `type` 与 `encoding` 必填；`title` 可选，最多 180 字符；`labels` 可选，是“字段名 → 显示名称”的对象，每个显示名最多 80 字符。`labels` 不改变数据单位：bar/line 用于系列名，scatter 用于轴名，radar 用于指标名。其他类型不要依赖 `labels` 改变节点名，使用映射的名称字段。
- 服务不聚合、填缺失值或替用户做单位换算；数据中含脚本/资源引用等主动内容会被拒绝。需要展示 URL 等被限制文本时，使用合适的普通显示标签并保留映射，不删除业务含义。

## 十二种图表

下表中的值表示字段名，如 `"encoding":{"x":"month","y":["revenue"]}`；每个引用字段必须出现在相关数据行中。

| `type` | `encoding` | 额外字段与关键语义 |
| --- | --- | --- |
| `bar` | `x: 分类或日期字段`, `y: [数值字段...]` | 比较；`y` 为 1–20 个不同字段，行数 × 指标数 ≤10,000。`x` 不为空且转为字符串后唯一。`horizontal`、`stacked` 默认 false；`xType` 默认 `category`，可为 `time`。时间轴须 ISO 日期，不支持横向。`area` 对 bar 无效果。 |
| `line` | `x: 分类或日期字段`, `y: [数值字段...]` | 趋势；与 bar 相同的指标、唯一性和时间约束，`area: true` 可启用面积。按意图在本地排序；服务保留输入顺序。`horizontal`、`stacked` 默认 false。 |
| `pie` | `name: 分类字段`, `value: 数值字段` | 占比；分类唯一且不为空，数值非负，至少一个正值。`donut: true` 为环形，默认 false。不要用负值或非组成关系数据硬画占比。 |
| `scatter` | `x: 数值字段`, `y: 数值字段` | 两个连续数值的关系；两者均须有限数值，不要求坐标唯一。 |
| `radar` | `name: 对象名称字段`, `metrics: [数值字段...]` | 3–20 个不同指标，最多 20 行，名称唯一且不为空，数值非负。可设统一 `max > 0`，不得小于任何数据值；不同量纲若需标准化，须显式说明转换。 |
| `gauge` | `name: 名称字段`, `value: 数值字段` | 只接受一行。`min` 默认 0，`max` 默认 100，须有限递增且覆盖数值。`unit` 是显示后缀，不换算数值：0.42 加 `%` 会显示 0.42%，不是 42%。单位最多 16 字符，仅字母、数字、`%‰°℃ /._-`。 |
| `funnel` | `name: 阶段字段`, `value: 数值字段` | 名称唯一且不为空，数值非负且至少一个正值。保留输入顺序，不自动按值降序；阶段顺序由调用方确定。 |
| `heatmap` | `x: 分类字段`, `y: 分类字段`, `value: 数值字段` | 二维分类网格；x、y 不为空，每个 `(x,y)` 对唯一。数值可为负。重复坐标需按已确认口径预聚合；缺失组合不会自动补零。分类顺序按首次出现。 |
| `tree` | `id: 节点ID字段`, `parent: 父ID字段`, `name: 节点名称字段`, `value?: 数值字段` | 平铺层级表；层级规则见下。`layout` 为 `orthogonal`（默认）或 `radial`。未提供 `value` 映射时不需要数值列。 |
| `treemap` | `id`, `parent`, `name`, `value` 均为字段名 | 平铺层级表，`value` 必填且非负；父值不能小于直接子值之和，根值必须为正。面积按值表达；父值是该节点的总量，不只填自身剩余量。 |
| `sunburst` | `id`, `parent`, `name`, `value` 均为字段名 | 与 treemap 相同的层级和值语义，以环形显示层级。 |
| `sankey` | `source: 起点字段`, `target: 终点字段`, `value: 流量字段` | 每行一条边，端点为非空字符串；流量严格为正有限数。不得重复边、自环或有向环。最多 500 节点、2000 边；节点由边推导。`orient` 为 `horizontal`（默认）或 `vertical`。不强制流入等于流出，不能擅自补平。 |

层级图共同规则：最多 1000 节点、8 层（根算第 1 层），ID 为唯一非空字符串，名称为非空字符串，`parent` 必须是字符串。恰好一个根的 `parent` 为 `""`，其余父 ID 必须存在，不能引用自身、形成环或不可达节点。tree 如指定 `value`，所有行均需非负有限数值，也要满足父值不小于直接子值之和。一个有效平铺片段如下：

```json
[
  {"id":"root","parent":"","name":"总量","value":30},
  {"id":"a","parent":"root","name":"甲","value":12},
  {"id":"b","parent":"root","name":"乙","value":18}
]
```

## 风格与输出

```json
{
  "style": {"theme":"report","fontSize":14,"palette":["#315b77","#a1633d"]},
  "output": {"format":"png","width":1200,"height":720,"pixelRatio":2}
}
```

`style.theme` 为 `light`（默认）、`dark`、`report`；`fontSize` 为 10–32 的整数；`palette` 为 1–20 个 `#RRGGBB`/`#RRGGBBAA` 颜色；`background` 为相同颜色格式或 `transparent`。只有需覆盖默认值时提供对应字段。

`output.format` 为 `svg`（默认）或 `png`；宽 240–2400、高 180–2400 的整数，默认 960×540。`pixelRatio` 为 1–3，默认 1；SVG 必须为 1。PNG 的实际像素宽高为请求宽高 × pixelRatio，须为整数且乘积不超过 16,000,000。如需报告用清晰位图，可用 PNG、1200×720、pixelRatio 2；SVG 适合矢量插图，但接收方字体会影响中文显示。

请求体最多 1 MiB，单图最多 10 MiB。MCP/A2A 封装也有限额，base64 会增加体积；尺寸增加不保证消除所有截断。先检查实际图像再按需要调尺寸、字号或转为横向。

## 何时使用原始 option

现成 ECharts JSON option，或需要 ChartSpec 没有暴露的明确标签、轴名等静态样式时，改用 `render_echarts` / `/v1/render`，请求形状为 `{option, style, output}`。不要把 option 塞进 ChartSpec。

仍限上述 12 类型、1–20 个 series、10,000 点及对应层级/流向约束。只接受 JSON，不接受函数、脚本、外部资源、`dataset`、`graphic`、`dataZoom`、`toolbox`、`timeline`、`renderItem` 等；服务关闭动画、交互 tooltip。`visualMap` 仅支持受约束的 continuous 配置。复杂 raw option 先查看当前部署的合同，不把常规 ECharts 的所有能力当作可用。服务不提供地图、GL、交互 HTML 或 PDF。
