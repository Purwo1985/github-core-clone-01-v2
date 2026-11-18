// The forge's store: one in-memory arena of git objects plus the REST
// resources (repositories, issues, pull requests, labels) that live on top
// of it. Objects are immutable once stored, so packs and advertisements
// built from them stay valid until a ref moves; a per-repository version
// counter invalidates exactly the caches a ref change affects.
//
// Timestamps never read the wall clock: every timestamp the forge invents
// comes from MAKEFUN_TRIAL_NOW plus a monotonic counter, so two runs on the
// same trial answer identically.

import {
  EMPTY_TREE_OID,
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  writePack,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './objects.ts';
import type { ForgeIdentity } from './identity.ts';

/** A deterministic clock: trial time plus a counter. */
export class ForgeClock {
  #baseSec: number;
  #seq = 0;

  constructor(trialNowSec: number) {
    this.#baseSec = trialNowSec;
  }

  next(): number {
    this.#seq += 1;
    return this.#baseSec + this.#seq;
  }

  iso(): string {
    return new Date(this.next() * 1000).toISOString();
  }
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  createdSeq: number;
  closedAt: string | null;
  jsonCache: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  /** Issue comments on the pull request (a PR is an issue in GitHub). */
  comments: { id: number; body: string }[];
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  /** Bumped on every ref change; caches key off it. */
  refVersion: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  /** One counter for issues and pull requests, as GitHub numbers them. */
  nextNumber: number;
  createdAt: string;
  jsonCache: string | null;
  /** Cached ls-refs rows for the current refVersion. */
  lsRefsCache: LsRefRow[] | null;
}

export interface LsRefRow {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** One flat file listing of a tree, path -> entry. */
export function flattenTree(store: Store, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.getObject(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** A small line diff: LCS length over lines, enough for change counts. */
function lineDiffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = oldData.toString('utf8').split('\n');
  const b = newData.toString('utf8').split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  if (m === 0) return { additions: n, deletions: 0 };
  if (n === 0) return { additions: 0, deletions: m };
  // Two-row DP LCS; files here are small (a few hundred lines at most).
  let prev = new Uint32Array(n + 1);
  let cur = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const common = prev[n] as number;
  return { additions: n - common, deletions: m - common };
}

export class Store {
  readonly clock: ForgeClock;
  readonly viewer: ForgeIdentity;
  readonly token: string;
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  #repoId = 0;
  #itemId = 0;
  #commentId = 0;
  /** Pack bytes keyed by repo + wants + haves + depth; objects never change, so entries never go stale. */
  readonly packCache = new Map<string, Buffer>();

  constructor(viewer: ForgeIdentity, token: string, trialNowSec: number) {
    this.viewer = viewer;
    this.token = token;
    this.clock = new ForgeClock(trialNowSec);
  }

  nextRepoId(): number {
    this.#repoId += 1;
    return this.#repoId;
  }

  nextItemId(): number {
    this.#itemId += 1;
    return this.#itemId;
  }

  nextCommentId(): number {
    this.#commentId += 1;
    return this.#commentId;
  }

  // ------------------------------------------------------------------ objects

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // ------------------------------------------------------------------ repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId(),
      name,
      owner,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      refVersion: 0,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      createdAt: this.clock.iso(),
      jsonCache: null,
      lsRefsCache: null,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  /** A repository only when it belongs to the token's login; anything else is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    // Packs naming this repo's objects are keyed by repo id, so drop them.
    for (const key of [...this.packCache.keys()]) {
      if (key.startsWith(`${repo.id}|`)) this.packCache.delete(key);
    }
  }

  // ------------------------------------------------------------ issues / pulls

  /** Create an issue; issues and pull requests share one number counter. */
  createIssue(repo: Repo, title: string, body: string, labels: string[] = []): Issue {
    const issue: Issue = {
      id: this.nextItemId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.clock.next(),
      closedAt: null,
      jsonCache: null,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    repo.jsonCache = null;
    return issue;
  }

  closeIssue(issue: Issue): void {
    if (issue.state === 'closed') return;
    issue.state = 'closed';
    issue.closedAt = this.clock.iso();
    issue.jsonCache = null;
  }

  addComment(repo: Repo, issue: Issue, body: string): { id: number; body: string } {
    const comment = { id: this.nextCommentId(), body };
    issue.comments.push(comment);
    issue.jsonCache = null;
    repo.jsonCache = null;
    return comment;
  }

  /** Create a pull request, or null when head/base is missing or a live PR already covers the head. */
  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return null;
    for (const existing of repo.pulls.values()) {
      if (existing.headRef === head && existing.state === 'open') return null;
    }
    const pull: Pull = {
      id: this.nextItemId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      createdSeq: this.clock.next(),
      comments: [],
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Squash-merge an open pull request; returns the merge sha, or null when closed or conflicting. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state === 'closed') return null;
    const mergeSha = this.squashMerge(repo, pull);
    if (mergeSha === null) return null;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date((1_735_689_600 + this.clock.next()) * 1000).toISOString();
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }

  // ------------------------------------------------------------------ refs

  /** Move a ref and bump the version that invalidates the ref caches. */
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.refVersion += 1;
    repo.lsRefsCache = null;
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.refVersion += 1;
    repo.lsRefsCache = null;
  }

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headOid(repo: Repo): string | undefined {
    return repo.refs.get(this.headTarget(repo));
  }

  // ------------------------------------------------------------------ reachability

  /**
   * Every object reachable from `roots`. With `depth` (git's deepen value),
   * commits at distance depth-1 are the shallow boundary: their trees and
   * blobs ship, their parents do not. `exclude` removes a whole closure up
   * front (the client's haves); `stopAt` cuts the exclude walk at shallow
   * boundaries the client holds but whose parents it does not.
   */
  reachable(
    roots: readonly string[],
    options: { depth?: number; exclude?: ReadonlySet<string>; stopAt?: ReadonlySet<string> } = {},
  ): Set<string> {
    const seen = new Set<string>();
    const exclude = options.exclude;
    const depth = options.depth;
    const stopAt = options.stopAt;
    const commitDepth = new Map<string, number>();
    // `visited` drives the walk; `seen` is the result. An excluded object is
    // left out of the result but the walk still passes through it: a fetch
    // that wants a commit the client already holds (a deepen) still needs
    // that commit's parents, which the client does not hold.
    const visited = new Set<string>();
    // An index queue (true breadth-first order) so a commit's first recorded
    // depth is its shallowest: the depth cutoff must not depend on pop order.
    const queue: string[] = [];
    let head = 0;
    for (const root of roots) {
      if (!isOid(root) || root === ZERO_OID) continue;
      queue.push(root);
      commitDepth.set(root, 0);
    }
    while (head < queue.length) {
      const oid = queue[head] as string;
      head += 1;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const object = this.objects.get(oid);
      if (!object) continue;
      if (!(exclude?.has(oid) ?? false)) seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        const d = commitDepth.get(oid) ?? 0;
        // The tree always ships; parents ship only inside the depth budget
        // and only past commits the client does not already hold shallow.
        queue.push(view.tree);
        const cut = depth !== undefined && d >= depth - 1;
        const stopped = stopAt?.has(oid) ?? false;
        if (!cut && !stopped) {
          for (const parent of view.parents) {
            if (!commitDepth.has(parent)) commitDepth.set(parent, d + 1);
            queue.push(parent);
          }
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** The shallow-boundary commits of a depth-limited walk from `roots` (distance depth-1). */
  shallowBoundary(roots: readonly string[], depth: number): string[] {
    const boundary: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = roots
      .filter((oid) => isOid(oid) && oid !== ZERO_OID)
      .map((oid) => ({ oid, d: 0 }));
    let head = 0;
    while (head < queue.length) {
      const { oid, d } = queue[head] as { oid: string; d: number };
      head += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      if (d === depth - 1) {
        boundary.push(oid);
        continue;
      }
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
    return boundary;
  }

  /** True when `ancestor` is reachable from `descendant` through parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The nearest common ancestor of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    const fromA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.pop() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (fromA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  // ------------------------------------------------------------------ trees

  /** The tree oid at `path` under `rootOid`, or null. */
  readPath(rootOid: string, path: string): { oid: string; mode: string } | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = rootOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { oid: current, mode: '40000' };
  }

  /** List a directory's entries (empty path = the root tree). */
  listDir(rootOid: string, path: string): TreeEntry[] | null {
    if (path === '') {
      const object = this.objects.get(rootOid);
      return object?.type === 'tree' ? parseTree(object.data) : null;
    }
    const found = this.readPath(rootOid, path);
    if (!found || found.mode !== '40000') return null;
    const object = this.objects.get(found.oid);
    return object?.type === 'tree' ? parseTree(object.data) : null;
  }

  /**
   * A new tree with `path` set to `blobOid` (or removed when null), built
   * bottom-up from `rootOid`. Intermediate trees are created as needed.
   */
  setPath(rootOid: string, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string, depth: number): string => {
      const object = this.objects.get(treeOid);
      const entries = object?.type === 'tree' ? parseTree(object.data) : [];
      const name = segments[depth] as string;
      const next = entries.filter((entry) => entry.name !== name);
      if (depth === segments.length - 1) {
        if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.find((entry) => entry.name === name);
        const childOid = child?.mode === '40000' ? child.oid : EMPTY_TREE_OID;
        const rebuilt = build(childOid, depth + 1);
        const rebuiltObject = this.objects.get(rebuilt);
        const isEmpty = rebuiltObject !== undefined && rebuiltObject.data.length === 0 && rebuilt === EMPTY_TREE_OID;
        if (!isEmpty) next.push({ mode: '40000', name, oid: rebuilt });
      }
      return this.putObject('tree', buildTree(next));
    };
    return build(rootOid, 0);
  }

  /** The diff between two trees, with line counts. */
  diffTrees(baseOid: string, headOid: string): ChangedFile[] {
    const base = flattenTree(this, baseOid);
    const head = flattenTree(this, headOid);
    const files: ChangedFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const data = this.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const deletions = countLines(data);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const data = this.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(data);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        const oldData = this.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const newData = this.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = lineDiffCounts(oldData, newData);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** 'MERGEABLE' or 'CONFLICTING' for a head tip against a base tip. */
  mergeable(headTip: string, baseTip: string): 'MERGEABLE' | 'CONFLICTING' {
    const mb = this.mergeBase(headTip, baseTip);
    if (mb === null) return 'CONFLICTING';
    const mbObject = this.objects.get(mb);
    const headObject = this.objects.get(headTip);
    const baseObject = this.objects.get(baseTip);
    if (!mbObject || !headObject || !baseObject) return 'CONFLICTING';
    const mbTree = parseCommit(mbObject.data).tree;
    const headTree = parseCommit(headObject.data).tree;
    const baseTree = parseCommit(baseObject.data).tree;
    const mbFiles = flattenTree(this, mbTree);
    const headFiles = flattenTree(this, headTree);
    const baseFiles = flattenTree(this, baseTree);
    const paths = new Set([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const m = mbFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const b = baseFiles.get(path)?.oid;
      const headChanged = h !== m;
      const baseChanged = b !== m;
      if (headChanged && baseChanged && h !== b) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  // ------------------------------------------------------------------ commits

  /** The identity string for commit author/committer lines. */
  ident(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  /**
   * Commit `files` (path -> bytes, or null to delete) on `branch`, creating
   * the branch from the default tip when it does not exist yet. Returns the
   * new commit oid.
   */
  commitFiles(repo: Repo, branch: string, files: ReadonlyArray<{ path: string; data: Buffer | null }>, message: string): string {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined) {
      tip = this.headOid(repo);
    }
    let treeOid = EMPTY_TREE_OID;
    const parents: string[] = [];
    if (tip !== undefined) {
      const commit = this.objects.get(tip);
      if (commit?.type === 'commit') {
        treeOid = parseCommit(commit.data).tree;
        parents.push(tip);
      }
    }
    for (const file of files) {
      const blobOid = file.data === null ? null : this.putObject('blob', file.data);
      treeOid = this.setPath(treeOid, file.path, blobOid);
    }
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.ident(),
      committer: this.ident(),
      timestamp: this.clock.next(),
    });
    const commitOid = this.putObject('commit', commitData);
    this.setRef(repo, ref, commitOid);
    return commitOid;
  }

  /**
   * A squash merge of `pull` onto its base branch: one commit whose tree is
   * the head tree, parented on the base tip. Returns the merge commit oid,
   * or null when the pull conflicts.
   */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return null;
    if (this.mergeable(headTip, baseTip) !== 'MERGEABLE') return null;
    const headObject = this.objects.get(headTip);
    if (!headObject || headObject.type !== 'commit') return null;
    const headTree = parseCommit(headObject.data).tree;
    const commitData = buildCommit({
      tree: headTree,
      parents: [baseTip],
      message: `${pull.title}\n`,
      author: this.ident(),
      committer: this.ident(),
      timestamp: this.clock.next(),
    });
    const mergeOid = this.putObject('commit', commitData);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, mergeOid);
    return mergeOid;
  }

  /** Build a pack for a fetch, from the cache when the same ask was made before. */
  fetchPack(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | undefined, shallow: readonly string[]): { pack: Buffer; shallowOut: string[]; unshallowOut: string[] } {
    const key = `${repo.id}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth ?? ''}|${[...shallow].sort().join(',')}`;
    const cached = this.packCache.get(key);
    if (cached) {
      const { shallowOut, unshallowOut } = this.shallowInfo(repo, wants, depth, shallow);
      return { pack: cached, shallowOut, unshallowOut };
    }
    const stopAt = shallow.length > 0 ? new Set(shallow) : undefined;
    const exclude = haves.length > 0 ? this.reachable(haves, { stopAt }) : undefined;
    const wanted = this.reachable(wants, { depth, exclude });
    const objects: GitObject[] = [];
    for (const oid of wanted) {
      const object = this.objects.get(oid);
      if (object) objects.push(object);
    }
    // Deterministic pack order: commits first, then trees, then blobs, each by oid.
    const rank = (type: ObjType): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3);
    objects.sort((a, b) => rank(a.type) - rank(b.type));
    const pack = writePack(objects);
    if (this.packCache.size >= 256) this.packCache.clear();
    this.packCache.set(key, pack);
    const { shallowOut, unshallowOut } = this.shallowInfo(repo, wants, depth, shallow);
    return { pack, shallowOut, unshallowOut };
  }

  /** The shallow-info lines for a fetch: new boundaries, and old ones now deepened. */
  shallowInfo(
    repo: Repo,
    wants: readonly string[],
    depth: number | undefined,
    shallow: readonly string[],
  ): { shallowOut: string[]; unshallowOut: string[] } {
    void repo;
    if (depth === undefined) return { shallowOut: [], unshallowOut: [] };
    const shallowOut = this.shallowBoundary(wants, depth);
    const unshallowOut: string[] = [];
    for (const boundary of shallow) {
      if (shallowOut.includes(boundary)) continue;
      // A boundary whose parents are now inside the fetched depth unshallows.
      const depthOf = this.commitDepthFrom(wants, boundary);
      if (depthOf !== null && depthOf < depth - 1) unshallowOut.push(boundary);
    }
    return { shallowOut, unshallowOut };
  }

  /** Generations from any of `roots` down to `target`, or null when unreachable. */
  commitDepthFrom(roots: readonly string[], target: string): number | null {
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = roots.map((oid) => ({ oid, d: 0 }));
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === target) return d;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
    return null;
  }

  // ------------------------------------------------------------------ ls-refs

  /** The ref rows for ls-refs/advertisements, cached per ref version. */
  lsRefs(repo: Repo): LsRefRow[] {
    if (repo.lsRefsCache) return repo.lsRefsCache;
    const rows: LsRefRow[] = [];
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      const row: LsRefRow = { oid, name };
      if (name.startsWith('refs/tags/')) {
        const object = this.objects.get(oid);
        if (object?.type === 'tag') {
          const target = parseTag(object.data).object;
          if (this.objects.get(target)?.type === 'commit') row.peeled = target;
        }
      }
      rows.push(row);
    }
    repo.lsRefsCache = rows;
    return rows;
  }
}
