#!/usr/bin/env bash
# 幂等创建 Issue 模板用到的两个标签，并打印需要在网页上完成的设置。
# 用法：GH_REPO=superMC5657/z-store-launchpad scripts/bootstrap-repo.sh
set -euo pipefail

REPO="${GH_REPO:-superMC5657/z-store-launchpad}"

gh label create launchpad-submission --repo "$REPO" --color 5319e7 --description "上架 / 更新 / 重新上架" --force >/dev/null
gh label create launchpad-delist --repo "$REPO" --color 6e7781 --description "下架 / 恢复上架" --force >/dev/null
echo "✓ labels: launchpad-submission, launchpad-delist"

cat <<CHECKLIST

接下来请在网页上完成（只需一次）：
  1. https://github.com/$REPO/settings → Features → 勾选 Discussions
  2. https://github.com/$REPO/discussions/categories → 新建分类 "Launches"
  3. https://github.com/$REPO/settings/actions → Workflow permissions 选 "Read and write permissions"，
     并勾选 "Allow GitHub Actions to create and approve pull requests"
  4. 可选：配置 secret LAUNCHPAD_BOT_TOKEN（PAT）。用默认 token 建的 PR 不会触发 validate.yml；
     若 main 开启了保护，publish.yml 推送 launchpad.json 也需要这个 token 具备绕过权限。
CHECKLIST
