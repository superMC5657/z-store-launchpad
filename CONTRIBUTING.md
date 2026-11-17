# 参与开源广场

## 提交作品

### 方式 A：通过 Issue 表单提交（推荐）

1. 打开 [新建 Issue](https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml)，选择「开源广场投稿」。
2. 填写仓库地址、应用名称、分类和一句话自荐（上限 140 字，会折叠为单行）。英文自荐语可选，英文界面优先展示。
3. 选择档位：`free` 进入「最新上架」新品池；`spotlight-*` 申请顶部置顶推荐。
4. 提交后 `issue-to-pr.yml` 会自动体检仓库并创建 PR（仅修改 `launches/<...>.json`）。若出现 `needs-changes`，按报告修改仓库或编辑 Issue，机器人会自动重跑并更新同一 PR。
5. 维护者审核合并 PR（或为 Issue 打上 `approved` / `auto-merge` / `pinned-*` 标签自动合并）后，`build-launchpad.yml` 会创建讨论帖、编译 `launchpad.json`，并在 Issue 下回复：
   - 广场直达深链 `zstore://launchpad/<id>`
   - 应用详情深链 `zstore://app/<id>`
   - 讨论帖链接
   - 可贴进 README 的徽章

### 方式 B：直接 Fork 提 PR

1. Fork 本仓库，在 `launches/<owner>/<repo>.json`（非 GitHub 源为 `launches/<forge>/<owner>/<repo>.json`）新增条目。
2. 本地运行校验通过后向 `main` 发起 PR，由 `launchpad-gate.yml` 校验门禁：

```bash
npm run validate
npm test
```

## 置顶推荐

- 坑位最多 4 个，按到期时间自动释放；坑位已满时机器人会告知最早释放时间。
- 通过本仓库 Issue 模板提交的开源项目置顶仍须满足公开仓库、OSI 协议与可安装 Release 门槛；开发者向商业赞助合作由维护者线下人工审核对接。所有置顶与赞助均不影响 ZStore 精选目录与个性化推荐。
- 赞助凭证只填订单号或交易号后 6 位。Issue 是公开的，不要粘贴任何密钥、账号或个人信息。

## 修改数据

`launchpad.json` 由 `build-launchpad.yml` 从 `launches/` 自动编译生成，请勿直接手改根目录 `launchpad.json`。确需修改条目请改对应的 `launches/<...>.json` 并发 PR，并确保下面两条命令通过：

```bash
npm run validate
npm test
```
