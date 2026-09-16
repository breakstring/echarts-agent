# GitHub Actions 与 GHCR 发布

工作流：[ci.yml](../.github/workflows/ci.yml)。目标镜像为 `ghcr.io/breakstring/echarts-agent`。

## 验证与发布边界

- PR、main 推送、`v*` 标签以及手动触发均在原生 Linux AMD64/ARM64 runner 上运行 typecheck、完整测试、镜像构建和断网 HTTP/MCP/A2A smoke。
- 验证任务仅有 `contents: read`，不读取生产环境或模型密钥，不调用真实供应商。
- 两种架构都成功后，`vX.Y.Z` 标签发布 `X.Y.Z`、`latest` 和 `sha-<完整提交SHA>`。标签必须是稳定版，且与 package.json 的 version 一致。
- 手动 Run workflow 选择 main，会发布 `main` 和 `sha-<完整提交SHA>`，不更新 latest。其他分支只验证。
- 只有发布 job 获取 `packages: write`，使用 GitHub 自动生成的 GITHUB_TOKEN，无需新增 PAT。发布仅允许本仓库，不在 fork 上发布。
- 发布 job 复用验证阶段的构建缓存，生成含两种架构的镜像索引，记录并校验 digest。镜像包含 MIT 与字体 OFL 许可证。
- 工作流不部署任何生产服务器，也不运行 `.env.local` 真实模型验证。

## 发布一个新版本

1. 在 main 上更新 package.json 与 package-lock.json 中的项目版本，提交并推送。
2. 确认该提交应成为正式版，然后打匹配标签并推送，例如：

```bash
git tag -a v0.1.0 -m '发布 0.1.0'
git push origin v0.1.0
```

3. 在仓库 Actions 页面查看 `CI and container release` 的标签运行，确认两个 Validate job 和 Publish job 都成功。
4. 使用 Package 页面或任务摘要中的 digest 部署；不要重新移动已发布的版本标签。再次推送新版本标签会更新 latest。

## 首次发布后将镜像设为 Public

GitHub 源码仓库公开不代表 Package 自动公开。首次镜像推送成功后：

1. 打开仓库右侧 **Packages → echarts-agent**，或个人主页的 Packages 列表。
2. 进入 **Package settings**。
3. 在 **Danger Zone → Change package visibility** 中选择 **Public**。
4. 按页面要求输入名称并确认。请确认该镜像允许任何人下载。
5. 用无登录的 Docker 配置验证，避免本机已有凭据掩盖权限问题：

```bash
auth_dir=$(mktemp -d)
DOCKER_CONFIG="$auth_dir" docker pull ghcr.io/breakstring/echarts-agent:0.1.0
rmdir "$auth_dir"
```

如果不允许改变可见性，请检查账号权限或组织策略。GHCR 镜像无需在 Docker Hub 再创建仓库。

## 维护

Actions 固定到官方发布提交SHA，Node与Docker基础镜像版本沿用项目锁定版本。版本更新时核对官方来源并重新验证，不把密钥放入构建参数、镜像标签或构建上下文。PR 使用普通 pull_request，不使用 pull_request_target 执行外部代码。

官方参考：[发布镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) · [GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) · [多架构构建](https://docs.docker.com/build/ci/github-actions/multi-platform/)
