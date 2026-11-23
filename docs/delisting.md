# 上下架

所有上架、更新、下架、重新上架都走同一条路：**Issue → 机器人生成 PR → 维护者手动 merge**。机器人不合并、不贴标签、不判断权限，也没有任何自动下架；merge 即生效，关闭 PR 即驳回。

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
| 上架 `launchpad-submission` | 不存在 | `add`：新建条目 |
| | 在架 | `update`：更新字段，保留讨论帖、`launched_at`、置顶 |
| | 已下架 | `relist`：更新字段并删除 `delisted` |
| 下架 / 恢复 `launchpad-delist` → 下架 | 在架 | `delist`：写入 `delisted`，释放置顶 |
| 下架 / 恢复 `launchpad-delist` → 恢复 | 已下架 | `relist`：重新体检仓库，通过后删除 `delisted` |

以下情况机器人只在 Issue 下回复、不建 PR：体检失败、置顶坑位已满、条目不存在、已是目标状态、内容没有变化。作者编辑 Issue 正文保存后会重新处理，同一个 Issue 始终对应同一个分支 `launchpad/issue-<N>` 和同一个 PR。

## 维护者审核

PR 正文会列出需要人工判断的点：

- 申请人不是原投稿人（`submitted_by`）或仓库所有者（`maker.login`）；
- 申请置顶，需要先核对赞助凭证（`pin_until` 按建 PR 的时间计算，可在合并前直接改 PR 里的 JSON）；
- 恢复上架时附上原下架记录。

PR 正文带 `Closes #<N>`，merge 时自动关闭源 Issue。维护者自己要下架违规条目，同样提一个下架 Issue（或直接改 `launches/` 发 PR）后合并即可。

## 合并之后

`publish.yml` 在 `launches/**` 推送到 `main` 时运行：为新条目在 `Launches` 分类创建讨论帖，编译 `launchpad.json`，校验通过后推回 `main`。下架不动讨论帖。

## 彻底移除

作者要求删除全部数据时，直接删除 `launches/<...>.json` 发 PR；合入后 `publish.yml` 重新编译。讨论帖需维护者另行处理。
