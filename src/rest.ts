// REST v3: repositories, branches, commits, contents, labels, issues and
// pull requests. Serializers build GitHub-shaped JSON; the hot reads
// (one repository, one issue) are cached as strings on the record and
// invalidated by the mutations that touch them.

import { parseCommit, parseTree } from './objects.ts';
import { sendEmpty, sendErr, sendJson, sendObj, type Ctx } from './http.ts';
import type { Issue, Label, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// auth and body helpers
// ---------------------------------------------------------------------------

/** True when the request carries the trial's token (or any token in dev mode). */
export function authed(ctx: Ctx): boolean {
  if (ctx.store.token === '') return true;
  return ctx.token !== '' && ctx.token === ctx.store.token;
}

function requireAuth(ctx: Ctx): boolean {
  if (!authed(ctx)) {
    sendErr(ctx, 401, 'Requires authentication');
    return false;
  }
  return true;
}

/** The JSON object body, or null when the body was not a JSON object. */
function bodyObj(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.jsonBad) return null;
  if (ctx.json === undefined) return {};
  if (typeof ctx.json !== 'object' || ctx.json === null || Array.isArray(ctx.json)) return null;
  return ctx.json as Record<string, unknown>;
}

/** 400 when the body was malformed JSON; true when the handler may proceed. */
function jsonOk(ctx: Ctx): boolean {
  if (ctx.jsonBad) {
    sendErr(ctx, 400, 'Invalid JSON');
    return false;
  }
  return true;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intParam(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** Pagination: per_page (default 30, max 100) and page (default 1). */
function pageOf(ctx: Ctx): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, intParam(ctx, 'per_page', 30)));
  const page = Math.max(1, intParam(ctx, 'page', 1));
  return { perPage, page };
}

/** The Link header for a paginated list, with absolute same-origin URLs. */
function linkHeader(ctx: Ctx, total: number, perPage: number, page: number): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const proto = 'http';
  const base = `${proto}://${host}${ctx.req.url?.split('?')[0] ?? ''}`;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${base}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], perPage: number, page: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

export function userJson(ctx: Ctx): Record<string, unknown> {
  const viewer = ctx.store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: Buffer.from(`User:${viewer.id}`).toString('base64'),
    avatar_url: `https://avatars.githubusercontent.com/u/${viewer.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${viewer.login}`,
    html_url: `https://github.com/${viewer.login}`,
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
  };
}

function userRef(ctx: Ctx): Record<string, unknown> {
  const viewer = ctx.store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: Buffer.from(`User:${viewer.id}`).toString('base64'),
    avatar_url: `https://avatars.githubusercontent.com/u/${viewer.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${viewer.login}`,
    html_url: `https://github.com/${viewer.login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(ctx: Ctx, repo: Repo): string {
  if (repo.jsonCache) return repo.jsonCache;
  const owner = userRef(ctx);
  const text = JSON.stringify({
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  });
  repo.jsonCache = text;
  return text;
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: 0,
    node_id: Buffer.from(`Label:${label.name}`).toString('base64'),
    url: `/api/v3/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: '',
  };
}

export function issueJson(ctx: Ctx, repo: Repo, issue: Issue): string {
  if (issue.jsonCache) return issue.jsonCache;
  const text = JSON.stringify({
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userRef(ctx),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    draft: false,
  });
  issue.jsonCache = text;
  return text;
}

