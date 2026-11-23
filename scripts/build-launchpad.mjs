#!/usr/bin/env node
/**
 * build-launchpad.mjs
 *
 * 将 `launches/<...>.json`（单应用真源）增量编译为根目录 `launchpad.json`。
 * - PR 阶段允许条目尚未绑定 Discussion（合入 main 后由 `--bind-discussions` 创建并回写）；
 * - 编译时保留既有 `launchpad.json` 的动态计数（stars / forks / latest_version / 讨论互动数）；
 * - 置顶信息写在条目 `pin` 字段内，编译时自动剔除过期置顶、重排 `pin_order` 并校验坑位上限（≤ 4）；
 * - 带 `delisted` 字段的条目已下架：文件保留在规范路径，但不进入 `items` / `pinned`，也不占置顶坑位。
 *
 * 用法：
 *   node scripts/build-launchpad.mjs                      # 编译 launches/ -> launchpad.json
 *   node scripts/build-launchpad.mjs --check-sources      # 仅校验 launches/ 全部真源与坑位上限
 *   node scripts/build-launchpad.mjs --bind-discussions   # 为缺讨论绑定条目在 Launches 创建 Discussion
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORY_KEYS,
  FORGE_HOSTS,
  LAUNCHPAD_REPO,
  MAKER_NOTE_MAX,
  MANIFEST_VERSION,
  PIN_TIERS,
  PLATFORMS,
  SPOTLIGHT_MAX_SLOTS,
  charCount,
  deriveId,
  formatJson,
  isDelisted,
  isIsoUtc,
  isOsiLicense,
  isoNow,
  sortItems,
} from './lib/shared.mjs';
import { resolveDiscussion } from './lib/discussions.mjs';
import { validateLaunchpad } from './validate-launchpad.mjs';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');

const DYNAMIC_KEYS = [
  'stars',
  'stars_7d_delta',
  'forks',
  'latest_version',
  'latest_release_at',
  'discussion_comments_count',
  'discussion_upvotes',
];

const DISCUSSION_KEYS = ['discussion_repo', 'discussion_number', 'discussion_node_id', 'discussion_url'];

const SOURCE_ONLY_KEYS = new Set(['pin', 'submitted_by', 'delisted']);

/** 规范应用标识 → `launches/` 下相对路径（如 `supermc5657/z-viewer.json` 或 `codeberg/pix/palette.json`）。 */
export function launchRelPath(id) {
  const s = String(id || '').trim().toLowerCase();
  if (!s) throw new Error(`非法应用标识: ${id}`);
  if (!s.includes(':')) {
    const parts = s.split('/');
    if (parts.length !== 2) throw new Error(`非法 GitHub 应用标识: ${id}`);
    return path.join(parts[0], `${parts[1]}.json`);
  }
  const colon = s.indexOf(':');
  const forge = s.slice(0, colon);
  const restParts = s.slice(colon + 1).split('/');
  if (restParts.length !== 2 && restParts.length !== 3) throw new Error(`非法多托管源标识: ${id}`);
  const file = `${restParts[restParts.length - 1]}.json`;
  return path.join(forge, ...restParts.slice(0, -1), file);
}

export function launchFilePath(launchesDir, id) {
  return path.join(launchesDir, launchRelPath(id));
}

/** 递归收集 `launches/` 下所有 `.json` 文件（按相对路径字典序）。 */
export function collectLaunchFiles(launchesDir) {
  if (!fs.existsSync(launchesDir)) return [];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.json')) out.push(full);
    }
  };
  walk(launchesDir);
  return out.sort((a, b) => a.localeCompare(b));
}

