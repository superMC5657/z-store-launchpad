# z-store-launchpad

ZStore「开源广场（Launchpad）」的数据仓：采用与 `z-store-catalog` 一致的**「单应用真源拆分 + Issue 自动建 PR + 合入后自动编译汇总」**架构。客户端从 `raw.githubusercontent.com` 拉取编译后的 `launchpad.json`（失败时可经加速镜像重试一次），不依赖任何自建服务，也不做任何行为埋点。

清单与 `z-store-catalog` 的 `catalog.json` 相互独立：广场里的作品不会自动进入精选目录，客户端也不会把它们写进目录表。

## 准入门槛

社区自助投稿（免费上架与开源置顶）需满足以下条件：

- 公开仓库，托管在 GitHub、Codeberg、Gitea 或 GitLab，非归档、非 Fork；
- 协议在 ZStore 37 项 OSI 白名单内（与客户端 `[license_gate]` 同源）；
- 最新 Release 至少带一个可安装的构建资产。

顶部置顶推荐（Spotlight）最多 4 个坑位，支持开源新品赞助，也接受经维护者人工审核的开发者向商业赞助与广告（由维护者单独对接，明确标注状态标签，不写入精选目录、不参与推荐权重，客户端零埋点）。开源项目置顶到期后自动撤回「最新上架」流。

## 目录

| 路径 | 作用 |
| --- | --- |
| `launches/<...>.json` | 单应用真源（GitHub 为 `launches/<owner>/<repo>.json`，多条 PR 互不冲突） |
| `launchpad.json` | 编译后的客户端消费清单（由 `scripts/build-launchpad.mjs` 从 `launches/` 生成） |
| `state/stars-history.json` | 星数快照，只在星数变化时写入，用于计算 `stars_7d_delta` |
| `schema/launchpad.schema.json` | JSON Schema（Draft 2020-12） |
| `scripts/build-launchpad.mjs` | 校验 `launches/`、创建 Discussion、编译 `launchpad.json` 并回复源 Issue |
| `scripts/ingest-issue.mjs` | 解析投稿 Issue、体检仓库、写入 `launches/` 供自动建 PR |
| `scripts/validate-launchpad.mjs` | 产物结构与跨字段不变量校验 |
| `scripts/verify-submission.mjs` | 仓库体检与卡片预览生成 |
| `scripts/refresh-pulse-and-pins.mjs` | 每日撤下到期置顶，刷新星数与讨论热度 |
| `scripts/lib/` | 基础库：`shared.mjs`（协议/分类/平台）、`github.mjs`（API）、`discussions.mjs`（讨论与物料） |
| `scripts/bootstrap-repo.sh` | 初始化标签，打印需手动开启的仓库设置 |

## 流程

1. **投稿与自动建 PR（`issue-to-pr.yml`）**：作者用「开源广场投稿」Issue 模板提交（自动带 `launchpad-submission` 标签）。工作流校验仓库与字段后写入 `launches/<...>.json`，推送到 `launchpad/issue-<N>` 分支，自动创建/更新 PR 并写入 `launchpad-ingest=success` 状态检查。
   - 默认合并策略 `AUTO_MERGE_POLICY=manual`：由维护者审核 PR 后点击 Merge；
   - 维护者也可直接给 Issue 贴 `auto-merge`、`approved`、`pinned-7d`、`pinned-14d`、`pinned-30d` 或 `featured-7d` 标签自动 squash merge。
2. **手动 PR 门禁（`launchpad-gate.yml`）**：贡献者也可直接 Fork 新增 `launches/<...>.json` 提 PR，由可信 `main` 脚本校验后写入 `launchpad-ingest=success`。
3. **合入后编译与发布（`build-launchpad.yml`）**：PR 合入 `main` 后，工作流在 `Launches` 分类创建或绑定 Discussion，编译生成根目录 `launchpad.json` 并推送，最后在原 Issue 下回复深链与 README 徽章并自动关闭 Issue。
4. **每日保鲜（`expire-pins-and-pulse.yml`，每日 UTC 00:15）**：撤下到期置顶（同步清理 `launches/` 与 `launchpad.json`），批量刷新星数、Fork、版本、评论数与顶帖数，只在数据变化时提交。

所有写 `launchpad.json` 的工作流共享并发组 `launchpad-json-write`，按顺序执行。

## 初始化

```bash
GH_REPO=superMC5657/z-store-launchpad scripts/bootstrap-repo.sh
```

脚本创建所需标签并列出网页上的剩余步骤：开启 Discussions、新建 `Launches` 分类、为 Actions 开启读写权限。

## 本地开发

需要 Node.js 20 或更高版本，无第三方依赖。

```bash
npm run build
npm run validate
npm test
```

## 安全

- Issue 正文只经环境变量/REST API 作为数据读取，工作流的 `run:` 中不直接插值任何 Issue 内容；
- PR 门禁只使用 `main` 分支的可信脚本，不执行外部 PR 自带脚本；
- GraphQL 一律通过 `variables` 传参；
- 赞助凭证字段只接受订单号或交易尾号，体检报告不会回显它。
