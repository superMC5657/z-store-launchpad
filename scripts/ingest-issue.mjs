#!/usr/bin/env node
/**
 * ingest-issue.mjs
 *
 * 解析 Launchpad 投稿 Issue → 体检校验 → 写入 `launches/<...>.json` → 生成 PR 标题/正文与评论，
 * 供 `issue-to-pr.yml` 创建/更新 PR 并在 `main` 合入后由 `build-launchpad.yml` 绑定 Discussion 与编译 `launchpad.json`。
 *
 * 用法：
 *   node scripts/ingest-issue.mjs --issue 1 --repo superMC5657/z-store-launchpad --write --out result.json
 *   node scripts/ingest-issue.mjs --body-file issue.md --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHPAD_REPO,
  SPOTLIGHT_MAX_SLOTS,
  addDaysIso,
  formatJson,
  isIsoUtc,
} from './lib/shared.mjs';
import { rest } from './lib/github.mjs';
import { labelToPin, resolveDiscussion } from './publish-launch.mjs';
import { parseLinkedDiscussion, renderReport, verifySubmission } from './verify-submission.mjs';
import { launchFilePath, loadAndValidateSources, validateLaunchSource } from './build-launchpad.mjs';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');

export function parseArgs(argv) {
  const args = {
    dir: path.join(rootDir, 'launches'),
    manifest: path.join(rootDir, 'launchpad.json'),
    write: false,
    update: false,
    issue: '',
    repo: '',
    bodyFile: '',
    author: '',
    authorAssociation: '',
    out: '',
    prTitle: '',
    prBody: '',
    comment: '',
    failureComment: '',
    pinLabel: '',
  };
  const valueFlags = new Set([
    '--issue', '--repo', '--body-file', '--author', '--author-association',
    '--out', '--pr-title', '--pr-body', '--comment', '--failure-comment',
    '--dir', '--manifest', '--pin-label',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (valueFlags.has(flag)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
      const key = flag.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      args[key] = value;
    } else if (flag === '--write') args.write = true;
    else if (flag === '--dry-run') args.write = false;
    else if (flag === '--update') args.update = true;
    else throw new Error(`未知参数: ${flag}`);
  }
  if (!args.bodyFile && !args.issue) throw new Error('必须提供 --issue 或 --body-file');
  if (!args.repo) args.repo = process.env.REPO || process.env.GITHUB_REPOSITORY || LAUNCHPAD_REPO;
  if (args.dir) args.dir = path.resolve(args.dir);
  if (args.manifest) args.manifest = path.resolve(args.manifest);
  return args;
}

function writeOpt(file, content) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), content);
}

/** 根据 Issue 标签或提交表单档位解析置顶配置（标签优先）。 */
export function resolvePinSpec(launchTier, labels = []) {
  for (const l of labels) {
    const p = labelToPin(l);
    if (p) return p;
  }
  if (typeof launchTier === 'string') {
    const m = /^spotlight-(\d+)d$/i.exec(launchTier.trim());
    if (m) return { tier: 'sponsor', days: Number(m[1]) };
  }
  return null;
}

