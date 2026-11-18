// REST v3, second half: issues, issue comments and pull requests.

import { parseCommit } from './objects.ts';
import { sendErr, sendJson, sendObj, type Ctx } from './http.ts';
import { issueJson, pullJson } from './rest.ts';
import type { ChangedFile, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// shared helpers (duplicated small, so each module stays self-contained)
// ---------------------------------------------------------------------------

function bodyObj(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.jsonBad) return null;
  if (ctx.json === undefined) return {};
  if (typeof ctx.json !== 'object' || ctx.json === null || Array.isArray(ctx.json)) return null;
  return ctx.json as Record<string, unknown>;
}

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

function intParam(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

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

function authed(ctx: Ctx): boolean {
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

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

export function createIssue(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const title = str(body.title);
  if (title === '') {
    sendErr(ctx, 422, 'Validation Failed: title is required');
    return;
  }
  const wantedLabels: string[] = Array.isArray(body.labels)
    ? (body.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : str((entry as Record<string, unknown>).name)))
    : [];
  for (const name of wantedLabels) {
    if (!repo.labels.has(name)) {
      sendErr(ctx, 422, `Validation Failed: label "${name}" does not exist`);
      return;
    }
  }
  const issue: Issue = {
    id: ctx.store.nextItemId(),
    number: repo.nextNumber,
    title,
    body: str(body.body, ''),
    state: 'open',
    labels: wantedLabels,
    comments: [],
    createdSeq: ctx.store.clock.next(),
    closedAt: null,
    jsonCache: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.jsonCache = null;
  // The cached JSON string goes out as-is: no parse + re-stringify per write.
  sendJson(ctx, 201, issueJson(ctx, repo, issue));
}

export function listIssues(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  const perPage = Math.min(100, Math.max(1, intParam(ctx, 'per_page', 30)));
  const page = Math.max(1, intParam(ctx, 'page', 1));
  let items = [...repo.issues.values()];
  if (state !== 'all') items = items.filter((issue) => issue.state === state);
  if (sort === 'created') {
    items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  sendJson(ctx, 200, `[${slice.map((issue) => issueJson(ctx, repo, issue)).join(',')}]`);
}

export function getIssue(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const number = Number.parseInt(ctx.params.get('number') ?? '', 10);
  const issue = repo.issues.get(number);
  if (!issue) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  // The hot read path: the cached JSON string goes out as-is.
  sendJson(ctx, 200, issueJson(ctx, repo, issue));
}

export function patchIssue(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const number = Number.parseInt(ctx.params.get('number') ?? '', 10);
  const issue = repo.issues.get(number);
  if (!issue) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? new Date((1_735_689_600 + ctx.store.clock.next()) * 1000).toISOString() : null;
  }
  issue.jsonCache = null;
  repo.jsonCache = null;
  sendObj(ctx, 200, JSON.parse(issueJson(ctx, repo, issue)) as Record<string, unknown>);
}

export function createIssueComment(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const number = Number.parseInt(ctx.params.get('number') ?? '', 10);
  const issue = repo.issues.get(number);
  if (!issue) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const comment = { id: ctx.store.nextCommentId(), body: str(body.body, '') };
  issue.comments.push(comment);
  issue.jsonCache = null;
  sendObj(ctx, 201, {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: ctx.store.viewer.login, id: ctx.store.viewer.id },
    created_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
  });
}

export function listIssueComments(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const number = Number.parseInt(ctx.params.get('number') ?? '', 10);
  const issue = repo.issues.get(number);
  if (!issue) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  sendObj(ctx, 200, issue.comments.map((comment) => ({
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: ctx.store.viewer.login, id: ctx.store.viewer.id },
    created_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
  })));
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

export function createPull(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const body = bodyObj(ctx);
  if (body === null) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const head = str(body.head);
  const base = str(body.base, repo.defaultBranch);
  const title = str(body.title);
  if (head === '' || title === '') {
    sendErr(ctx, 422, 'Validation Failed: head and title are required');
    return;
  }
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) {
    sendErr(ctx, 422, 'Validation Failed: head or base branch does not exist');
    return;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.headRef === head && existing.state === 'open') {
      sendErr(ctx, 422, 'Validation Failed: a pull request already exists for this head branch');
      return;
    }
  }
  const pull: Pull = {
    id: ctx.store.nextItemId(),
    number: repo.nextNumber,
    title,
    body: str(body.body, ''),
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    createdSeq: ctx.store.clock.next(),
    comments: [],
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  sendObj(ctx, 201, pullJson(ctx, repo, pull));
}

export function listPulls(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  const perPage = Math.min(100, Math.max(1, intParam(ctx, 'per_page', 30)));
  const page = Math.max(1, intParam(ctx, 'page', 1));
  let items = [...repo.pulls.values()];
  if (state !== 'all') items = items.filter((pull) => pull.state === state);
  items.sort((a, b) => b.createdSeq - a.createdSeq);
  const start = (page - 1) * perPage;
  sendObj(ctx, 200, items.slice(start, start + perPage).map((pull) => pullJson(ctx, repo, pull)));
}

export function getPull(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const number = Number.parseInt(ctx.params.get('number') ?? '', 10);
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  sendObj(ctx, 200, pullJson(ctx, repo, pull));
}

export function listPullFiles(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const number = Number.parseInt(ctx.params.get('number') ?? '', 10);
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const files = diffPullFiles(ctx, pull);
  sendObj(ctx, 200, files.map((file) => ({
    sha: '',
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: '',
  })));
}

/** The merge-base tree against the head tree, as a changed-file list. */
function diffPullFiles(ctx: Ctx, pull: Pull): ChangedFile[] {
  const mb = ctx.store.mergeBase(pull.headSha, pull.baseSha);
  let baseTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  if (mb) {
    const mbObject = ctx.store.getObject(mb);
    if (mbObject?.type === 'commit') baseTree = parseCommit(mbObject.data).tree;
  }
  const headObject = ctx.store.getObject(pull.headSha);
  if (!headObject || headObject.type !== 'commit') return [];
  const headTree = parseCommit(headObject.data).tree;
  return ctx.store.diffTrees(baseTree, headTree);
}

export function mergePull(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (!jsonOk(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const number = Number.parseInt(ctx.params.get('number') ?? '', 10);
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  if (pull.state === 'closed') {
    sendErr(ctx, 405, 'Pull request has already been merged or closed');
    return;
  }
  const mergeSha = ctx.store.squashMerge(repo, pull);
  if (mergeSha === null) {
    sendErr(ctx, 405, 'Merge conflict: the pull request cannot be merged');
    return;
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date((1_735_689_600 + ctx.store.clock.next()) * 1000).toISOString();
  pull.mergeCommitSha = mergeSha;
  sendObj(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
}
