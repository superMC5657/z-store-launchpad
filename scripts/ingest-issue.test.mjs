import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestSubmission, resolvePinSpec } from './ingest-issue.mjs';

const NOW = Date.parse('2027-01-15T00:00:00Z');

function mockBody(overrides = {}) {
  const fields = {
    repo: 'https://github.com/superMC5657/z-viewer',
    name: 'ZViewer',
    category: 'graphics — 图形创作 / Graphics',
    note: '轻量看图软件。',
    noteEn: 'Lightweight image viewer.',
    tier: 'free — 免费加入「最新上架」新品池 / Free listing in Recent Launches',
    orderRef: '_No response_',
    icon: 'https://raw.githubusercontent.com/superMC5657/z-viewer/main/src-tauri/icons/icon.png',
    homepage: '_No response_',
    discussion: '_No response_',
    ...overrides,
  };
  return [
    '### 开源仓库地址 / Repository URL', '', fields.repo, '',
    '### 应用名称 / App name', '', fields.name, '',
    '### 功能分类 / Category', '', fields.category, '',
    '### 一句话自荐 / Maker note', '', fields.note, '',
    '### 英文自荐语 / Maker note (English)', '', fields.noteEn, '',
    '### 上架档位 / Launch tier', '', fields.tier, '',
    '### 赞助凭证尾号 / Sponsor order reference', '', fields.orderRef, '',
    '### 自定义图标 / Custom icon URL', '', fields.icon, '',
    '### 项目主页 / Homepage', '', fields.homepage, '',
    '### 关联 Discussion / Linked discussion URL', '', fields.discussion, '',
    '### 开源承诺 / FLOSS confirmation', '', '- [x] 项目采用 OSI 认证开源协议',
  ].join('\n');
}

function mockFetch({ releaseTag = 'v0.3.2', assets = ['ZViewer_0.3.2_x64-setup.exe'] } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith('/repos/superMC5657/z-viewer')) {
      return new Response(
        JSON.stringify({
          private: false,
          archived: false,
          fork: false,
          license: { spdx_id: 'MIT' },
          stargazers_count: 88,
          forks_count: 5,
          description: 'Fast viewer',
          homepage: '',
          owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', html_url: 'https://github.com/superMC5657' },
        }),
        { status: 200 },
      );
    }
    if (u.endsWith('/repos/superMC5657/z-viewer/releases/latest')) {
      if (!releaseTag) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({
          tag_name: releaseTag,
          published_at: '2027-01-10T00:00:00Z',
          assets: assets.map((name) => ({ name })),
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  };
}

test('resolvePinSpec 优先读取维护者置顶标签，其次读取表单档位', () => {
  assert.deepEqual(resolvePinSpec('free', ['pinned-14d']), { tier: 'sponsor', days: 14 });
  assert.deepEqual(resolvePinSpec('spotlight-7d', []), { tier: 'sponsor', days: 7 });
  assert.equal(resolvePinSpec('free', ['approved']), null);
});

test('ingestSubmission 写入 launches/ 真源并生成 PR 标题与正文', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ingest-'));
  try {
    const out = await ingestSubmission({
      body: mockBody(),
      issueNumber: 7,
      author: 'superMC5657',
      authorAssociation: 'OWNER',
      labels: ['launchpad-submission'],
      launchesDir: tmp,
      write: true,
      fetchImpl: mockFetch(),
      nowMs: NOW,
    });

    assert.equal(out.ok, true);
    assert.equal(out.result.action, 'add');
    assert.equal(out.result.needsReview, false);
    assert.equal(out.prTitle, 'launch: add ZViewer (supermc5657/z-viewer)');
    assert.ok(out.prBody.includes('Closes #7'));

    const written = JSON.parse(fs.readFileSync(path.join(tmp, 'supermc5657', 'z-viewer.json'), 'utf8'));
    assert.equal(written.id, 'supermc5657/z-viewer');
    assert.equal(written.source_issue, 7);
    assert.equal(written.discussion_number, undefined);

    // 重复提交未带 update 标签时返回 duplicate
    const dup = await ingestSubmission({
      body: mockBody(),
      issueNumber: 8,
      launchesDir: tmp,
      write: false,
      fetchImpl: mockFetch(),
      nowMs: NOW,
    });
    assert.equal(dup.ok, true);
    assert.equal(dup.result.action, 'duplicate');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('申请置顶推荐未贴置顶标签时标为 needsReview', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-spot-'));
  try {
    const out = await ingestSubmission({
      body: mockBody({ tier: 'spotlight-7d — 申请顶部「置顶推荐」7 天赞助位' }),
      issueNumber: 9,
      launchesDir: tmp,
      write: true,
      fetchImpl: mockFetch(),
      nowMs: NOW,
    });
    assert.equal(out.ok, true);
    assert.equal(out.result.needsReview, true);
    const written = JSON.parse(fs.readFileSync(path.join(tmp, 'supermc5657', 'z-viewer.json'), 'utf8'));
    assert.equal(written.pin.pin_tier, 'sponsor');
    assert.equal(written.pin.pin_until, '2027-01-22T00:00:00Z');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
