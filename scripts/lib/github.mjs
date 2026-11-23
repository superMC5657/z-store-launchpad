/**
 * GitHub REST / GraphQL 极简客户端（零依赖，Node ≥ 20 全局 fetch）。
 * GraphQL 一律经 `variables` 参数化，绝不拼接查询体；令牌只放请求头，不写日志。
 */

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'z-store-launchpad-bot',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** REST 请求；`allow404` 时 404 返回 `null`。 */
export async function rest(pathOrUrl, { method = 'GET', body, token, fetchImpl = fetch, allow404 = false } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await fetchImpl(url, {
    method,
    headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new GitHubError(`${method} ${new URL(url).pathname} → HTTP ${res.status}`, res.status);
  if (res.status === 204) return null;
  return res.json();
}

/** 只关心状态码的 REST GET（如成员关系探测：204 是、404 否）；网络错误返回 0。 */
export async function restStatus(pathOrUrl, { token, fetchImpl = fetch } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  try {
    return (await fetchImpl(url, { method: 'GET', headers: headers(token) })).status;
  } catch {
    return 0;
  }
}

/** GraphQL 请求：返回 `data`，`errors` 抛出。 */
export async function graphql(query, variables, { token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GitHubError(`GraphQL → HTTP ${res.status}`, res.status);
  const json = await res.json();
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new GitHubError(`GraphQL: ${json.errors.map((e) => e.message).join('; ')}`, 200);
  }
  return json.data;
}

/**
 * GraphQL 请求，保留部分成功：返回 `{ data, errors }`，由调用方判定哪些错误可容忍
 * （如批量别名查询里某个仓库 `NOT_FOUND`）。HTTP 失败仍抛出。
 */
export async function graphqlPartial(query, variables, { token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GitHubError(`GraphQL → HTTP ${res.status}`, res.status);
  const json = await res.json();
  return { data: json.data ?? null, errors: Array.isArray(json.errors) ? json.errors : [] };
}
