import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DELIST_FORM_HEADINGS, handleDelist, handleSubmission, pinDays } from './issue-to-pr.mjs';
import { FORM_HEADINGS } from './verify-submission.mjs';
import { buildManifest, loadAndValidateSources } from './build-launchpad.mjs';
import { validateLaunchpad } from './validate-launchpad.mjs';

const NOW = Date.parse('2027-01-15T00:00:00Z');
const FILE = ['acme', 'hyper-term.json'];

function form(headings, values) {
  return Object.entries(headings)
    .map(([id, heading]) => `### ${heading}\n\n${values[id] ?? '_No response_'}\n`)
    .join('\n');
}

const submitBody = (overrides = {}) =>
  form(FORM_HEADINGS, {
    repo_url: 'https://github.com/acme/hyper-term',
    app_name: 'HyperTerm',
    category: 'dev — 开发编程 / Developer tools',
    maker_note: '重写了渲染管线。',
    launch_tier: 'free — 免费加入「最新上架」新品池 / Free listing in Recent Launches',
    floss_confirm: '- [X] 项目采用 OSI 认证开源协议',
    ...overrides,
  });

const delistBody = (action, note = '') =>
  form(DELIST_FORM_HEADINGS, {
    repo_url: 'https://github.com/acme/hyper-term',
    action: action === 'delist' ? 'delist — 下架 / Delist' : 'relist — 恢复上架 / Relist',
    note: note || '_No response_',
  });

function fakeFetch({ archived = false, stars = 42 } = {}) {
  return async (url) => {
    const json = String(url).includes('/releases/latest')
      ? { tag_name: 'v0.4.2', published_at: '2027-01-09T00:00:00Z', assets: [{ name: 'hyper.msi' }] }
      : {
          private: false, archived, fork: false, license: { spdx_id: 'MIT' }, stargazers_count: stars, forks_count: 1,
          description: 'GPU terminal', owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1', html_url: 'https://github.com/acme' },
        };
    return { ok: true, status: 200, json: async () => json };
  };
}

function withDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-i2p-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ...FILE), 'utf8'));
const run = (handler, dir, body, extra = {}) =>
  handler({ body, issueNumber: 7, author: 'acme', launchesDir: dir, write: true, fetchImpl: fakeFetch(), nowMs: NOW, ...extra });

test('pinDays 只识别 spotlight-Nd', () => {
  assert.equal(pinDays('spotlight-14d'), 14);
  assert.equal(pinDays('free'), 0);
});

test('新投稿写入真源并生成带 Closes 的 PR，不合并', withDir(async (dir) => {
  const out = await run(handleSubmission, dir, submitBody());
  assert.equal(out.action, 'add');
  assert.equal(out.prTitle, 'launch: add HyperTerm (acme/hyper-term)');
  assert.ok(out.prBody.includes('Closes #7'));
  assert.ok(out.reply.includes('等待维护者合并'));
  const src = read(dir);
  assert.equal(src.submitted_by, 'acme');
  assert.equal(src.launched_at, '2027-01-15T00:00:00Z');
}));

test('体检失败只回复，不写真源、不生成 PR', withDir(async (dir) => {
  const out = await run(handleSubmission, dir, submitBody(), { fetchImpl: fakeFetch({ archived: true }) });
  assert.equal(out.prTitle, undefined);
  assert.ok(out.reply.includes('归档'));
  assert.equal(fs.existsSync(path.join(dir, ...FILE)), false);
}));

test('重复投稿：无变化不建 PR；星数变化不算变化；改自荐语为 update 并保留讨论帖与上架时间', withDir(async (dir) => {
  await run(handleSubmission, dir, submitBody());
  const bound = { ...read(dir), discussion_repo: 'o/r', discussion_number: 3, discussion_url: 'https://github.com/o/r/discussions/3' };
  fs.writeFileSync(path.join(dir, ...FILE), JSON.stringify(bound));

  const same = await run(handleSubmission, dir, submitBody(), { fetchImpl: fakeFetch({ stars: 999 }), nowMs: NOW + 86_400_000 });
  assert.equal(same.prTitle, undefined);
  assert.ok(same.reply.includes('没有变化'));

  const upd = await run(handleSubmission, dir, submitBody({ maker_note: '新自荐。' }), { author: 'mallory', nowMs: NOW + 86_400_000 });
  assert.equal(upd.action, 'update');
  assert.ok(upd.prBody.includes('不是原投稿人'), '非作者的更新在 PR 里提示维护者');
  const src = read(dir);
  assert.equal(src.maker_note, '新自荐。');
  assert.equal(src.discussion_number, 3);
  assert.equal(src.launched_at, '2027-01-15T00:00:00Z');
  assert.equal(src.submitted_by, 'acme');
}));

