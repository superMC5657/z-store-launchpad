import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildManifest,
  launchRelPath,
  loadAndValidateSources,
  pruneExpiredPinsInSources,
  validateLaunchSource,
} from './build-launchpad.mjs';
import { dropExpiredPins } from './lib/shared.mjs';
import { discussionTitle } from './lib/discussions.mjs';
import { validateLaunchpad } from './validate-launchpad.mjs';

const NOW = Date.parse('2027-01-15T00:00:00Z');

function sourceItem(overrides = {}) {
  return {
    id: 'acme/hyper-term',
    name: 'HyperTerm',
    owner: 'acme',
    repo: 'hyper-term',
    forge: 'github',
    forge_host: 'github.com',
    icon: 'https://example.com/icon.png',
    icon_bg: '',
    description: 'Fast terminal',
    maker_note: '重写了渲染管线。',
    maker: {
      login: 'acme',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      html_url: 'https://github.com/acme',
    },
    category: 'dev',
    category_name: '开发编程',
    license: 'MIT',
    latest_version: 'v0.4.2',
    platforms: ['windows', 'linux'],
    stars: 42,
    stars_7d_delta: 0,
    forks: 3,
    launched_at: '2027-01-10T00:00:00Z',
    ...overrides,
  };
}

test('launchRelPath 映射 GitHub 与多托管源规范路径', () => {
  assert.equal(launchRelPath('superMC5657/z-viewer').replace(/\\/g, '/'), 'supermc5657/z-viewer.json');
  assert.equal(launchRelPath('codeberg:pix/palette').replace(/\\/g, '/'), 'codeberg/pix/palette.json');
  assert.equal(launchRelPath('gitea:git.example.com/team/app').replace(/\\/g, '/'), 'gitea/git.example.com/team/app.json');
});

test('validateLaunchSource 允许合入前暂缺 discussion_*，但校验文件路径与字段', () => {
  assert.deepEqual(validateLaunchSource(sourceItem(), 'acme/hyper-term.json'), []);
  const badPath = validateLaunchSource(sourceItem(), 'wrong/hyper-term.json');
  assert.ok(badPath.some((e) => e.includes('文件路径应为')));
});

test('buildManifest 编译真源、保留现有热数据、排序 pin 并通过 validateLaunchpad', () => {
  const s1 = sourceItem({
    id: 'a/one',
    owner: 'a',
    repo: 'one',
    launched_at: '2027-01-10T00:00:00Z',
    discussion_repo: 'superMC5657/z-store-launchpad',
    discussion_number: 10,
    discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/10',
    pin: { pin_until: '2027-01-20T00:00:00Z', pin_tier: 'sponsor', pin_order: 2 },
  });
  const s2 = sourceItem({
    id: 'b/two',
    owner: 'b',
    repo: 'two',
    launched_at: '2027-01-12T00:00:00Z',
    discussion_repo: 'superMC5657/z-store-launchpad',
    discussion_number: 11,
    discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/11',
    pin: { pin_until: '2027-01-25T00:00:00Z', pin_tier: 'featured', pin_order: 1 },
  });
  const expired = sourceItem({
    id: 'c/old',
    owner: 'c',
    repo: 'old',
    launched_at: '2027-01-05T00:00:00Z',
    discussion_repo: 'superMC5657/z-store-launchpad',
    discussion_number: 12,
    discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/12',
    pin: { pin_until: '2027-01-14T00:00:00Z', pin_tier: 'sponsor', pin_order: 1 },
  });

  const prevManifest = {
    version: 1,
    generated_at: '2027-01-14T00:00:00Z',
    discussions_repo: 'superMC5657/z-store-launchpad',
    pinned: [],
    items: [
      { ...s1, stars: 999, stars_7d_delta: 55, discussion_upvotes: 12 },
    ],
  };

  const manifest = buildManifest({
    entries: [{ data: s1 }, { data: s2 }, { data: expired }],
    prevManifest,
    nowMs: NOW,
  });

  assert.deepEqual(validateLaunchpad(manifest), []);
  assert.deepEqual(manifest.pinned.map((p) => [p.id, p.pin_order]), [['b/two', 1], ['a/one', 2]]);
  const compiledOne = manifest.items.find((it) => it.id === 'a/one');
  assert.equal(compiledOne.stars, 999);
  assert.equal(compiledOne.stars_7d_delta, 55);
  assert.equal(compiledOne.discussion_upvotes, 12);
  assert.equal('pin' in compiledOne, false);
});

