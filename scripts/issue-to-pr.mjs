#!/usr/bin/env node
/**
 * issue-to-pr.mjs
 *
 * Issue → `launches/<...>.json` 改动 → PR 标题 / 正文 + Issue 回复。唯一的写入口，**不合并、不贴标签、不判权限**：
 * 是否上架、下架、恢复，全部由维护者看 PR 后手动 merge 决定。
 *
 * | Issue 模板（标签）                  | 条目状态   | 结果                                          |
 * |-------------------------------------|------------|-----------------------------------------------|
 * | 提交或更新 `launchpad-submission`   | 不存在     | add：新建条目                                 |
 * |                                     | 在架       | update：更新字段，保留讨论帖与 `launched_at`  |
 * |                                     | 已下架     | relist：更新字段并删除 `delisted`             |
 * | 下架或恢复 `launchpad-delist`       | 在架       | delist：写入 `delisted`，释放置顶             |
 * |                                     | 已下架     | relist：重新体检仓库后删除 `delisted`         |
 *
 * 例外：仓库所有者（`maker.login`）用下架模板下架、或恢复自己下架的条目时直接生效——写 `--commit-msg` 而不是
 * `--pr-title`，工作流直接提交 main。维护者下架的条目，所有者恢复仍走 PR。
 *
 * 用户问题（体检失败、条目不存在、无变化）只写 `--reply`，不写 `--pr-title`；工作流据此决定是否建 PR。
 * 只有传了 `--pr-title` 或 `--commit-msg` 才会写 `launches/`，都不传即本地预演。
 *
 * 用法：
 *   node scripts/issue-to-pr.mjs --issue 12 --pr-title pr-title.txt --pr-body pr-body.md --reply reply.md --commit-msg commit.txt
 *   node scripts/issue-to-pr.mjs --body-file issue.md --kind submit --author alice --reply reply.md   # 本地预演
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHPAD_REPO,
  MAKER_NOTE_MAX,
  SPOTLIGHT_MAX_SLOTS,
  addDaysIso,
  charCount,
  deriveId,
  foldLine,
  formatJson,
  isDelisted,
  isIsoUtc,
  isMaker,
  isRepoOwner,
  isoNow,
  optionKey,
  parseIssueForm,
  parseLinkedDiscussion,
  parseRepoUrl,
} from './lib/shared.mjs';
import { rest } from './lib/github.mjs';
import { resolveDiscussion } from './lib/discussions.mjs';
import { evaluateRepo, fetchRepoFacts, renderReport, verifySubmission } from './verify-submission.mjs';
import { launchFilePath, loadAndValidateSources, validateLaunchSource } from './build-launchpad.mjs';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');

export const SUBMIT_LABEL = 'launchpad-submission';
export const DELIST_LABEL = 'launchpad-delist';
const NOTE_MAX = MAKER_NOTE_MAX * 2;

/** 与 .github/ISSUE_TEMPLATE/delist-launchpad.yml 的 label 一致。 */
export const DELIST_FORM_HEADINGS = {
  repo_url: '开源仓库地址 / Repository URL',
  action: '操作 / Action',
  note: '说明 / Note',
};

export function parseDelistForm(body) {
  const raw = parseIssueForm(body, DELIST_FORM_HEADINGS);
  return { repo_url: foldLine(raw.repo_url), action: optionKey(raw.action), note: foldLine(raw.note) };
}

/** `spotlight-Nd` → 赞助置顶 N 天；其他档位不置顶。 */
export function pinDays(launchTier) {
  const m = /^spotlight-(\d+)d$/i.exec(String(launchTier || '').trim());
  return m ? Number(m[1]) : 0;
}

