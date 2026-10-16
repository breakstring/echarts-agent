# 统一鉴权与远端内网部署验收

日期：2026-10-16。按用户授权统一 HTTP、MCP、A2A 鉴权，补齐测试与文档，提交推送并部署远端常驻实例；保留既有匿名访问和模型配置，开启 A2A。

## 实现与验证

- 业务提交：`b5437223e6ee88da81a30af8aadc3d397d686978`，`feat(auth): 统一 HTTP MCP 和 A2A 鉴权模式`。
- 有服务 key 时三种入口都要求 Bearer，即使允许匿名；无 key 且显式允许匿名时都可匿名；两者都未配置则拒绝启动。健康检查免认证，A2A 开关与 origin 要求独立保留。
- 两版 Agent Card、OpenAPI 和 A2A 客户端示例按实际模式工作；中英接入文档、配置示例与消费者技能同步更新。
- typecheck、79 项测试通过。回归覆盖缺失或错误凭据、key 优先级、启动边界、关闭 A2A，以及匿名 HTTP/MCP 与两版官方 A2A SDK 的制图、完整 PNG 解码、任务读回和跨版本取消。测试使用本地假模型。
- [GitHub 发布流程](https://github.com/breakstring/echarts-agent/actions/runs/38871887290) 成功：原生 AMD64/ARM64 均通过类型检查、完整测试、镜像构建及断网 HTTP/MCP/A2A smoke，随后发布双架构镜像。未变更版本号或移动正式版本标签。

## 部署与配置保留

- 使用 GHCR 固定 AMD64 镜像：`ghcr.io/breakstring/echarts-agent@sha256:b053f8ee8fec66e85279c17a5c44239518449dc8e1cccb632ba27c1e66e1dd52`。运行镜像的 OCI revision 与业务提交一致。
- 服务端旧配置已备份，备份目录权限 0700、文件 0600。新旧解析后的 Compose 配置精确比较，仅允许镜像、`A2A_ENABLED`、`A2A_PUBLIC_URL` 三项变化；基础 Compose 字节未变，运行环境与活动配置一致。
- 既有匿名策略、模型配置及凭据全部保留。三种入口继续仅由既有内网网络访问，无宿主端口映射或公网路由新增。模型仍为百炼 `qwen3.8-flash`。
- 新常驻实例 healthy，readiness 与 AI 均 ready；两版 A2A Card 和 OpenAPI 均不声明 Bearer 要求。
- 原部署 SSH 输出连接未正常结束，未取得完整命令退出记录；另用新连接独立核对镜像、唯一对应配置备份、当前配置及真实调用结果。确认远端已无部署进程后，仅结束本地残留 SSH 等待链。

服务器地址、网络名、私有备份路径和配置内容不写入公开记录。本地完整证据保存在 Git 忽略的 `artifacts/anonymous-a2a-release/`。

## 常驻实例真实调用

从同一内网的临时客户端容器访问已更新的常驻服务，所有请求不携带认证；客户端未注入模型凭据。仅提交合成数据，完成后临时容器已移除。

| 入口 | 结果 | 含验证耗时 |
| --- | --- | ---: |
| HTTP 自然语言折线图 | SVG；类型、字段映射、中文标题和原始数据一致 | 2928 ms |
| HTTP 自然语言环形图 | PNG；类型、字段映射、标题和原始数据一致，donut=true | 1644 ms |
| MCP 匿名 render_chart | PNG；真实握手、工具发现与渲染，不调用模型 | 41 ms |
| A2A 1.0 匿名 generate | 官方 SDK 发现、任务完成、GetTask 图片逐字节一致 | 2402 ms |
| A2A 0.3 匿名 chart | JSON-RPC 兼容渲染、任务与图片读回，不调用模型 | 39 ms |

全部图片为 960×640，完整解码及保存文件哈希读回通过。人工检查 A2A 柱状图的中文标题、月份和 12/18/25 柱高，以及环形图的 40/60 数量标签。A2A 不返回 ChartPlan，因此该入口不声称完成了 spec 原始数据的结构比较。

模型诊断共 3 次调用，均 attempt=1、`responseFormat=json_object`、`thinking=false`、`finishReason=stop`；模型阶段耗时分别为 2826、1599、2353 ms，无警告或失败事件。日志对现有凭据值做精确检查，匹配数为 0。上述耗时是单次观测，不是性能保证。

关键本地证据：`release.json`、`configuration-readback.json`、`runtime.json`、`evidence.json`、`diagnostics.json`、`logVerification.json` 及验证脚本和图片。正式验证脚本事先在本地隔离服务上用假模型完整执行成功，远端真实验证没有客户端重试。
