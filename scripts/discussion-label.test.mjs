import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEntryByDiscussion, handleDiscussionLabel } from './discussion-label.mjs';
import { validateLaunchSource } from './build-launchpad.mjs';
import { formatJson } from './lib/shared.mjs';

const NOW = Date.parse('2027-01-15T00:00:00Z');

const entry = (extra = {}) => ({
  id: 'acme/hyper-term', name: 'HyperTerm', owner: 'acme', repo: 'hyper-term', forge: 'github', forge_host: 'github.com',
  icon: '', icon_bg: '', description: 'GPU terminal', maker_note: '重写了渲染管线。',
  maker: { login: 'acme', avatar_url: 'https://avatars.githubusercontent.com/u/1', html_url: 'https://github.com/acme' },
  category: 'dev', category_name: '开发编程', license: 'MIT', latest_version: 'v0.4.2', platforms: ['windows'],
  launched_at: '2027-01-01T00:00:00Z',
  discussion_repo: 'superMC5657/z-store-launchpad', discussion_number: 3, discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/3',
  ...extra,
});

function fakeFetch({ archived = false } = {}) {
  return async (url) => {
    const json = String(url).includes('/releases/latest')
      ? { tag_name: 'v0.4.2', published_at: '2027-01-09T00:00:00Z', assets: [{ name: 'hyper.msi' }] }
      : { private: false, archived, fork: false, license: { spdx_id: 'MIT' }, owner: {} };
    return { ok: true, status: 200, json: async () => json };
  };
}

const run = (e, hasLabel, opts = {}) =>
  handleDiscussionLabel({ entry: e, hasLabel, actor: 'maint', authorized: true, nowMs: NOW, fetchImpl: fakeFetch(), ...opts });

test('维护者贴标签即下架，并释放置顶', async () => {
  const out = await run(entry({ pin: { pin_until: '2027-02-01T00:00:00Z', pin_tier: 'sponsor', pin_order: 1 } }), true);
  assert.equal(out.action, 'delist');
  assert.deepEqual(out.next.delisted, { at: '2027-01-15T00:00:00Z', by: 'maint' });
  assert.equal(out.next.pin, undefined);
  assert.ok(out.reply.includes('释放坑位'));
  assert.deepEqual(validateLaunchSource(out.next), []);
});

test('维护者摘标签：体检通过即恢复，失败则贴回标签', async () => {
  const down = entry({ delisted: { at: '2027-01-10T00:00:00Z', by: 'maint' } });
  const up = await run(down, false);
  assert.equal(up.action, 'relist');
  assert.equal(up.next.delisted, undefined);
  assert.equal(up.next.launched_at, down.launched_at);

  const blocked = await run(down, false, { fetchImpl: fakeFetch({ archived: true }) });
  assert.equal(blocked.action, 'none');
  assert.equal(blocked.next, undefined);
  assert.equal(blocked.wantLabel, true);
  assert.ok(blocked.reply.includes('已归档'));
});

test('标签与状态一致时不做任何事', async () => {
  assert.deepEqual(await run(entry(), false), { action: 'none' });
  assert.deepEqual(await run(entry({ delisted: { at: '2027-01-10T00:00:00Z', by: 'm' } }), true), { action: 'none' });
});

test('非维护者改标签被还原', async () => {
  const out = await run(entry(), true, { authorized: false, actor: 'rando' });
  assert.equal(out.action, 'none');
  assert.equal(out.next, undefined);
  assert.equal(out.wantLabel, false);
  assert.ok(out.reply.includes('@rando'));
});

test('按讨论帖编号找条目，只认本仓库的帖子', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-dl-'));
  try {
    fs.mkdirSync(path.join(dir, 'acme'));
    fs.writeFileSync(path.join(dir, 'acme', 'hyper-term.json'), formatJson(entry()));
    fs.writeFileSync(path.join(dir, 'acme', 'other.json'), formatJson(entry({ id: 'acme/other', repo: 'other', discussion_repo: 'acme/other', discussion_number: 9 })));
    assert.equal(findEntryByDiscussion(dir, 3, 'supermc5657/Z-Store-Launchpad')?.data.id, 'acme/hyper-term');
    assert.equal(findEntryByDiscussion(dir, 9), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
