# z-store-launchpad

ZStore「开源广场（Launchpad）」的数据仓：采用与 `z-store-catalog` 一致的**「单应用真源拆分 + Issue 自动建 PR + 维护者手动合并 + 合入后自动编译」**架构。客户端从 `raw.githubusercontent.com` 拉取编译后的 `launchpad.json`（失败时可经加速镜像重试一次），不依赖任何自建服务，也不做任何行为埋点。

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
| `launchpad.json` | 编译后的客户端消费清单，只由 `publish.yml` 生成，请勿手改 |
| `state/stars-history.json` | 星数快照，只在星数变化时写入，用于计算 `stars_7d_delta` |
| `schema/launchpad.schema.json` | JSON Schema（Draft 2020-12） |
| `scripts/issue-to-pr.mjs` | 解析上架 / 下架 Issue，体检仓库，改写 `launches/`，生成 PR 标题、正文与 Issue 回复 |
| `scripts/verify-submission.mjs` | 投稿表单解析与仓库体检（公开、非归档、非 Fork、OSI 协议、Release 安装包） |
| `scripts/build-launchpad.mjs` | 校验 `launches/`、为新条目创建 Discussion、编译 `launchpad.json` |
| `scripts/validate-launchpad.mjs` | 产物结构与跨字段不变量校验 |
| `scripts/discussion-label.mjs` | 讨论帖 `launchpad-delist` 标签 ↔ 条目 `delisted` 双向同步 |
| `scripts/refresh-pulse-and-pins.mjs` | 每日撤下到期置顶，刷新星数与讨论热度 |
| `scripts/lib/` | `shared.mjs`（协议 / 分类 / 平台 / 表单解析）、`github.mjs`（API）、`discussions.mjs`（讨论帖） |
| `scripts/bootstrap-repo.sh` | 创建两个模板标签，打印需手动开启的仓库设置 |

## 流程：Issue → PR → 维护者手动 merge

作者的上架、更新、下架、重新上架都走这条路，机器人从不合并 PR（维护者直接下架 / 恢复见下文「上下架」）：

```
作者提 Issue ──► issue-to-pr.yml ──► PR（launchpad/issue-<N>，正文 Closes #N）
                    │                       │
                    └ 体检失败等：只在 Issue 回复     ├ 维护者 merge ──► publish.yml 绑定讨论帖、编译 launchpad.json
                                                └ 维护者关闭 PR ──► 驳回
```

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| `issue-to-pr.yml` | 带模板标签的 Issue 打开 / 编辑 / 重开 | 跑 `issue-to-pr.mjs`，推送分支、建或更新 PR，在 Issue 下维护一条回复 |
| `publish.yml` | `launches/**` 推到 `main`；每日 UTC 00:15；手动 | 绑定讨论帖 → 编译 `launchpad.json`（定时运行时顺带刷新热度、撤下到期置顶）→ 推回 `main` → 对齐讨论帖下架标签 |
| `discussion-label.yml` | 讨论帖贴上 / 摘掉 `launchpad-delist` | 维护者操作即下架 / 体检后恢复，直接提交 `main` 并编译；非维护者的改动被还原 |
| `validate.yml` | 所有 PR 与 `main` 推送 | 只读权限下 `npm run validate && npm test` |

## 上下架

| Issue 模板 | 用途 |
| --- | --- |
| 「上架 / 更新 / 重新上架」（`launchpad-submission`） | 新作品上架；已上架的再提交即更新；已下架的再提交即重新上架 |
| 「下架 / 恢复上架」（`launchpad-delist`） | 下架；或只填仓库地址恢复已下架作品（会重新体检仓库） |

**维护者直接操作**：在作品的讨论帖上贴 `launchpad-delist` 标签即下架，摘掉即恢复（先重新体检仓库），不经过 PR。

谁都可以提 Issue，是否生效只看维护者是否 merge；PR 正文会标出申请人是否为作者、是否申请置顶等需要核对的点。条目是否在架只由 `launches/<...>.json` 的 `delisted` 字段决定，详见 [docs/delisting.md](docs/delisting.md)。

## 初始化

```bash
GH_REPO=superMC5657/z-store-launchpad scripts/bootstrap-repo.sh
```

脚本创建 `launchpad-submission` / `launchpad-delist` 两个标签并列出网页上的剩余步骤：开启 Discussions、新建 `Launches` 分类、为 Actions 开启读写权限并允许其创建 PR。可选配置 `LAUNCHPAD_BOT_TOKEN`（PAT）：默认 token 建的 PR 不会触发 `validate.yml`，且 `main` 受保护时 `publish.yml` 需要它来推送。

## 本地开发

需要 Node.js 20 或更高版本，无第三方依赖。

```bash
npm run build
npm run validate
npm test

# 本地预演一份 Issue 正文（不传 --pr-title 就不写 launches/）
node scripts/issue-to-pr.mjs --body-file issue.md --kind submit --author alice --reply reply.md
```

## 安全

- Issue 正文只经环境变量/REST API 作为数据读取，工作流的 `run:` 中不直接插值任何 Issue 内容；
- 机器人只建 PR、从不合并，`launches/` 的任何变化都要经过维护者 merge；
- `validate.yml` 以只读权限运行，不接触任何 secret；
- GraphQL 一律通过 `variables` 传参；
- 赞助凭证字段只接受订单号或交易尾号，Issue 回复与 PR 正文都不会回显它。