function readSource(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const reply = (title, lines = []) => [`### ${title}`, '', ...lines].join('\n');

/** 结果里只有 `reply` 时不建 PR。 */
const replyOnly = (title, lines) => ({ reply: reply(title, lines) });

/** 生成 PR 标题与正文；`Closes #N` 让维护者合并时自动关闭源 Issue。 */
function prOutput({ action, data, relPath, issueNumber, author, notes = [], extra = [] }) {
  const verb = { add: '上架', update: '更新', relist: '重新上架', delist: '下架' }[action];
  const title = `launch: ${action} ${data.name} (${data.id})`;
  const body = [
    `## ${verb}：${data.name}`,
    '',
    `- 应用：\`${data.id}\``,
    `- 真源：\`launches/${relPath}\``,
    ...(author ? [`- 申请人：@${author}${isMaker(data, author) ? '（作者）' : ''}`] : []),
    ...extra,
    '',
    ...(notes.length ? ['### ⚠️ 合并前请核对', ...notes.map((n) => `- ${n}`), ''] : []),
    ...(issueNumber ? [`Closes #${issueNumber}`, ''] : []),
    '维护者确认无误后手动 merge；合并后 `publish.yml` 绑定讨论帖并重新编译 `launchpad.json`。不合并直接关闭本 PR 即为驳回。',
  ].join('\n');
  return { title, body: `${body}\n` };
}

function writeEntry(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatJson(data));
}

/** 提交或更新作品（投稿表单）：上架 / 更新 / 带新资料恢复。 */
export async function handleSubmission({ body, issueNumber = null, author = '', launchesDir, write = false, token, fetchImpl = fetch, nowMs = Date.now() }) {
  const verified = await verifySubmission(body, { token, fetchImpl, nowIso: isoNow(nowMs) });
  if (!verified.ok || !verified.item) {
    return replyOnly('❌ 需要修改 / Changes needed', [
      renderReport(verified),
      '',
      '编辑本 Issue 正文并保存即可重新检查。 / Edit the issue body to re-run the checks.',
    ]);
  }

  const item = verified.item;
  const sub = verified.submission;
  const file = launchFilePath(launchesDir, item.id);
  const relPath = path.relative(launchesDir, file).replace(/\\/g, '/');
  const existing = readSource(file);
  const notes = [];

  const next = {
    ...item,
    launched_at: existing?.launched_at || item.launched_at,
    submitted_by: existing?.submitted_by || author || undefined,
  };
  if (!next.submitted_by) delete next.submitted_by;
  // 热数据以 launchpad.json 为准（每日刷新），真源沿用旧值，避免星数变化让「无改动」的重提也生成 PR。
  for (const k of ['stars', 'stars_7d_delta', 'forks', 'discussion_repo', 'discussion_number', 'discussion_node_id', 'discussion_url']) {
    if (existing?.[k] !== undefined) next[k] = existing[k];
  }
  // 作者关联了自有仓库的 Discussion：此时只读校验并绑定；否则合并后由 publish.yml 在 Launches 分类新建。
  if (!next.discussion_number && parseLinkedDiscussion(sub.linked_discussion_url) && token) {
    Object.assign(next, await resolveDiscussion({ item: next, submission: sub, existing: null, token, fetchImpl }));
  }

  const days = pinDays(sub.launch_tier);
  if (days) {
    const { entries } = loadAndValidateSources(launchesDir, { nowMs });
    const otherPins = entries
      .map(({ data }) => data)
      .filter((d) => d.id !== item.id && !isDelisted(d) && d.pin && isIsoUtc(d.pin.pin_until) && Date.parse(d.pin.pin_until) > nowMs);
    if (otherPins.length >= SPOTLIGHT_MAX_SLOTS) {
      const earliest = otherPins.map((d) => d.pin.pin_until).sort()[0];
      return replyOnly('❌ 置顶坑位已满 / Spotlight is full', [
        `${SPOTLIGHT_MAX_SLOTS} 个坑位已满，最早 **${earliest}** 释放。可在那之后编辑本 Issue，或把档位改成 \`free\`。`,
        `All ${SPOTLIGHT_MAX_SLOTS} slots are taken until **${earliest}**. Edit this issue after that, or switch the tier to \`free\`.`,
      ]);
    }
    next.pin = { pin_until: addDaysIso(nowMs, days), pin_tier: 'sponsor', pin_order: existing?.pin?.pin_order || otherPins.length + 1 };
    notes.push(`申请置顶 ${days} 天（${sub.launch_tier}），请先核对赞助凭证；\`pin_until\` 按建 PR 时间计算，可在合并前修改。`);
  } else if (existing?.pin && !isDelisted(existing)) {
    next.pin = existing.pin; // 更新普通字段不影响进行中的置顶
  }

  const action = !existing ? 'add' : isDelisted(existing) ? 'relist' : 'update';
  if (action === 'relist') notes.push(`条目于 ${existing.delisted.at} 由 @${existing.delisted.by} 申请下架${existing.delisted.note ? `：${existing.delisted.note}` : ''}，确认可以恢复。`);
  if (existing && author && !isMaker(existing, author)) notes.push(`申请人 @${author} 不是原投稿人或仓库所有者。`);

  const errors = validateLaunchSource(next, relPath);
  if (errors.length) return replyOnly('❌ 需要修改 / Changes needed', errors.map((e) => `- ${e}`));
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) {
    return replyOnly('ℹ️ 没有变化 / No changes', [`\`${item.id}\` 已上架的内容与本次投稿一致。`]);
  }
  if (write) writeEntry(file, next);

  const pr = prOutput({
    action, data: next, relPath, issueNumber, author, notes,
    extra: [`- 协议 / 版本 / 平台：${next.license} · ${next.latest_version} · ${next.platforms.join(', ')}`, `- 档位：${sub.launch_tier}`],
  });
  return {
    action, id: item.id, prTitle: pr.title, prBody: pr.body,
    reply: reply('⏳ 已生成 PR，等待维护者合并 / PR opened, waiting for a maintainer', [
      renderReport({ ...verified, item: next }),
      '',
      `合并后可用：\`zstore://launchpad/${item.id}\` · \`zstore://app/${item.id}\``,
    ]),
  };
}