/** 校验单个 `launches/<...>.json` 真源条目（允许合入前暂缺 discussion_* 字段）。 */
export function validateLaunchSource(entry, expectedRelPath = null) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['真源条目必须是 JSON 对象'];
  }
  const reqStr = [
    'id', 'name', 'owner', 'repo', 'forge', 'forge_host', 'icon', 'icon_bg',
    'description', 'maker_note', 'category', 'category_name', 'license',
    'latest_version', 'launched_at',
  ];
  for (const k of reqStr) {
    if (typeof entry[k] !== 'string') errors.push(`${k}: 必填字符串`);
  }
  for (const k of ['name', 'owner', 'repo', 'description', 'latest_version']) {
    if (typeof entry[k] === 'string' && !entry[k].trim()) errors.push(`${k}: 不能为空`);
  }
  if (!(entry.forge in FORGE_HOSTS)) errors.push(`forge: 仅支持 ${Object.keys(FORGE_HOSTS).join(' / ')}`);
  if (typeof entry.id === 'string') {
    if (entry.id !== entry.id.toLowerCase()) errors.push('id: 必须小写');
    const derived = deriveId(entry);
    if (entry.id !== derived) errors.push(`id: 应为 ${derived}`);
    if (expectedRelPath) {
      const want = launchRelPath(entry.id).replace(/\\/g, '/');
      const got = expectedRelPath.replace(/\\/g, '/');
      if (want !== got) errors.push(`文件路径应为 launches/${want}（当前 launches/${got}）`);
    }
  }
  if (typeof entry.icon === 'string' && entry.icon !== '' && !/^https:\/\/\S+$/.test(entry.icon)) {
    errors.push('icon: 仅允许空串或 https:// 直链');
  }
  if (typeof entry.maker_note === 'string') {
    const n = charCount(entry.maker_note);
    if (n < 1 || n > MAKER_NOTE_MAX) errors.push(`maker_note: 长度须为 1..=${MAKER_NOTE_MAX}（当前 ${n}）`);
    if (/[\r\n\u0000-\u001f]/.test(entry.maker_note)) errors.push('maker_note: 不得含换行或控制字符');
  }
  if (!entry.maker || typeof entry.maker !== 'object') {
    errors.push('maker: 必填对象');
  } else {
    for (const k of ['login', 'avatar_url', 'html_url']) {
      if (typeof entry.maker[k] !== 'string' || !entry.maker[k].trim()) errors.push(`maker.${k}: 必填字符串`);
    }
    if (typeof entry.maker.avatar_url === 'string' && !/^https:\/\//.test(entry.maker.avatar_url)) {
      errors.push('maker.avatar_url: 仅允许 https://');
    }
  }
  if (!CATEGORY_KEYS.includes(entry.category)) errors.push(`category: 非标准分类 ${entry.category}`);
  if (!isOsiLicense(entry.license)) errors.push(`license: ${entry.license} 不在 OSI 白名单`);
  if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
    errors.push('platforms: 必须是非空数组');
  } else {
    for (const p of entry.platforms) {
      if (!PLATFORMS.includes(p)) errors.push(`platforms: 未知平台 ${p}`);
    }
  }
  for (const k of ['launched_at', 'latest_release_at']) {
    if (k in entry && !isIsoUtc(entry[k])) errors.push(`${k}: 非法 ISO-8601 时间`);
  }
  if (entry.pin !== undefined && entry.pin !== null) {
    if (typeof entry.pin !== 'object' || Array.isArray(entry.pin)) errors.push('pin: 必须是对象');
    else {
      if (!isIsoUtc(entry.pin.pin_until)) errors.push('pin.pin_until: 非法 ISO-8601 时间');
      if (!PIN_TIERS.includes(entry.pin.pin_tier)) errors.push(`pin.pin_tier: 仅支持 ${PIN_TIERS.join(' / ')}`);
      if (
        entry.pin.pin_order !== undefined &&
        !(Number.isInteger(entry.pin.pin_order) && entry.pin.pin_order >= 1 && entry.pin.pin_order <= SPOTLIGHT_MAX_SLOTS)
      ) {
        errors.push(`pin.pin_order: 必须是 1..=${SPOTLIGHT_MAX_SLOTS} 的整数`);
      }
    }
  }
  if (entry.submitted_by !== undefined && (typeof entry.submitted_by !== 'string' || !entry.submitted_by.trim())) {
    errors.push('submitted_by: 必须是非空字符串');
  }
  if (entry.delisted !== undefined) errors.push(...validateDelisted(entry.delisted));
  return errors;
}