test('置顶档写入 pin 并提示核对赞助；坑位满时只回复', withDir(async (dir) => {
  const out = await run(handleSubmission, dir, submitBody({ launch_tier: 'spotlight-7d — x' }));
  assert.deepEqual(read(dir).pin, { pin_until: '2027-01-22T00:00:00Z', pin_tier: 'sponsor', pin_order: 1 });
  assert.ok(out.prBody.includes('赞助凭证'));

  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(path.join(dir, 'acme', `app${i}.json`), JSON.stringify({ ...read(dir), id: `acme/app${i}`, repo: `app${i}`, pin: { pin_until: '2027-02-01T00:00:00Z', pin_tier: 'sponsor', pin_order: i } }));
  }
  fs.rmSync(path.join(dir, ...FILE));
  const full = await run(handleSubmission, dir, submitBody({ launch_tier: 'spotlight-7d — x' }));
  assert.equal(full.prTitle, undefined);
  assert.ok(full.reply.includes('坑位已满'));
}));

test('下架 → 编译后消失并释放置顶；恢复须体检通过，沿用原数据', withDir(async (dir) => {
  await run(handleSubmission, dir, submitBody({ launch_tier: 'spotlight-7d — x' }));
  const before = read(dir);

  const down = await run(handleDelist, dir, delistBody('delist', '暂停维护'));
  assert.equal(down.prTitle, 'launch: delist HyperTerm (acme/hyper-term)');
  assert.ok(down.prBody.includes('Closes #7') && down.prBody.includes('释放坑位'));
  const delisted = read(dir);
  assert.deepEqual(delisted.delisted, { at: '2027-01-15T00:00:00Z', by: 'acme', note: '暂停维护' });
  assert.equal(delisted.pin, undefined);
  const { entries, errors } = loadAndValidateSources(dir, { nowMs: NOW });
  assert.deepEqual(errors, []);
  const manifest = buildManifest({ entries, nowMs: NOW, allowPlaceholderDiscussion: true });
  assert.deepEqual(manifest.items, []);
  assert.deepEqual(validateLaunchpad(manifest), []);

  assert.ok((await run(handleDelist, dir, delistBody('delist'))).reply.includes('已是下架状态'));

  const blocked = await run(handleDelist, dir, delistBody('relist'), { fetchImpl: fakeFetch({ archived: true }) });
  assert.equal(blocked.prTitle, undefined);
  assert.ok(read(dir).delisted, '体检失败不改真源');

  const up = await run(handleDelist, dir, delistBody('relist'));
  assert.equal(up.action, 'relist');
  assert.ok(up.prBody.includes('下架记录'));
  const relisted = read(dir);
  assert.equal(relisted.delisted, undefined);
  assert.equal(relisted.launched_at, before.launched_at);
}));

test('已下架条目再投稿即重新上架', withDir(async (dir) => {
  await run(handleSubmission, dir, submitBody());
  await run(handleDelist, dir, delistBody('delist'));
  const out = await run(handleSubmission, dir, submitBody({ maker_note: '回来了。' }));
  assert.equal(out.action, 'relist');
  assert.equal(read(dir).delisted, undefined);
  assert.equal(read(dir).maker_note, '回来了。');
}));

test('下架申请：条目不存在、仓库地址无效只回复', withDir(async (dir) => {
  assert.ok((await run(handleDelist, dir, delistBody('delist'))).reply.includes('没有这个作品'));
  const bad = form(DELIST_FORM_HEADINGS, { repo_url: 'http://nope', action: 'delist — x' });
  assert.ok((await run(handleDelist, dir, bad)).reply.includes('无法识别'));
}));