export function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const headUser = userRef(ctx);
  const refPair = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: headUser,
    repo: JSON.parse(repoJson(ctx, repo)) as Record<string, unknown>,
  });
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: headUser,
    labels: [],
    milestone: null,
    locked: false,
    created_at: new Date((1_735_689_600 + pull.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + pull.createdSeq) * 1000).toISOString(),
    closed_at: pull.state === 'closed' ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    head: refPair(pull.headRef, pull.headSha),
    base: refPair(pull.baseRef, pull.baseSha),
    merged: pull.merged,
    mergeable: pull.state === 'open' ? ctx.store.mergeable(pull.headSha, pull.baseSha) === 'MERGEABLE' : null,
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(ctx: Ctx, repo: Repo, issue: Issue, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userRef(ctx),
    created_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// repo lookup
// ---------------------------------------------------------------------------

function lookupRepo(ctx: Ctx): Repo | null {
  const owner = ctx.params.get('owner') ?? '';
  const name = ctx.params.get('repo') ?? '';
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    sendErr(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

// ---------------------------------------------------------------------------
// API root, meta, user
// ---------------------------------------------------------------------------

export function apiRoot(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  sendObj(ctx, 200, {
    current_user_url: '/api/v3/user',
    rate_limit_url: '/api/v3/rate_limit',
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

export function apiMeta(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  sendObj(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
}

export function getUser(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  sendObj(ctx, 200, userJson(ctx));
}

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

export function createRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const name = str(body.name);
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    sendErr(ctx, 422, 'Validation Failed: name is invalid');
    return;
  }
  if (ctx.store.repos.has(ctx.store.repoKey(ctx.store.viewer.login, name))) {
    sendErr(ctx, 422, 'Repository already exists');
    return;
  }
  const repo = ctx.store.createRepo(ctx.store.viewer.login, name, bool(body.private, false), str(body.description, ''));
  sendJson(ctx, 201, repoJson(ctx, repo));
}

export function listUserRepos(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const { perPage, page } = pageOf(ctx);
  const all = [...ctx.store.repos.values()].filter((repo) => repo.owner === ctx.store.viewer.login);
  const slice = paginate(all, perPage, page);
  const body = `[${slice.map((repo) => repoJson(ctx, repo)).join(',')}]`;
  const extra: Record<string, string> = {};
  if (page * perPage < all.length || page > 1) extra.link = linkHeader(ctx, all.length, perPage, page);
  sendJson(ctx, 200, body, extra);
}

export function getRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  sendJson(ctx, 200, repoJson(ctx, repo));
}

export function patchRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  if (typeof body.description === 'string') repo.description = body.description;
  repo.jsonCache = null;
  sendJson(ctx, 200, repoJson(ctx, repo));
}

export function deleteRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  ctx.store.deleteRepo(repo);
  sendEmpty(ctx, 204);
}

// ---------------------------------------------------------------------------
// branches, commits, git refs
// ---------------------------------------------------------------------------

export function listBranches(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  sendObj(ctx, 200, names.map((ref) => ({
    name: ref.slice('refs/heads/'.length),
    commit: { sha: repo.refs.get(ref), url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(ref)}` },
    protected: false,
  })));
}

export function getBranch(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const branch = ctx.params.get('branch') ?? '';
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) {
    sendErr(ctx, 404, 'Branch not found');
    return;
  }
  sendObj(ctx, 200, {
    name: branch,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  });
}

export function listCommits(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const shaParam = ctx.query.get('sha');
  let tip: string | undefined;
  if (shaParam) {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.refs.get(shaParam) as string | undefined);
    if (!tip && /^[0-9a-f]{40}$/.test(shaParam)) tip = shaParam;
  } else {
    tip = ctx.store.headOid(repo);
  }
  const out: Record<string, unknown>[] = [];
  if (tip) {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && out.length < 100) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = ctx.store.getObject(oid);
      if (!object || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      const authorLine = view.author;
      const stamp = authorLine.match(/ (\d+) \+0000$/);
      const date = stamp ? new Date(Number(stamp[1]) * 1000).toISOString() : repo.createdAt;
      const ident = authorLine.replace(/ \d+ \+0000$/, '');
      const lt = ident.lastIndexOf('<');
      const name = lt > 0 ? ident.slice(0, lt).trim() : ident;
      const email = lt > 0 ? ident.slice(lt + 1, ident.length - 1) : '';
      // GitHub's API returns the message without the trailing newline the
      // commit object itself carries.
      const message = view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message;
      out.push({
        sha: oid,
        node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
        commit: {
          author: { name, email, date },
          committer: { name, email, date },
          message,
          tree: { sha: view.tree },
          url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
          comment_count: 0,
          verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        },
        url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
        parents: view.parents.map((parent) => ({ sha: parent })),
      });
      for (const parent of view.parents) queue.push(parent);
    }
  }
  sendObj(ctx, 200, out);
}

export function createGitRef(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
    sendErr(ctx, 422, 'Validation Failed');
    return;
  }
  if (repo.refs.has(ref)) {
    sendErr(ctx, 422, 'Reference already exists');
    return;
  }
  if (!ctx.store.getObject(sha)) {
    sendErr(ctx, 422, 'Object does not exist');
    return;
  }
  ctx.store.setRef(repo, ref, sha);
  sendObj(ctx, 201, {
    ref,
    node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: ctx.store.getObject(sha)?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  });
}

export function getGitRef(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const branch = ctx.params.get('branch') ?? '';
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  sendObj(ctx, 200, {
    ref: `refs/heads/${branch}`,
    node_id: Buffer.from(`Ref:refs/heads/${branch}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`,
    object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  });
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function contentsPath(ctx: Ctx): string {
  return ctx.params.get('*') ?? '';
}

/** The commit a contents read resolves against: a branch tip or an oid. */
function resolveRefCommit(ctx: Ctx, repo: Repo): string | null {
  const ref = ctx.query.get('ref');
  if (!ref) return ctx.store.headOid(repo) ?? null;
  const branchTip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (branchTip) return branchTip;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = ctx.store.getObject(ref);
    return object?.type === 'commit' ? ref : null;
  }
  return null;
}

export function getContents(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const path = contentsPath(ctx);
  const tip = resolveRefCommit(ctx, repo);
  if (!tip) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const commit = ctx.store.getObject(tip);
  if (!commit || commit.type !== 'commit') {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const treeOid = parseCommit(commit.data).tree;
  if (path === '') {
    const entries = ctx.store.listDir(treeOid, '');
    if (!entries) {
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    sendObj(ctx, 200, entries.map((entry) => dirEntryJson(ctx, repo, '', entry)));
    return;
  }
  const found = ctx.store.readPath(treeOid, path);
  if (!found) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  if (found.mode === '40000') {
    const entries = ctx.store.listDir(treeOid, path);
    if (!entries) {
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    sendObj(ctx, 200, entries.map((entry) => dirEntryJson(ctx, repo, path, entry)));
    return;
  }
  const blob = ctx.store.getObject(found.oid);
  if (!blob) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const name = path.split('/').pop() ?? path;
  sendObj(ctx, 200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    content: blob.data.toString('base64'),
    sha: found.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${found.oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  });
}

function dirEntryJson(ctx: Ctx, repo: Repo, dir: string, entry: { mode: string; name: string; oid: string }): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const blob = isDir ? null : ctx.store.getObject(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: blob?.data.length ?? 0,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  };
}

export function putContents(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const path = contentsPath(ctx);
  const message = str(body.message, 'Update file');
  const contentB64 = str(body.content);
  if (contentB64 === '' && body.content !== '') {
    sendErr(ctx, 422, 'Validation Failed: content is required');
    return;
  }
  const data = Buffer.from(contentB64, 'base64');
  // The branch may ride in the JSON body or in the ?branch= query string.
  const branch = str(body.branch, '') || ctx.query.get('branch') || repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  let currentSha: string | null = null;
  if (tip) {
    const commit = ctx.store.getObject(tip);
    if (commit?.type === 'commit') {
      const found = ctx.store.readPath(parseCommit(commit.data).tree, path);
      if (found && found.mode !== '40000') currentSha = found.oid;
    }
  }
  const givenSha = str(body.sha, '');
  if (currentSha !== null) {
    if (givenSha === '' || givenSha.toLowerCase() !== currentSha.toLowerCase()) {
      sendErr(ctx, 409, 'Conflict: sha does not match the current blob');
      return;
    }
  }
  const blobOid = ctx.store.putObject('blob', data);
  const commitOid = ctx.store.commitFiles(repo, branch, [{ path, data }], message);
  const name = path.split('/').pop() ?? path;
  sendObj(ctx, currentSha !== null ? 200 : 201, {
    content: {
      name,
      path,
      sha: blobOid,
      size: data.length,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${path}`,
      type: 'file',
      encoding: 'base64',
    },
    commit: {
      sha: commitOid,
      node_id: Buffer.from(`Commit:${commitOid}`).toString('base64'),
      message,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}`,
      author: { name: ctx.store.viewer.name, email: ctx.store.viewer.email, date: repo.createdAt },
      committer: { name: ctx.store.viewer.name, email: ctx.store.viewer.email, date: repo.createdAt },
      tree: { sha: '' },
      parents: [],
    },
  });
}

export function deleteContents(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const path = contentsPath(ctx);
  const message = str(body.message, 'Delete file');
  const branch = str(body.branch, '') || ctx.query.get('branch') || repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const commit = ctx.store.getObject(tip);
  if (!commit || commit.type !== 'commit') {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const found = ctx.store.readPath(parseCommit(commit.data).tree, path);
  if (!found || found.mode === '40000') {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const commitOid = ctx.store.commitFiles(repo, branch, [{ path, data: null }], message);
  sendObj(ctx, 200, {
    commit: {
      sha: commitOid,
      node_id: Buffer.from(`Commit:${commitOid}`).toString('base64'),
      message,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}`,
    },
  });
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export function createLabel(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const name = str(body.name);
  if (name === '') {
    sendErr(ctx, 422, 'Validation Failed: name is required');
    return;
  }
  const existing = repo.labels.get(name);
  if (existing) {
    sendObj(ctx, 201, labelJson(existing));
    return;
  }
  const label: Label = { name, color: str(body.color, 'ededed') };
  repo.labels.set(name, label);
  sendObj(ctx, 201, labelJson(label));
}

export function listLabels(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  sendObj(ctx, 200, [...repo.labels.values()].map(labelJson));
}