test('loadAndValidateSources 拦截超额有效置顶，pruneExpiredPinsInSources 清理过期 pin', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-build-'));
  try {
    for (let i = 1; i <= 5; i++) {
      const dir = path.join(tmp, 'acme');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `app${i}.json`),
        JSON.stringify(
          sourceItem({
            id: `acme/app${i}`,
            repo: `app${i}`,
            discussion_repo: 'superMC5657/z-store-launchpad',
            discussion_number: i,
            discussion_url: `https://github.com/superMC5657/z-store-launchpad/discussions/${i}`,
            pin: { pin_until: i <= 4 ? '2027-01-20T00:00:00Z' : '2027-01-10T00:00:00Z', pin_tier: 'sponsor', pin_order: i <= 4 ? i : 1 },
          }),
        ),
      );
    }

    // 第 5 条已过期，有效置顶刚好 4 个 → 通过
    assert.deepEqual(loadAndValidateSources(tmp, { nowMs: NOW }).errors, []);

    const pruned = pruneExpiredPinsInSources(tmp, NOW);
    assert.equal(pruned, true);
    const app5 = JSON.parse(fs.readFileSync(path.join(tmp, 'acme', 'app5.json'), 'utf8'));
    assert.equal(app5.pin, undefined);

  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const pin = (id, until, order) => ({ id, pin_until: until, pin_tier: 'sponsor', pin_order: order });

test('dropExpiredPins 撤下到期项并重排顺位', () => {
  const out = dropExpiredPins(
    [pin('a/x', '2027-01-15T00:00:00Z', 1), pin('a/y', '2027-01-20T00:00:00Z', 3), pin('a/z', '2027-01-30T00:00:00Z', 2)],
    NOW,
  );
  assert.deepEqual(out.map((p) => [p.id, p.pin_order]), [['a/z', 1], ['a/y', 2]]);
});

test('讨论标题包含应用名、仓库与自荐语', () => {
  assert.ok(discussionTitle(sourceItem()).startsWith('HyperTerm (acme/hyper-term) — '));
});

const DELISTED = { at: '2027-01-14T00:00:00Z', by: 'acme' };

test('validateLaunchSource 校验 delisted 与 submitted_by 字段', () => {
  assert.deepEqual(validateLaunchSource(sourceItem({ delisted: DELISTED, submitted_by: 'acme' }), 'acme/hyper-term.json'), []);
  const bad = validateLaunchSource(
    sourceItem({ delisted: { at: 'yesterday', by: '', note: '换\n行' }, submitted_by: '' }),
    'acme/hyper-term.json',
  );
  for (const key of ['delisted.at', 'delisted.by', 'delisted.note', 'submitted_by']) {
    assert.ok(bad.some((e) => e.startsWith(key)), `应报告 ${key}`);
  }
  assert.ok(validateLaunchSource(sourceItem({ delisted: [] }), 'acme/hyper-term.json').includes('delisted: 必须是对象'));
});

test('buildManifest 跳过已下架条目：不进 items、不进 pinned，source-only 字段不外泄', () => {
  const listed = sourceItem({
    id: 'a/one', owner: 'a', repo: 'one', submitted_by: 'alice',
    discussion_repo: 'superMC5657/z-store-launchpad', discussion_number: 10,
    discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/10',
  });
  const gone = sourceItem({
    id: 'b/two', owner: 'b', repo: 'two', delisted: DELISTED,
    discussion_repo: 'superMC5657/z-store-launchpad', discussion_number: 11,
    discussion_url: 'https://github.com/superMC5657/z-store-launchpad/discussions/11',
    pin: { pin_until: '2027-01-25T00:00:00Z', pin_tier: 'sponsor', pin_order: 1 },
  });
  const manifest = buildManifest({ entries: [{ data: listed }, { data: gone }], nowMs: NOW });
  assert.deepEqual(validateLaunchpad(manifest), []);
  assert.deepEqual(manifest.items.map((it) => it.id), ['a/one']);
  assert.deepEqual(manifest.pinned, []);
  assert.equal('submitted_by' in manifest.items[0], false);
  assert.equal('delisted' in manifest.items[0], false);
});

test('已下架条目不占置顶坑位', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-delist-'));
  try {
    const dir = path.join(tmp, 'acme');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(
        path.join(dir, `app${i}.json`),
        JSON.stringify(
          sourceItem({
            id: `acme/app${i}`,
            repo: `app${i}`,
            ...(i === 5 ? { delisted: DELISTED } : {}),
            discussion_repo: 'superMC5657/z-store-launchpad',
            discussion_number: i,
            discussion_url: `https://github.com/superMC5657/z-store-launchpad/discussions/${i}`,
            pin: { pin_until: '2027-01-20T00:00:00Z', pin_tier: 'sponsor', pin_order: i <= 4 ? i : 1 },
          }),
        ),
      );
    }
    // 5 个未到期置顶，但第 5 个已下架 → 有效置顶 4 个，通过
    assert.deepEqual(loadAndValidateSources(tmp, { nowMs: NOW }).errors, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
