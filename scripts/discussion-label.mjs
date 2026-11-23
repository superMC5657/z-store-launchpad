#!/usr/bin/env node
/**
 * discussion-label.mjs
 *
 * 讨论帖上的 `launchpad-delist` 标签 = 条目的下架开关（每个作品只有一个讨论帖，标签状态与 `delisted` 一一对应）。
 * 只有仓库写权限以上的维护者改标签才生效，其他人改的会被还原。
 *
 * | 讨论帖标签       | 条目当前状态 | 结果                                                 |
 * |------------------|--------------|------------------------------------------------------|
 * | 贴上             | 在架         | delist：写入 `delisted`（by = 维护者），释放置顶     |
 * | 摘掉             | 已下架       | relist：重新体检仓库，通过后删除 `delisted`          |
 * | 摘掉（体检失败） | 已下架       | 不改真源，把标签贴回去并在帖子里说明                 |
 * | 与状态一致       | —            | 不做任何事（机器人自己同步标签触发的事件走这里）     |
 *
 * 用法：
 *   node scripts/discussion-label.mjs --discussion 3 --actor alice --reply reply.md --commit-msg commit.txt
 *   node scripts/discussion-label.mjs --comment 3 --body-file reply.md   # 在讨论帖下回复
 *   node scripts/discussion-label.mjs --sync-all                         # 按真源把所有讨论帖标签对齐（publish.yml 调用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCHPAD_REPO, formatJson, isDelisted, isoNow, parseRepoUrl } from './lib/shared.mjs';
import { graphql, rest } from './lib/github.mjs';
import { collectLaunchFiles } from './build-launchpad.mjs';
import { evaluateRepo, fetchRepoFacts } from './verify-submission.mjs';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');

export const DELIST_LABEL = 'launchpad-delist';
const WRITE_PERMISSIONS = new Set(['admin', 'write']);

const DISCUSSION_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $label: String!) {
  repository(owner: $owner, name: $name) {
    label(name: $label) { id }
    discussion(number: $number) { id labels(first: 50) { nodes { name } } }
  }
}`;
const ADD_LABELS = `mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }`;
const REMOVE_LABELS = `mutation($id: ID!, $labels: [ID!]!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }`;
const ADD_COMMENT = `mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { url } } }`;

const sameRepo = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** 在 `launches/` 里找绑定了本仓库第 `number` 号讨论帖的条目。 */
export function findEntryByDiscussion(launchesDir, number, repo = LAUNCHPAD_REPO) {
  for (const file of collectLaunchFiles(launchesDir)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.discussion_number === number && sameRepo(data.discussion_repo, repo)) return { file, data };
  }
  return null;
}

/**
 * 根据讨论帖标签决定条目的变化（不做 I/O 写入）。
 * 返回 `{ action: 'delist' | 'relist' | 'none', next?, reply?, wantLabel? }`：
 * `next` 是要写回的真源；`wantLabel` 非空表示要把标签强制改成该状态（还原无效操作）。
 */
export async function handleDiscussionLabel({ entry, hasLabel, actor, authorized, token, fetchImpl = fetch, nowMs = Date.now() }) {
  const delisted = isDelisted(entry);
  if (hasLabel === delisted) return { action: 'none' };

  if (!authorized) {
    return {
      action: 'none',
      wantLabel: delisted,
      reply: `ℹ️ 只有维护者可以通过 \`${DELIST_LABEL}\` 标签上下架，@${actor} 的改动已还原。作者如需下架，请用「下架或恢复作品」Issue 模板提交申请。`,
    };
  }

  if (hasLabel) {
    const next = { ...entry, delisted: { at: isoNow(nowMs), by: actor } };
    const lines = [`🔻 已下架：\`${entry.id}\` 由 @${actor} 从开源广场撤下，客户端刷新后消失。讨论帖保留，摘掉 \`${DELIST_LABEL}\` 标签即可恢复。`];
    if (next.pin) {
      lines.push('', `原置顶（至 ${next.pin.pin_until}）已释放坑位。`);
      delete next.pin;
    }
    return { action: 'delist', next, reply: lines.join('\n') };
  }

  // 恢复前重新体检：仓库删除、转私有、归档或协议变化都不能直接回来。
  const coord = parseRepoUrl(`https://${entry.forge_host}/${entry.owner}/${entry.repo}`);
  const facts = coord ? await fetchRepoFacts(coord, { token, fetchImpl }).catch(() => null) : null;
  const { errors } = evaluateRepo(facts);
  if (errors.length) {
    return {
      action: 'none',
      wantLabel: true,
      reply: ['❌ 仓库未通过体检，暂不能恢复上架，已把标签贴回去：', '', ...errors.map((e) => `- ${e}`), '', '问题解决后再摘掉标签即可。'].join('\n'),
    };
  }
  const next = { ...entry };
  delete next.delisted;
  return {
    action: 'relist',
    next,
    reply: `✅ 已恢复上架：\`${entry.id}\` 由 @${actor} 恢复，沿用原讨论帖与上架时间（原下架于 ${entry.delisted.at} · @${entry.delisted.by}）。`,
  };
}