function validateDelisted(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['delisted: 必须是对象'];
  const errors = [];
  if (!isIsoUtc(d.at)) errors.push('delisted.at: 非法 ISO-8601 时间');
  if (typeof d.by !== 'string' || !d.by.trim()) errors.push('delisted.by: 必填字符串');
  if (d.note !== undefined) {
    if (typeof d.note !== 'string') errors.push('delisted.note: 必须是字符串');
    else if (charCount(d.note) > MAKER_NOTE_MAX * 2 || /[\r\n\u0000-\u001f]/.test(d.note)) {
      errors.push(`delisted.note: 单行且不超过 ${MAKER_NOTE_MAX * 2} 字`);
    }
  }
  return errors;
}

/** 读取并校验 `launches/` 全部条目；返回 `{ entries, errors }`。 */
export function loadAndValidateSources(launchesDir, { nowMs = Date.now() } = {}) {
  const files = collectLaunchFiles(launchesDir);
  const entries = [];
  const errors = [];
  const seenIds = new Set();
  let activePins = 0;

  for (const file of files) {
    const rel = path.relative(launchesDir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`launches/${rel}: 无法解析 JSON (${e.message})`);
      continue;
    }
    const itemErrors = validateLaunchSource(parsed, rel);
    for (const err of itemErrors) errors.push(`launches/${rel}: ${err}`);
    if (parsed?.id) {
      if (seenIds.has(parsed.id)) errors.push(`launches/${rel}: 重复 id ${parsed.id}`);
      seenIds.add(parsed.id);
    }
    if (!isDelisted(parsed) && parsed?.pin && isIsoUtc(parsed.pin.pin_until) && Date.parse(parsed.pin.pin_until) > nowMs) {
      activePins += 1;
    }
    entries.push({ file, rel, data: parsed });
  }

  if (activePins > SPOTLIGHT_MAX_SLOTS) {
    errors.push(`有效置顶数量超过上限 ${SPOTLIGHT_MAX_SLOTS}（当前 ${activePins}）`);
  }
  return { entries, errors };
}

/** 将单条真源与现有产物条目合并成 `launchpad.json` 条目。 */
export function compileItem(sourceEntry, prevItem, { allowPlaceholderDiscussion = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(sourceEntry)) {
    if (SOURCE_ONLY_KEYS.has(k)) continue;
    out[k] = v;
  }
  for (const k of DYNAMIC_KEYS) {
    if (k === 'latest_version' || k === 'latest_release_at') {
      const srcAt = sourceEntry.latest_release_at ? Date.parse(sourceEntry.latest_release_at) : 0;
      const prevAt = prevItem?.latest_release_at ? Date.parse(prevItem.latest_release_at) : 0;
      if (srcAt > prevAt && sourceEntry[k] !== undefined && sourceEntry[k] !== '') {
        out[k] = sourceEntry[k];
      } else if (prevItem && prevItem[k] !== undefined && prevItem[k] !== null && prevItem[k] !== '') {
        out[k] = prevItem[k];
      } else if (out[k] === undefined) {
        out[k] = k === 'latest_version' ? '' : undefined;
      }
      if (out[k] === undefined) delete out[k];
      continue;
    }
    if (prevItem && prevItem[k] !== undefined && prevItem[k] !== null && prevItem[k] !== '') {
      out[k] = prevItem[k];
    } else if (out[k] === undefined) {
      out[k] = 0;
    }
  }
  for (const k of DISCUSSION_KEYS) {
    if (out[k] === undefined && prevItem && prevItem[k] !== undefined) {
      out[k] = prevItem[k];
    }
  }
  if (allowPlaceholderDiscussion && !out.discussion_number) {
    out.discussion_repo = out.discussion_repo || LAUNCHPAD_REPO;
    out.discussion_number = 1;
    out.discussion_url = out.discussion_url || `https://github.com/${LAUNCHPAD_REPO}/discussions/1`;
  }
  return out;
}

/**
 * 纯函数编译 `launchpad.json`：
 * - `entries`: `{ data }` 列表
 * - `prevManifest`: 现有 `launchpad.json` 对象（可为 null）
 */
