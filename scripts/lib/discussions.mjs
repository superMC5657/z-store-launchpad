/**
 * discussions.mjs
 *
 * 社区 Discussions 与物料生成工具：
 * - 复用或在 Launches 分类新建 Discussion；
 * - 生成规范讨论帖标题与正文；
 * - 渲染作者传播物料包（深链、讨论链接、README 徽章）。
 */

import { LAUNCHPAD_REPO, parseLinkedDiscussion } from './shared.mjs';
import { graphql } from './github.mjs';

const CATEGORY_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    discussionCategories(first: 20) { nodes { id name slug } }
  }
}`;

const CREATE_DISCUSSION = `
mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
    discussion { id number url }
  }
}`;

const DISCUSSION_LOOKUP = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { discussion(number: $number) { id number url } }
}`;

export function discussionTitle(item) {
  return `${item.name} (${item.owner}/${item.repo}) — ${item.maker_note}`.slice(0, 250);
}

export function discussionBody(item) {
  return [
    `**${item.name}** · ${item.description}`,
    '',
    `> ${item.maker_note}`,
    '',
    `- 支持平台 / Platforms: ${item.platforms.join(', ')}`,
    `- 协议 / License: ${item.license}`,
    `- 源仓库 / Repository: https://${item.forge_host}/${item.owner}/${item.repo}`,
    `- 在 ZStore 中打开 / Open in ZStore: \`zstore://launchpad/${item.id}\``,
    '',
    '欢迎 +1 顶帖并留下你的使用反馈！ / Upvote and share your feedback!',
  ].join('\n');
}

/** 复用或创建 Discussion：作者关联帖 → 存量绑定 → 在 Launches 分类新建。 */
export async function resolveDiscussion({ item, submission, existing, token, fetchImpl }) {
  const linked = parseLinkedDiscussion(submission?.linked_discussion_url);
  if (linked) {
    const [owner, name] = linked.repo.split('/');
    const data = await graphql(DISCUSSION_LOOKUP, { owner, name, number: linked.number }, { token, fetchImpl });
    const d = data?.repository?.discussion;
    if (d) return { discussion_repo: linked.repo, discussion_number: d.number, discussion_node_id: d.id, discussion_url: d.url };
  }
  if (existing?.discussion_number) {
    return {
      discussion_repo: existing.discussion_repo,
      discussion_number: existing.discussion_number,
      discussion_node_id: existing.discussion_node_id,
      discussion_url: existing.discussion_url,
    };
  }
  const [owner, name] = LAUNCHPAD_REPO.split('/');
  const repoData = await graphql(CATEGORY_QUERY, { owner, name }, { token, fetchImpl });
  const category = repoData?.repository?.discussionCategories?.nodes?.find(
    (c) => c.slug === 'launches' || c.name.toLowerCase() === 'launches',
  );
  if (!category) throw new Error('未找到 Launches 讨论分类，请先运行 scripts/bootstrap-repo.sh 并在 Settings 中创建');
  const created = await graphql(
    CREATE_DISCUSSION,
    { repositoryId: repoData.repository.id, categoryId: category.id, title: discussionTitle(item), body: discussionBody(item) },
    { token, fetchImpl },
  );
  const d = created.createDiscussion.discussion;
  return { discussion_repo: LAUNCHPAD_REPO, discussion_number: d.number, discussion_node_id: d.id, discussion_url: d.url };
}

/** 作者传播物料包。 */
export function renderShareKit(item, pin) {
  const badge = `[![Launched on ZStore](https://img.shields.io/badge/ZStore-Launchpad-111111?style=flat-square)](https://z-store-web.pages.dev/launchpad)`;
  return [
    '### 🚀 已上架开源广场 / Launched on ZStore Launchpad',
    '',
    pin ? `置顶推荐至 ${pin.pin_until}（${pin.pin_tier}） / Spotlight until ${pin.pin_until}` : '已加入「最新上架」新品池 / Listed in Recent Launches',
    '',
    `- 广场直达 / Launchpad link: \`zstore://launchpad/${item.id}\``,
    `- 应用详情 / App detail: \`zstore://app/${item.id}\``,
    `- 社区讨论 / Discussion: ${item.discussion_url}`,
    '',
    'README 徽章 / README badge:',
    '',
    '```markdown',
    badge,
    '```',
  ].join('\n');
}