async function hasWritePermission(repo, login, { token, fetchImpl }) {
  const res = await rest(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { token, fetchImpl, allow404: true });
  return WRITE_PERMISSIONS.has(res?.permission);
}

async function loadDiscussion(repo, number, { token, fetchImpl }) {
  const [owner, name] = repo.split('/');
  const data = await graphql(DISCUSSION_QUERY, { owner, name, number, label: DELIST_LABEL }, { token, fetchImpl });
  const d = data?.repository?.discussion;
  if (!d) return null;
  const labelId = data.repository.label?.id;
  if (!labelId) throw new Error(`仓库缺少 ${DELIST_LABEL} 标签，请先运行 scripts/bootstrap-repo.sh`);
  return { id: d.id, labelId, hasLabel: d.labels.nodes.some((l) => l.name === DELIST_LABEL) };
}

async function setLabel(discussion, want, { token, fetchImpl }) {
  if (discussion.hasLabel === want) return false;
  await graphql(want ? ADD_LABELS : REMOVE_LABELS, { id: discussion.id, labels: [discussion.labelId] }, { token, fetchImpl });
  return true;
}

/** 事件模式：按讨论帖当前标签状态更新真源；写了文件才输出提交信息。 */
async function runEvent(args, ctx) {
  const number = Number(args.discussion);
  const found = findEntryByDiscussion(args.dir, number, args.repo);
  if (!found) {
    console.log(`讨论帖 #${number} 未绑定任何条目，忽略`);
    return;
  }
  const discussion = await loadDiscussion(args.repo, number, ctx);
  if (!discussion) throw new Error(`讨论帖 #${number} 不存在`);
  const authorized = await hasWritePermission(args.repo, args.actor, ctx);
  const out = await handleDiscussionLabel({ entry: found.data, hasLabel: discussion.hasLabel, actor: args.actor, authorized, ...ctx });

  if (out.next) {
    fs.writeFileSync(found.file, formatJson(out.next));
    if (args.commitMsg) fs.writeFileSync(args.commitMsg, `launch: ${out.action} ${found.data.name} (${found.data.id}) via discussion #${number}\n`);
  }
  if (out.wantLabel !== undefined) await setLabel(discussion, out.wantLabel, ctx);
  if (out.reply && args.reply) fs.writeFileSync(args.reply, `${out.reply}\n`);
  console.log(`${found.data.id}: ${out.action}`);
}

async function runComment(args, ctx) {
  const discussion = await loadDiscussion(args.repo, Number(args.comment), ctx);
  if (!discussion) throw new Error(`讨论帖 #${args.comment} 不存在`);
  const body = fs.readFileSync(args.bodyFile, 'utf8');
  const data = await graphql(ADD_COMMENT, { id: discussion.id, body }, ctx);
  console.log(data.addDiscussionComment.comment.url);
}

/** 按真源 `delisted` 对齐所有本仓库讨论帖的标签（下架 Issue 合并后由 publish.yml 调用）。 */
async function runSyncAll(args, ctx) {
  for (const file of collectLaunchFiles(args.dir)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(data.discussion_number) || !sameRepo(data.discussion_repo, args.repo)) continue;
    const discussion = await loadDiscussion(args.repo, data.discussion_number, ctx);
    if (discussion && (await setLabel(discussion, isDelisted(data), ctx))) {
      console.log(`${data.id}: 讨论帖 #${data.discussion_number} 标签 → ${isDelisted(data) ? '贴上' : '摘掉'}`);
    }
  }
}

function parseArgs(argv) {
  const args = { dir: path.join(rootDir, 'launches'), repo: process.env.GITHUB_REPOSITORY || LAUNCHPAD_REPO };
  const known = ['discussion', 'actor', 'reply', 'commitMsg', 'comment', 'bodyFile', 'dir', 'repo'];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (key === 'syncAll') args.syncAll = true;
    else if (known.includes(key) && argv[i + 1] !== undefined) args[key] = argv[++i];
    else throw new Error(`未知参数或缺少取值: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('需要 GITHUB_TOKEN');
  const ctx = { token, fetchImpl: fetch };
  if (args.syncAll) return runSyncAll(args, ctx);
  if (args.comment) return runComment(args, ctx);
  if (args.discussion && args.actor) return runEvent(args, ctx);
  throw new Error('用法：--discussion N --actor LOGIN | --comment N --body-file F | --sync-all');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