export function buildManifest({ entries, prevManifest = null, nowMs = Date.now(), allowPlaceholderDiscussion = false }) {
  const prevById = new Map((prevManifest?.items ?? []).map((it) => [it.id, it]));
  const listed = entries.filter(({ data }) => !isDelisted(data));
  const items = sortItems(
    listed.map(({ data }) => compileItem(data, prevById.get(data.id), { allowPlaceholderDiscussion })),
  );

  const activePinEntries = listed
    .filter(({ data }) => data.pin && isIsoUtc(data.pin.pin_until) && Date.parse(data.pin.pin_until) > nowMs)
    .sort((a, b) => {
      const oa = a.data.pin.pin_order ?? 999;
      const ob = b.data.pin.pin_order ?? 999;
      return oa - ob || Date.parse(a.data.launched_at) - Date.parse(b.data.launched_at) || a.data.id.localeCompare(b.data.id);
    })
    .slice(0, SPOTLIGHT_MAX_SLOTS);

  const pinned = activePinEntries.map(({ data }, i) => ({
    id: data.id,
    pin_until: data.pin.pin_until,
    pin_tier: data.pin.pin_tier,
    pin_order: i + 1,
  }));

  const prevComparable = prevManifest ? { discussions_repo: prevManifest.discussions_repo, pinned: prevManifest.pinned, items: prevManifest.items } : null;
  const nextComparable = { discussions_repo: prevManifest?.discussions_repo || LAUNCHPAD_REPO, pinned, items };
  const unchanged = prevComparable && JSON.stringify(prevComparable) === JSON.stringify(nextComparable);

  return {
    version: MANIFEST_VERSION,
    generated_at: unchanged && prevManifest?.generated_at ? prevManifest.generated_at : isoNow(nowMs),
    discussions_repo: prevManifest?.discussions_repo || LAUNCHPAD_REPO,
    pinned,
    items,
  };
}

/** 清理 `launches/` 中过期 `pin` 字段并整理 `pin_order`。 */
export function pruneExpiredPinsInSources(launchesDir, nowMs = Date.now()) {
  const files = collectLaunchFiles(launchesDir);
  let changed = false;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.pin && (!isIsoUtc(data.pin.pin_until) || Date.parse(data.pin.pin_until) <= nowMs)) {
      delete data.pin;
      fs.writeFileSync(file, formatJson(data));
      changed = true;
    }
  }
  return changed;
}

/** 为尚未绑定 `discussion_number` 的条目创建（或复用）Discussion，并回写真源文件。 */
export async function bindPendingDiscussions(launchesDir, { token, fetchImpl } = {}) {
  const files = collectLaunchFiles(launchesDir);
  let bound = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isDelisted(data)) continue;
    if (Number.isInteger(data.discussion_number) && data.discussion_number > 0 && data.discussion_url) continue;
    const d = await resolveDiscussion({
      item: data,
      submission: { linked_discussion_url: '' },
      existing: data,
      token,
      fetchImpl,
    });
    const next = { ...data, ...d };
    fs.writeFileSync(file, formatJson(next));
    bound += 1;
  }
  return bound;
}

function parseArgs(argv) {
  const args = {
    launchesDir: path.join(rootDir, 'launches'),
    out: path.join(rootDir, 'launchpad.json'),
    checkSources: false,
    bindDiscussions: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.launchesDir = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--check-sources') args.checkSources = true;
    else if (a === '--bind-discussions') args.bindDiscussions = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (args.bindDiscussions) {
    if (!token) throw new Error('--bind-discussions 需要 GITHUB_TOKEN');
    await bindPendingDiscussions(args.launchesDir, { token });
  }

  const { entries, errors: sourceErrors } = loadAndValidateSources(args.launchesDir);
  if (sourceErrors.length) {
    for (const e of sourceErrors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  if (args.checkSources) {
    console.log(`✓ launches/ 真源校验通过（${entries.length} 个条目）`);
    return;
  }

  const prevManifest = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : null;
  const manifest = buildManifest({ entries, prevManifest });

  const manifestErrors = validateLaunchpad(manifest);
  if (manifestErrors.length) {
    for (const e of manifestErrors) console.error(`✗ ${e}`);
    process.exit(1);
  }

  fs.writeFileSync(args.out, formatJson(manifest));
  console.log(`✓ 已编译 launchpad.json（${manifest.items.length} 个条目，${manifest.pinned.length} 个置顶）`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
