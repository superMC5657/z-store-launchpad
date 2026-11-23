# 上下架

有两个入口，改的都是同一个 `delisted` 字段：

- **维护者**：在作品讨论帖上贴 / 摘 `launchpad-delist` 标签，立即下架 / 恢复，不经过 PR（见「讨论帖标签」）。
- **仓库所有者**（条目 `maker.login`）：用下架模板提交，**直接生效**，机器人提交 main、触发 Publish 并关闭 Issue。例外：被他人（维护者）下架的条目，所有者恢复仍走 PR。
- **其他人**（含代投稿人 `submitted_by`）：**Issue → 机器人生成 PR → 维护者手动 merge**；merge 即生效，关闭 PR 即驳回。

没有任何自动下架。

## 状态

条目是否出现在 `launchpad.json` 只由真源 `launches/<...>.json` 的 `delisted` 字段决定。下架不删文件，`build-launchpad.mjs` 编译时跳过它；恢复只删掉这个字段，原讨论帖与 `launched_at` 都保留。

```json
"delisted": {
  "at": "2026-11-23T08:00:00Z",
  "by": "issue-author-login",
  "note": "可选，单行，≤ 280 字"
}
```

下架时同时删除条目的 `pin`，释放置顶坑位。`delisted` 与 `submitted_by` 都是 source-only 字段，不写入 `launchpad.json`。客户端协议不变：下架条目在客户端刷新后消失（`raw.githubusercontent.com` CDN 缓存最长约 5 分钟）。

## 入口

| Issue 模板（标签） | 条目当前状态 | 生成的 PR |
| --- | --- | --- |
| 提交或更新作品 `launchpad-submission` | 不存在 | `add`：新建条目 |
| | 在架 | `update`：更新字段，保留讨论帖、`launched_at`、置顶 |
| | 已下架 | `relist`：更新字段并删除 `delisted` |
| 下架或恢复作品 `launchpad-delist` → 下架 | 在架 | `delist`：写入 `delisted`，释放置顶 |
| 下架或恢复作品 `launchpad-delist` → 恢复 | 已下架 | `relist`：重新体检仓库，通过后删除 `delisted` |

以下情况机器人只在 Issue 下回复、不建 PR：体检失败、置顶坑位已满、条目不存在、已是目标状态、内容没有变化。作者编辑 Issue 正文保存后会重新处理，同一个 Issue 始终对应同一个分支 `launchpad/issue-<N>` 和同一个 PR。

## 讨论帖标签

每个作品只有一个讨论帖（`Launches` 分类），帖子上的 `launchpad-delist` 标签与条目的 `delisted` 一一对应。`discussion-label.yml` 监听标签变化：

| 操作 | 条目当前状态 | 结果 |
| --- | --- | --- |
| 贴上标签 | 在架 | 写入 `delisted`（`by` 为贴标签的维护者），释放置顶，帖子回复「已下架」 |
| 摘掉标签 | 已下架 | 重新体检仓库，通过后删除 `delisted`，帖子回复「已恢复」 |
| 摘掉标签 | 已下架，体检失败 | 不改真源，把标签贴回去并在帖子里列出原因 |
| 任意 | 已与标签一致 | 不做任何事 |

- 只有对本仓库有写权限（write / maintain / admin）的人改标签才算数；其他人改的会被机器人还原并在帖子里说明。
- 改动直接提交 `main`，同一个 job 里编译 `launchpad.json` 并校验，提交带 `[skip ci]`。
- 走 Issue 下架 / 恢复的条目（PR 合并或所有者自助），随后的 `publish.yml` 会把讨论帖标签同步成一致状态。
- 只对本仓库的讨论帖生效；作者关联到自己仓库的讨论帖只能走 Issue。

## 维护者审核

PR 正文会列出需要人工判断的点：

- 申请人不是原投稿人（`submitted_by`）或仓库所有者（`maker.login`）；
- 申请置顶，需要先核对赞助凭证（`pin_until` 按建 PR 的时间计算，可在合并前直接改 PR 里的 JSON）；
- 恢复上架时附上原下架记录；
- 仓库所有者申请恢复一个被维护者下架的条目。

PR 正文带 `Closes #<N>`，merge 时自动关闭源 Issue。维护者自己要下架违规条目，直接在讨论帖上贴 `launchpad-delist` 标签即可。

## 合并之后

`publish.yml` 在 `launches/**` 推送到 `main` 时运行：为新条目在 `Launches` 分类创建讨论帖，编译 `launchpad.json`，校验通过后推回 `main`。下架不动讨论帖。

## 彻底移除

作者要求删除全部数据时，直接删除 `launches/<...>.json` 发 PR；合入后 `publish.yml` 重新编译。讨论帖需维护者另行处理。