/** 下架 / 重新上架（下架申请表单）。 */
export async function handleDelist({ body, issueNumber = null, author = '', launchesDir, write = false, token, fetchImpl = fetch, nowMs = Date.now() }) {
  const form = parseDelistForm(body);
  const coord = parseRepoUrl(form.repo_url);
  if (!coord) return replyOnly('❌ 无法识别仓库地址 / Unrecognized repository URL', ['请填写投稿时的 https 公开仓库地址后编辑保存。']);
  if (!['delist', 'relist'].includes(form.action)) return replyOnly('❌ 请选择操作 / Pick an action', []);
  if (charCount(form.note) > NOTE_MAX) return replyOnly('❌ 说明过长 / Note too long', [`说明上限 ${NOTE_MAX} 字。`]);

  const id = deriveId(coord);
  const file = launchFilePath(launchesDir, id);
  const relPath = path.relative(launchesDir, file).replace(/\\/g, '/');
  const existing = readSource(file);
  if (!existing) return replyOnly('❌ 开源广场里没有这个作品 / Not on Launchpad', [`未找到 \`${id}\`。`]);

  const notes = [];
  if (author && !isMaker(existing, author)) notes.push(`申请人 @${author} 不是原投稿人或仓库所有者。`);
  let next;

  if (form.action === 'delist') {
    if (isDelisted(existing)) return replyOnly('ℹ️ 已是下架状态 / Already delisted', [`\`${id}\` 当前已下架。`]);
    next = { ...existing, delisted: { at: isoNow(nowMs), by: author || 'maintainer', ...(form.note ? { note: form.note } : {}) } };
    if (next.pin) {
      notes.push(`条目正在置顶（至 ${next.pin.pin_until}），下架会释放坑位。`);
      delete next.pin;
    }
  } else {
    if (!isDelisted(existing)) return replyOnly('ℹ️ 作品在架 / Already listed', [`\`${id}\` 当前在架，无需恢复。`]);
    // 恢复前重新体检：仓库删除、转私有、归档或协议变化都不能直接回来。
    const facts = await fetchRepoFacts(coord, { token, fetchImpl }).catch(() => null);
    const { errors } = evaluateRepo(facts);
    if (errors.length) {
      return replyOnly('❌ 仓库未通过体检 / Repository checks failed', [...errors.map((e) => `- ${e}`), '', '修复后编辑本 Issue 即可重新检查。']);
    }
    next = { ...existing };
    delete next.delisted;
    notes.push(`下架记录：${existing.delisted.at} · @${existing.delisted.by}${existing.delisted.note ? ` · ${existing.delisted.note}` : ''}`);
  }

  if (write) writeEntry(file, next);

  // 仓库所有者自助：直接生效、不建 PR。例外：维护者（或他人）下架的条目，所有者不能自行恢复。
  const selfServe = isRepoOwner(existing, author) && (form.action === 'delist' || isRepoOwner(existing, existing.delisted.by));
  if (selfServe) {
    const verb = form.action === 'delist' ? '下架' : '恢复上架';
    return {
      action: form.action, id,
      commitMsg: `launch: ${form.action} ${next.name} (${id}) by owner @${author}${issueNumber ? ` (#${issueNumber})` : ''}`,
      reply: reply(`✅ 已${verb} / Done`, [
        form.action === 'delist'
          ? `\`${id}\` 已由仓库所有者 @${author} 下架，客户端几分钟内刷新后消失；讨论帖保留。想回来时用同一模板选「恢复」即可。`
          : `\`${id}\` 已由仓库所有者 @${author} 恢复上架，沿用原讨论帖与上架时间，客户端几分钟内可见。`,
        ...(form.action === 'delist' && existing.pin ? ['', `原置顶（至 ${existing.pin.pin_until}）已释放，恢复上架后不会自动还原。`] : []),
      ]),
    };
  }
  if (form.action === 'relist' && isRepoOwner(existing, author)) {
    notes.push(`该条目由 @${existing.delisted.by} 下架，仓库所有者不能自助恢复，需维护者确认。`);
  }

  const pr = prOutput({ action: form.action, data: next, relPath, issueNumber, author, notes, extra: form.note ? [`- 说明：${form.note}`] : [] });
  return {
    action: form.action, id, prTitle: pr.title, prBody: pr.body,
    reply: reply('⏳ 已生成 PR，等待维护者合并 / PR opened, waiting for a maintainer', [
      form.action === 'delist' ? `合并后 \`${id}\` 从开源广场下架，讨论帖保留。` : `合并后 \`${id}\` 恢复上架，沿用原讨论帖与上架时间。`,
    ]),
  };
}

function parseArgs(argv) {
  const args = { dir: path.join(rootDir, 'launches'), repo: process.env.REPO || process.env.GITHUB_REPOSITORY || LAUNCHPAD_REPO };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (!['issue', 'repo', 'bodyFile', 'kind', 'author', 'dir', 'prTitle', 'prBody', 'reply', 'commitMsg'].includes(key) || argv[i + 1] === undefined) {
      throw new Error(`未知参数或缺少取值: ${argv[i]}`);
    }
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let { kind, author = '' } = args;
  let body;
  let issueNumber = null;
  if (args.bodyFile) {
    body = fs.readFileSync(path.resolve(args.bodyFile), 'utf8');
  } else {
    // Issue 正文只经 REST 读取为数据，不经过 shell。
    issueNumber = Number(args.issue);
    const issue = await rest(`/repos/${args.repo}/issues/${issueNumber}`, { token });
    const labels = (issue.labels || []).map((l) => l.name);
    kind = labels.includes(DELIST_LABEL) ? 'delist' : labels.includes(SUBMIT_LABEL) ? 'submit' : '';
    body = issue.body || '';
    author = issue.user?.login || '';
  }
  if (!['submit', 'delist'].includes(kind)) throw new Error('无法判断 Issue 类型（需 launchpad-submission 或 launchpad-delist 标签）');

  const handler = kind === 'delist' ? handleDelist : handleSubmission;
  const out = await handler({ body, issueNumber, author, launchesDir: path.resolve(args.dir), write: Boolean(args.prTitle || args.commitMsg), token });
  if (args.reply) fs.writeFileSync(args.reply, `${out.reply}\n`);
  if (out.prTitle && args.prTitle) fs.writeFileSync(args.prTitle, `${out.prTitle}\n`);
  if (out.prBody && args.prBody) fs.writeFileSync(args.prBody, out.prBody);
  if (out.commitMsg && args.commitMsg) fs.writeFileSync(args.commitMsg, `${out.commitMsg}\n`);
  console.log(out.prTitle ?? out.commitMsg ?? out.reply.split('\n')[0]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
