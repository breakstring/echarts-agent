# JSON Object 修改推送与本机常驻服务验收

日期：2026-10-16。按用户追加授权提交、推送并更新本机常驻服务，保留既有配置，连接真实百炼验证 HTTP 自然语言生成和 A2A。

## 代码与镜像

- 业务提交：`3d15dc521f13b55beb5ccb5f41d848f6a3aeccb3`，`feat(llm): 启用 JSON Object 并补齐纠错和脱敏诊断`，已推送 GitHub `main`，fetch 读回同步。
- 沿用同轮 typecheck 和 67 项测试通过结果；源代码未再变化。[GitHub CI](https://github.com/breakstring/echarts-agent/actions/runs/38868961662) 的原生 ARM64、AMD64 验证均成功，包含类型检查、完整测试、镜像构建及断网 HTTP/MCP/A2A smoke。
- 本机从该提交构建 ARM64 镜像 `echarts-agent:json-object-3d15dc5`，镜像 ID：`sha256:7e8c7c2784c8894f74f5a032d6af46b2557f3fefc7b769bcbd865e047d87dbf1`；OCI revision 标签与提交一致。
- 切换前新镜像通过断网容器 smoke：HTTP/MCP/A2A 1.0、旧卡片、12 类图表、非 root、只读根和正常停止。未发布 GHCR 或新版本标签。

## 配置保留与切换

- 服务及 Compose 项目均为 `echarts-agent-local`，继续仅监听 `http://127.0.0.1:3300`。
- 在受权限保护、Git/Docker 均忽略的 `.deploy-backups/20261016-json-object/` 备份 `.env.local`、私有 Compose、`service.env` 和认证 helper。切换前后对比 4 份文件的 SHA-256 与文件权限，全部一致。
- 保留 Compose 中的原镜像引用 `echarts-agent:consumer-skills-local`，将该本地 tag 指向新镜像；配置文件无需修改。原镜像另保留为 `echarts-agent:before-json-object-20261016`。
- 环境变量、命令、入口点、用户、端口、挂载、重启策略、只读根、权限限制、资源上限和网络配置均通过指纹一致性校验；凭据未写入公开证据。
- 首次切换未显式指定 Compose 项目名，默认派生为 `local`，在容器名称冲突处停止，旧服务未中断。核对原容器标签后用 `-p echarts-agent-local` 成功更新；此次误建且无连接的网络已清理。
- 新容器 `4546bf09f070` 为 healthy，readiness 与 AI 均 ready。容器内 7 个业务模块的编译文件哈希与已验证源码构建结果一致。运行配置仍为百炼 `qwen3.8-flash`、INFO 诊断日志。

管理命令必须显式带原项目名：

```sh
docker compose -p echarts-agent-local -f ~/.config/echarts-agent/local/compose.yaml ps
docker compose -p echarts-agent-local -f ~/.config/echarts-agent/local/compose.yaml up -d --wait
```

## 常驻服务真实验证

仅使用合成数据，由官方 A2A SDK 及 HTTP 客户端访问已更新的常驻服务，未启动替代测试服务。认证在进程内读取既有私有配置，不写入命令参数或日志。

| 入口 | 检查结果 | 含验证耗时 |
| --- | --- | ---: |
| HTTP 自然语言折线图 | SVG，类型/encoding/中文标题/原始 data 一致 | 3072 ms |
| HTTP 自然语言环形图 | PNG，类型/encoding/中文标题/原始 data 一致，donut=true | 2063 ms |
| A2A 1.0 generate | PNG、任务完成、GetTask 图片逐字节一致 | 2084 ms |
| A2A 0.3 chart | 确定性 PNG、任务及图片读回一致，不调用模型 | 36 ms |

图片均为 960×640，完整解码、保存文件哈希读回通过。A2A 1.0 图片人工检查：中文标题及月份清晰，柱高与合成的 12/18/25 一致。A2A 不返回 ChartPlan，因此未声称该入口另行比较了 spec。

服务诊断记录 3 次模型调用，均 attempt=1、`responseFormat=json_object`、`thinking=false`、`finishReason=stop`；无纠错或失败事件。模型阶段耗时分别为 2950、1998、2025 ms；输入/输出 token 分别为 4647/108、4638/79、4648/110。容器日志对现有凭据值做精确检查，匹配数为 0。

本地完整证据位于 Git 忽略的 `artifacts/llm-json-object-local-release/`：`release.json`、`switch.json`、`runtime.json`、`evidence.json`、`diagnostics.json`、`log-verification.json` 及验证脚本和图片。

这些耗时是本轮单次观测，不是性能保证。原生 JSON Schema 未改动，常驻服务已保持运行；更新会清空原服务的短期内存 A2A 任务，没有持久业务数据卷需要迁移。