export async function ingestSubmission({
  body,
  issueNumber = null,
  author = '',
  authorAssociation = '',
  labels = [],
  launchesDir,
  manifestPath = null,
  update = false,
  write = false,
  token,
  fetchImpl = fetch,
  nowMs = Date.now(),
}) {
  const verified = await verifySubmission(body, { token, fetchImpl, nowMs });
  if (!verified.ok || !verified.item) {
    const failureMarkdown = renderReport(verified);
    return {
      ok: false,
      exitCode: 1,
      result: {
        action: 'error',
        ids: verified.item ? [verified.item.id] : [],
        needsReview: true,
        reputationOk: false,
        authorAssociation,
        errors: verified.errors,
      },
      failureMarkdown,
    };
  }

  const item = verified.item;
  const sub = verified.submission;
  const targetFile = launchFilePath(launchesDir, item.id);
  const existingSource = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, 'utf8')) : null;
  const prevManifest = manifestPath && fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;
  const existingManifestItem = prevManifest?.items?.find((it) => it.id === item.id) ?? null;
  const existing = existingSource || existingManifestItem;

  const hasUpdateTrigger = update || labels.some((l) => l === 'update' || labelToPin(l) !== null);
  if (existing && !hasUpdateTrigger) {
    const commentMarkdown = [
      '### ℹ️ 作品已在开源广场清单中',
      '',
      `\`${item.id}\` 已存在于当前清单（真源 \`launches/${path.relative(launchesDir, targetFile).replace(/\\/g, '/')}\`）。`,
      '如需更新自荐语、图标、版本或申请续期置顶，请为本 Issue 贴上 `update` 标签后重新触发。',
    ].join('\n');
    return {
      ok: true,
      exitCode: 0,
      result: {
        action: 'duplicate',
        ids: [item.id],
        needsReview: false,
        reputationOk: false,
        authorAssociation,
      },
      commentMarkdown,
    };
  }

  const pinSpec = resolvePinSpec(sub.launch_tier, labels);
  const { entries: allSources } = loadAndValidateSources(launchesDir, { nowMs });
  const activeOtherPins = allSources
    .filter(({ data }) => data.id !== item.id && data.pin && isIsoUtc(data.pin.pin_until) && Date.parse(data.pin.pin_until) > nowMs)
    .map(({ data }) => ({ id: data.id, ...data.pin }));

  if (pinSpec && activeOtherPins.length >= SPOTLIGHT_MAX_SLOTS) {
    const earliestRelease = activeOtherPins.map((p) => p.pin_until).sort()[0];
    const failureMarkdown = [
      '### ⏳ 置顶坑位已满 / Spotlight slots full',
      '',
      `当前 4 个置顶坑位均未到期，最早释放时间为 **${earliestRelease}**。`,
      '可待坑位释放后重试，或修改投稿档位为 `free` 先进入「最新上架」新品池。',
    ].join('\n');
    return {
      ok: false,
      exitCode: 1,
      result: {
        action: 'slots_full',
        ids: [item.id],
        needsReview: true,
        reputationOk: false,
        authorAssociation,
        earliestRelease,
        errors: [`置顶坑位已满（最早释放 ${earliestRelease}）`],
      },
      failureMarkdown,
    };
  }

  const nextSource = {
    ...(existingSource ?? {}),
    ...item,
    launched_at: existing?.launched_at || item.launched_at,
    stars_7d_delta: existing?.stars_7d_delta ?? item.stars_7d_delta ?? 0,
    discussion_comments_count: existing?.discussion_comments_count ?? 0,
    discussion_upvotes: existing?.discussion_upvotes ?? 0,
  };
  if (existing?.discussion_repo && existing?.discussion_number && existing?.discussion_url) {
    nextSource.discussion_repo = existing.discussion_repo;
    nextSource.discussion_number = existing.discussion_number;
    nextSource.discussion_url = existing.discussion_url;
    if (existing.discussion_node_id) nextSource.discussion_node_id = existing.discussion_node_id;
  }

  // 若作者填了自有仓库 Discussion，仅做只读校验并绑定；否则留待合入 main 后再创建，避免垃圾 Issue 污染讨论区。
  const linked = parseLinkedDiscussion(sub.linked_discussion_url);
  if (linked && token) {
    const d = await resolveDiscussion({
      item: nextSource,
      submission: sub,
      existing: existingSource,
      token,
      fetchImpl,
    });
    Object.assign(nextSource, d);
  }

  if (pinSpec) {
    const existingOrder = existingSource?.pin?.pin_order;
    nextSource.pin = {
      pin_until: addDaysIso(nowMs, pinSpec.days),
      pin_tier: pinSpec.tier,
      ...(existingOrder ? { pin_order: existingOrder } : { pin_order: activeOtherPins.length + 1 }),
    };
  }

  if (Number.isInteger(issueNumber) && issueNumber > 0) {
    nextSource.source_issue = issueNumber;
  }

  const relPath = path.relative(launchesDir, targetFile).replace(/\\/g, '/');
  const sourceErrors = validateLaunchSource(nextSource, relPath);
  if (sourceErrors.length) {
    const failureMarkdown = ['### ❌ 组装真源条目失败', '', ...sourceErrors.map((e) => `- ${e}`)].join('\n');
    return {
      ok: false,
      exitCode: 1,
      result: {
        action: 'error',
        ids: [item.id],
        needsReview: true,
        reputationOk: false,
        authorAssociation,
        errors: sourceErrors,
      },
      failureMarkdown,
    };
  }

  if (write) {
    if (existingSource && JSON.stringify(existingSource) === JSON.stringify(nextSource)) {
      return {
        ok: true,
        exitCode: 0,
        result: {
          action: 'noop',
          ids: [item.id],
          needsReview: false,
          reputationOk: false,
          authorAssociation,
        },
        commentMarkdown: `### ℹ️ \`${item.id}\` 字段无变化，跳过 PR 创建。`,
      };
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, formatJson(nextSource));
  }

  const reviewReasons = [];
  const hasExplicitPinLabel = labels.some((l) => labelToPin(l) !== null);
  if (sub.launch_tier !== 'free' && !hasExplicitPinLabel) {
    reviewReasons.push(`申请置顶档位（${sub.launch_tier}），需维护者核对赞助凭证并贴对应置顶标签后合并`);
  }
  const needsReview = reviewReasons.length > 0;
  const trustedAssoc = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation);
  const reputationOk = trustedAssoc || item.stars >= 50;

  const action = existing ? 'update' : 'add';
  const prTitle = `launch: ${action} ${item.name} (${item.id})`;
  const prBodyLines = [
    `## ${action === 'add' ? '🚀 新增开源广场作品' : '🔄 更新开源广场作品'}`,
    '',
    `- **应用**: ${item.name} (\`${item.id}\`)`,
    `- **协议**: ${item.license}`,
    `- **版本**: ${item.latest_version}`,
    `- **平台**: ${item.platforms.join(', ')}`,
    `- **档位**: ${pinSpec ? `${pinSpec.tier} (${sub.launch_tier})` : 'free'}`,
    `- **真源路径**: \`launches/${relPath}\``,
    ...(author ? [`- **提交人**: @${author}`] : []),
    '',
    `> ${item.maker_note}`,
    '',
    ...(reviewReasons.length ? ['### 待人工核对', ...reviewReasons.map((r) => `- ${r}`), ''] : []),
    ...(Number.isInteger(issueNumber) && issueNumber > 0 ? [`Closes #${issueNumber}`, ''] : []),
    '合入 `main` 后将自动创建（或绑定）`Launches` Discussion、编译根目录 `launchpad.json` 并回复作者传播物料包。',
  ];

  return {
    ok: true,
    exitCode: 0,
    result: {
      action,
      ids: [item.id],
      needsReview,
      reviewReasons,
      reputationOk,
      authorAssociation,
      launchFile: `launches/${relPath}`,
      prTitle,
    },
    prTitle,
    prBody: `${prBodyLines.join('\n')}\n`,
    commentMarkdown: renderReport({ ...verified, item: nextSource }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let body = '';
  let author = args.author;
  let authorAssociation = args.authorAssociation;
  let labels = args.pinLabel ? [args.pinLabel] : [];
  let issueNumber = null;

  if (args.bodyFile) {
    body = fs.readFileSync(path.resolve(args.bodyFile), 'utf8');
  } else {
    issueNumber = Number(args.issue);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`--issue 必须是正整数: ${args.issue}`);
    }
    const issue = await rest(`/repos/${args.repo}/issues/${issueNumber}`, { token });
    body = issue.body || '';
    author = author || issue.user?.login || '';
    authorAssociation = authorAssociation || issue.author_association || '';
    labels = [...new Set([...labels, ...(issue.labels || []).map((l) => l.name)])];
  }

  const out = await ingestSubmission({
    body,
    issueNumber,
    author,
    authorAssociation,
    labels,
    launchesDir: args.dir,
    manifestPath: args.manifest,
    update: args.update,
    write: args.write,
    token,
  });

  writeOpt(args.out, formatJson(out.result));
  if (out.prTitle) writeOpt(args.prTitle, `${out.prTitle}\n`);
  if (out.prBody) writeOpt(args.prBody, out.prBody);
  if (out.commentMarkdown) writeOpt(args.comment, out.commentMarkdown);
  if (out.failureMarkdown) writeOpt(args.failureComment, out.failureMarkdown);
  process.exit(out.exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
