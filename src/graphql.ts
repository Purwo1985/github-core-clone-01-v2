// GraphQL over the same store as REST: a small hand-written parser and
// executor for the fixed documents the suite sends. Global ids are the
// same opaque base64 node ids REST returns, so a node created through one
// API round-trips through the other. Unknown fields answer HTTP 200 with
// an errors array naming the field, as real GraphQL does.

import { sendErr, sendObj, type Ctx } from './http.ts';
import { authed } from './rest.ts';
import { parseCommit } from './objects.ts';
import type { ChangedFile, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// global ids (opaque, stable, shared with the REST node_id shape)
// ---------------------------------------------------------------------------

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const repoNodeId = (repo: Repo): string => b64(`Repository:${repo.id}`);
const issueNodeId = (repo: Repo, issue: Issue): string => b64(`Issue:${repo.id}:${issue.number}`);
const pullNodeId = (repo: Repo, pull: Pull): string => b64(`PullRequest:${repo.id}:${pull.number}`);
const userNodeId = (id: number): string => b64(`User:${id}`);
const commentNodeId = (comment: { id: number }): string => b64(`IssueComment:${comment.id}`);

/** The deterministic created-at stamp an issue or pull request carries. */
const itemCreatedAt = (createdSeq: number): string =>
  new Date((1_735_689_600 + createdSeq) * 1000).toISOString();

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const c = source[i] as string;
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += map[esc] ?? esc;
            i += 2;
          }
        } else {
          value += c;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = i;
      if (source[i] === '-') i += 1;
      while (i < source.length && /[0-9]/.test(source[i] as string)) i += 1;
      let isFloat = false;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] as string)) {
        isFloat = true;
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i] as string)) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        while (i < source.length && /[0-9]/.test(source[i] as string)) i += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, i) });
      continue;
    }
    if (isNameStart(ch)) {
      const start = i;
      while (i < source.length && isNameChar(source[i] as string)) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i) });
      continue;
    }
    throw new Error(`Unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'bool' | 'enum'; value: string | boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

type Selection =
  | { kind: 'field'; alias: string; name: string; args: Map<string, Value>; selections: Selection[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Map<string, { defaultValue: Value | null }>;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected name');
    if (value !== undefined && token.value !== value) throw new Error(`Expected ${value}`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        void typeCondition;
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value as string;
    }
    const varDefs = new Map<string, { defaultValue: Value | null }>();
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: Value | null = null;
        if (this.isPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        varDefs.set(varName, { defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value as string };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      name = this.expectName();
    }
    const args = new Map<string, Value>();
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    // Directives are accepted and ignored.
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    let selections: Selection[] = [];
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.isPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('Expected value');
  }
}

// ---------------------------------------------------------------------------
// value resolution (variables, literals)
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function resolveValue(value: Value, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>): JsonValue {
  switch (value.kind) {
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(variables, value.name)) return variables[value.name] as JsonValue;
      const def = varDefs.get(value.name);
      if (def?.defaultValue) return resolveValue(def.defaultValue, variables, varDefs);
      return null;
    }
    case 'string':
    case 'enum':
      return value.value as string;
    case 'int':
      return Number.parseInt(value.value as string, 10);
    case 'float':
      return Number.parseFloat(value.value as string);
    case 'bool':
      return value.value as boolean;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables, varDefs));
    case 'object': {
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables, varDefs);
      return out;
    }
  }
}

function argString(args: Map<string, Value>, name: string, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>, fallback = ''): string {
  const raw = args.get(name);
  if (!raw) return fallback;
  const value = resolveValue(raw, variables, varDefs);
  return typeof value === 'string' ? value : fallback;
}

function argNumber(args: Map<string, Value>, name: string, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>, fallback: number): number {
  const raw = args.get(name);
  if (!raw) return fallback;
  const value = resolveValue(raw, variables, varDefs);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

class GqlError extends Error {}

type Source = Record<string, unknown> & { __typename: string };
type FieldFn = (source: Source, args: Map<string, Value>, ctx: Ctx, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>) => unknown;

const cursorOf = (index: number): string => b64(`cursor:${index}`);
function cursorIndex(cursor: string | null): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

interface Page<T> {
  nodes: T[];
  edges: Array<{ node: T; cursor: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null };
  totalCount: number;
}

function paginate<T>(items: readonly T[], args: Map<string, Value>, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>): Page<T> {
  const after = argString(args, 'after', variables, varDefs, '');
  const first = argNumber(args, 'first', variables, varDefs, 30);
  const start = cursorIndex(after || null) + 1;
  const slice = items.slice(start, start + Math.max(0, first));
  const edges = slice.map((node, i) => ({ node, cursor: cursorOf(start + i) }));
  return {
    nodes: slice,
    edges,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
    },
    totalCount: items.length,
  };
}

function userSource(ctx: Ctx): Source {
  const viewer = ctx.store.viewer;
  return { __typename: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function connectionSource<T>(typename: string, page: Page<T>): Source {
  return { __typename: typename, page };
}

function sortIssues(items: Issue[], args: Map<string, Value>, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>): Issue[] {
  const states = listArg(args, 'states', variables, varDefs);
  let out = items;
  if (states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
    out = out.filter((item) => wanted.has(item.state));
  }
  const orderBy = objectArg(args, 'orderBy', variables, varDefs);
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  return [...out].sort((a, b) => {
    const byCreated = (a.createdSeq - b.createdSeq) * direction;
    return byCreated !== 0 ? byCreated : (a.number - b.number) * direction;
  });
}

function sortPulls(items: Pull[], args: Map<string, Value>, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>): Pull[] {
  const states = listArg(args, 'states', variables, varDefs);
  let out = items;
  if (states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
    out = out.filter((item) => wanted.has(item.state));
  }
  const orderBy = objectArg(args, 'orderBy', variables, varDefs);
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  return [...out].sort((a, b) => {
    const byCreated = (a.createdSeq - b.createdSeq) * direction;
    return byCreated !== 0 ? byCreated : (a.number - b.number) * direction;
  });
}

function listArg(args: Map<string, Value>, name: string, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>): string[] {
  const raw = args.get(name);
  if (!raw) return [];
  const value = resolveValue(raw, variables, varDefs);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function objectArg(args: Map<string, Value>, name: string, variables: Record<string, unknown>, varDefs: Map<string, { defaultValue: Value | null }>): Record<string, JsonValue> | null {
  const raw = args.get(name);
  if (!raw) return null;
  const value = resolveValue(raw, variables, varDefs);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : null;
}

function filesOf(ctx: Ctx, pull: Pull): ChangedFile[] {
  const mb = ctx.store.mergeBase(pull.headSha, pull.baseSha);
  let baseTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  if (mb) {
    const mbObject = ctx.store.getObject(mb);
    if (mbObject?.type === 'commit') baseTree = parseCommit(mbObject.data).tree;
  }
  const headObject = ctx.store.getObject(pull.headSha);
  if (!headObject || headObject.type !== 'commit') return [];
  return ctx.store.diffTrees(baseTree, parseCommit(headObject.data).tree);
}

function resolveNode(ctx: Ctx, id: string): Source | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const [kind, a, b] = text.split(':');
  if (kind === 'User') {
    const viewer = ctx.store.viewer;
    if (Number(a) === viewer.id) return userSource(ctx);
    return null;
  }
  if (kind === 'Repository') {
    for (const repo of ctx.store.repos.values()) {
      if (repo.id === Number(a)) return repoSource(repo);
    }
    return null;
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    for (const repo of ctx.store.repos.values()) {
      if (repo.id !== Number(a)) continue;
      if (kind === 'Issue') {
        const issue = repo.issues.get(Number(b));
        return issue ? issueSource(repo, issue) : null;
      }
      const pull = repo.pulls.get(Number(b));
      return pull ? pullSource(repo, pull) : null;
    }
    return null;
  }
  if (kind === 'IssueComment') {
    const commentId = Number(a);
    for (const repo of ctx.store.repos.values()) {
      for (const issue of repo.issues.values()) {
        const comment = issue.comments.find((entry) => entry.id === commentId);
        if (comment) return { __typename: 'IssueComment', repo, issue, comment };
      }
    }
    return null;
  }
  return null;
}

const FIELDS: Record<string, Record<string, FieldFn>> = {
  Query: {
    viewer: (source, _args, ctx) => userSource(ctx),
    repository: (source, args, ctx, variables, varDefs) => {
      const owner = argString(args, 'owner', variables, varDefs);
      const name = argString(args, 'name', variables, varDefs);
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoSource(repo) : null;
    },
    node: (source, args, ctx, variables, varDefs) => {
      const id = argString(args, 'id', variables, varDefs);
      return id === '' ? null : resolveNode(ctx, id);
    },
    __type: (source, args, ctx, variables, varDefs) => {
      const name = argString(args, 'name', variables, varDefs);
      return introspectType(name);
    },
    __schema: () => ({ __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }),
  },
  Mutation: {
    createIssue: (source, args, ctx, variables, varDefs) => {
      const input = objectArg(args, 'input', variables, varDefs) ?? {};
      const repo = input.repositoryId ? resolveNode(ctx, String(input.repositoryId)) : null;
      if (!repo || repo.__typename !== 'Repository') throw new GqlError('Could not resolve to a Repository with the provided repositoryId.');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlError('Field `title` is required.');
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo.repo as Repo, title, body);
      return {
        __typename: 'CreateIssuePayload',
        issue: issueSource(repo.repo as Repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    closeIssue: (source, args, ctx, variables, varDefs) => {
      const input = objectArg(args, 'input', variables, varDefs) ?? {};
      const node = input.issueId ? resolveNode(ctx, String(input.issueId)) : null;
      if (!node || node.__typename !== 'Issue') throw new GqlError('Could not resolve to an Issue with the provided issueId.');
      const issue = node.issue as Issue;
      ctx.store.closeIssue(issue);
      return {
        __typename: 'CloseIssuePayload',
        issue: issueSource(node.repo as Repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    createPullRequest: (source, args, ctx, variables, varDefs) => {
      const input = objectArg(args, 'input', variables, varDefs) ?? {};
      const repo = input.repositoryId ? resolveNode(ctx, String(input.repositoryId)) : null;
      if (!repo || repo.__typename !== 'Repository') throw new GqlError('Could not resolve to a Repository with the provided repositoryId.');
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (title === '' || head === '' || base === '') throw new GqlError('Field `title`, `headRefName` and `baseRefName` are required.');
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = ctx.store.createPull(repo.repo as Repo, title, body, head, base);
      if (!pull) throw new GqlError('Validation Failed: head or base branch does not exist.');
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullSource(repo.repo as Repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    mergePullRequest: (source, args, ctx, variables, varDefs) => {
      const input = objectArg(args, 'input', variables, varDefs) ?? {};
      const node = input.pullRequestId ? resolveNode(ctx, String(input.pullRequestId)) : null;
      if (!node || node.__typename !== 'PullRequest') throw new GqlError('Could not resolve to a PullRequest with the provided pullRequestId.');
      const pull = node.pull as Pull;
      const mergeSha = ctx.store.mergePull(node.repo as Repo, pull);
      if (mergeSha === null) throw new GqlError('Pull request cannot be merged.');
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullSource(node.repo as Repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    addComment: (source, args, ctx, variables, varDefs) => {
      const input = objectArg(args, 'input', variables, varDefs) ?? {};
      const node = input.subjectId ? resolveNode(ctx, String(input.subjectId)) : null;
      if (!node || (node.__typename !== 'Issue' && node.__typename !== 'PullRequest')) {
        throw new GqlError('Could not resolve to an Issue with the provided subjectId.');
      }
      const body = typeof input.body === 'string' ? input.body : '';
      if (body === '') throw new GqlError('Field `body` is required.');
      let comment: { id: number; body: string };
      let subject: Source;
      if (node.__typename === 'Issue') {
        const issue = node.issue as Issue;
        comment = ctx.store.addComment(node.repo as Repo, issue, body);
        subject = issueSource(node.repo as Repo, issue);
      } else {
        const pull = node.pull as Pull;
        comment = { id: ctx.store.nextCommentId(), body };
        pull.comments.push(comment);
        subject = pullSource(node.repo as Repo, pull);
      }
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo: node.repo, comment }, cursor: cursorOf(0) },
        subject,
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
  },
  User: {
    id: (source) => userNodeId(source.id as number),
    databaseId: (source) => source.id as number,
    login: (source) => source.login as string,
    name: (source) => (source.name as string | null) ?? null,
    email: (source) => (source.email as string | null) ?? null,
  },
  Repository: {
    id: (source) => repoNodeId(source.repo as Repo),
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => {
      const repo = source.repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (source, _args, ctx) => userSource(ctx),
    defaultBranchRef: (source) => ({ __typename: 'Ref', name: (source.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (source) => (source.repo as Repo).isPrivate,
    description: (source) => (source.repo as Repo).description,
    createdAt: (source) => (source.repo as Repo).createdAt,
    updatedAt: (source) => (source.repo as Repo).createdAt,
    url: (source) => {
      const repo = source.repo as Repo;
      return `https://github.com/${repo.owner}/${repo.name}`;
    },
    issue: (source, args, ctx, variables, varDefs) => {
      const number = argNumber(args, 'number', variables, varDefs, 0);
      const issue = (source.repo as Repo).issues.get(number);
      return issue ? issueSource(source.repo as Repo, issue) : null;
    },
    issues: (source, args, ctx, variables, varDefs) => {
      const repo = source.repo as Repo;
      const sorted = sortIssues([...repo.issues.values()], args, variables, varDefs);
      return connectionSource('IssueConnection', paginate(sorted.map((issue) => issueSource(repo, issue)), args, variables, varDefs));
    },
    pullRequest: (source, args, ctx, variables, varDefs) => {
      const number = argNumber(args, 'number', variables, varDefs, 0);
      const pull = (source.repo as Repo).pulls.get(number);
      return pull ? pullSource(source.repo as Repo, pull) : null;
    },
    pullRequests: (source, args, ctx, variables, varDefs) => {
      const repo = source.repo as Repo;
      const sorted = sortPulls([...repo.pulls.values()], args, variables, varDefs);
      return connectionSource('PullRequestConnection', paginate(sorted.map((pull) => pullSource(repo, pull)), args, variables, varDefs));
    },
  },
  Issue: {
    id: (source) => issueNodeId(source.repo as Repo, source.issue as Issue),
    databaseId: (source) => (source.issue as Issue).id,
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    body: (source) => (source.issue as Issue).body,
    state: (source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (source) => itemCreatedAt((source.issue as Issue).createdSeq),
    updatedAt: (source) => itemCreatedAt((source.issue as Issue).createdSeq),
    closedAt: (source) => (source.issue as Issue).closedAt,
    author: (source, _args, ctx) => userSource(ctx),
    repository: (source) => repoSource(source.repo as Repo),
    url: (source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    comments: (source, args, ctx, variables, varDefs) => {
      const issue = source.issue as Issue;
      const nodes = issue.comments.map((comment) => ({ __typename: 'IssueComment', repo: source.repo, issue, comment }));
      return connectionSource('IssueCommentConnection', paginate(nodes, args, variables, varDefs));
    },
    labels: (source, args, ctx, variables, varDefs) => {
      const issue = source.issue as Issue;
      const nodes = issue.labels.map((name) => ({ __typename: 'Label', name, color: 'ededed' }));
      return connectionSource('LabelConnection', paginate(nodes, args, variables, varDefs));
    },
  },
  PullRequest: {
    id: (source) => pullNodeId(source.repo as Repo, source.pull as Pull),
    databaseId: (source) => (source.pull as Pull).id,
    number: (source) => (source.pull as Pull).number,
    title: (source) => (source.pull as Pull).title,
    body: (source) => (source.pull as Pull).body,
    state: (source) => ((source.pull as Pull).state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: (source) => (source.pull as Pull).merged,
    mergeable: (source, _args, ctx) => {
      const pull = source.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.store.mergeable(pull.headSha, pull.baseSha);
    },
    headRefName: (source) => (source.pull as Pull).headRef,
    baseRefName: (source) => (source.pull as Pull).baseRef,
    headRefOid: (source) => (source.pull as Pull).headSha,
    baseRefOid: (source) => (source.pull as Pull).baseSha,
    createdAt: (source) => itemCreatedAt((source.pull as Pull).createdSeq),
    updatedAt: (source) => itemCreatedAt((source.pull as Pull).createdSeq),
    closedAt: (source) => {
      const pull = source.pull as Pull;
      return pull.state === 'closed' ? pull.mergedAt : null;
    },
    mergedAt: (source) => (source.pull as Pull).mergedAt,
    author: (source, _args, ctx) => userSource(ctx),
    repository: (source) => repoSource(source.repo as Repo),
    url: (source) => {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    files: (source, args, ctx, variables, varDefs) => {
      const pull = source.pull as Pull;
      const nodes = filesOf(ctx, pull).map((file) => ({ __typename: 'PullRequestFile', file }));
      return connectionSource('FileConnection', paginate(nodes, args, variables, varDefs));
    },
  },
  IssueConnection: {
    nodes: (source) => (source.page as Page<Source>).nodes,
    edges: (source) => (source.page as Page<Source>).edges.map((edge) => ({ __typename: 'IssueEdge', node: edge.node, cursor: edge.cursor })),
    pageInfo: (source) => ({ __typename: 'PageInfo', ...(source.page as Page<Source>).pageInfo }),
    totalCount: (source) => (source.page as Page<Source>).totalCount,
  },
  PullRequestConnection: {
    nodes: (source) => (source.page as Page<Source>).nodes,
    edges: (source) => (source.page as Page<Source>).edges.map((edge) => ({ __typename: 'PullRequestEdge', node: edge.node, cursor: edge.cursor })),
    pageInfo: (source) => ({ __typename: 'PageInfo', ...(source.page as Page<Source>).pageInfo }),
    totalCount: (source) => (source.page as Page<Source>).totalCount,
  },
  IssueCommentConnection: {
    nodes: (source) => (source.page as Page<Source>).nodes,
    edges: (source) => (source.page as Page<Source>).edges.map((edge) => ({ __typename: 'IssueCommentEdge', node: edge.node, cursor: edge.cursor })),
    pageInfo: (source) => ({ __typename: 'PageInfo', ...(source.page as Page<Source>).pageInfo }),
    totalCount: (source) => (source.page as Page<Source>).totalCount,
  },
  LabelConnection: {
    nodes: (source) => (source.page as Page<Source>).nodes,
    edges: (source) => (source.page as Page<Source>).edges.map((edge) => ({ __typename: 'LabelEdge', node: edge.node, cursor: edge.cursor })),
    pageInfo: (source) => ({ __typename: 'PageInfo', ...(source.page as Page<Source>).pageInfo }),
    totalCount: (source) => (source.page as Page<Source>).totalCount,
  },
  FileConnection: {
    nodes: (source) => (source.page as Page<Source>).nodes,
    edges: (source) => (source.page as Page<Source>).edges.map((edge) => ({ __typename: 'FileEdge', node: edge.node, cursor: edge.cursor })),
    pageInfo: (source) => ({ __typename: 'PageInfo', ...(source.page as Page<Source>).pageInfo }),
    totalCount: (source) => (source.page as Page<Source>).totalCount,
  },
  IssueEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => source.cursor as string,
  },
  PullRequestEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => source.cursor as string,
  },
  IssueCommentEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => source.cursor as string,
  },
  LabelEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => source.cursor as string,
  },
  FileEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => source.cursor as string,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage as boolean,
    hasPreviousPage: (source) => source.hasPreviousPage as boolean,
    startCursor: (source) => source.startCursor as string | null,
    endCursor: (source) => source.endCursor as string | null,
  },
  Ref: {
    name: (source) => source.name as string,
  },
  IssueComment: {
    id: (source) => commentNodeId(source.comment as { id: number }),
    databaseId: (source) => (source.comment as { id: number }).id,
    body: (source) => (source.comment as { body: string }).body,
    author: (source, _args, ctx) => userSource(ctx),
  },
  Label: {
    id: (source) => b64(`Label:${source.name as string}`),
    name: (source) => source.name as string,
    color: (source) => source.color as string,
  },
  PullRequestFile: {
    path: (source) => (source.file as ChangedFile).filename,
    additions: (source) => (source.file as ChangedFile).additions,
    deletions: (source) => (source.file as ChangedFile).deletions,
    status: (source) => (source.file as ChangedFile).status,
  },
  CreateIssuePayload: {
    issue: (source) => source.issue as Source,
    clientMutationId: (source) => source.clientMutationId as string | null,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue as Source,
    clientMutationId: (source) => source.clientMutationId as string | null,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Source,
    clientMutationId: (source) => source.clientMutationId as string | null,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Source,
    clientMutationId: (source) => source.clientMutationId as string | null,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge as Source,
    subject: (source) => source.subject as Source,
    clientMutationId: (source) => source.clientMutationId as string | null,
  },
  __Type: {
    name: (source) => source.name as string,
    kind: (source) => source.kind as string,
    description: () => null,
    fields: (source) => (source.fields as string[] | null)?.map((name) => ({ __typename: '__Field', name })) ?? null,
    enumValues: (source) => (source.enumValues as string[] | null)?.map((name) => ({ __typename: '__EnumValue', name })) ?? null,
  },
  __Field: {
    name: (source) => source.name as string,
    description: () => null,
    args: () => [],
    type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR' }),
  },
  __EnumValue: {
    name: (source) => source.name as string,
    description: () => null,
  },
  __Schema: {
    queryType: (source) => ({ __typename: '__Type', name: 'Query', kind: 'OBJECT', fields: null, enumValues: null }),
    mutationType: (source) => ({ __typename: '__Type', name: 'Mutation', kind: 'OBJECT', fields: null, enumValues: null }),
    types: () => [],
  },
};

// ---------------------------------------------------------------------------
// introspection
// ---------------------------------------------------------------------------

const INTROSPECTION: Record<string, Source> = {
  Issue: { __typename: '__Type', name: 'Issue', kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: null },
  PullRequest: {
    __typename: '__Type',
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    enumValues: null,
  },
  Repository: {
    __typename: '__Type',
    name: 'Repository',
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: null,
  },
  SearchType: {
    __typename: '__Type',
    name: 'SearchType',
    kind: 'ENUM',
    fields: null,
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  },
  User: { __typename: '__Type', name: 'User', kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: null },
  Query: { __typename: '__Type', name: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'], enumValues: null },
  Mutation: {
    __typename: '__Type',
    name: 'Mutation',
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: null,
  },
};

function introspectType(name: string): Source | null {
  return INTROSPECTION[name] ?? null;
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function executeSelections(
  source: Source,
  selections: Selection[],
  ctx: Ctx,
  variables: Record<string, unknown>,
  varDefs: Map<string, { defaultValue: Value | null }>,
  fragments: Map<string, Selection[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && selection.typeCondition !== source.__typename) continue;
      Object.assign(out, executeSelections(source, selection.selections, ctx, variables, varDefs, fragments));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (!fragment) throw new GqlError(`Unknown fragment "${selection.name}".`);
      Object.assign(out, executeSelections(source, fragment, ctx, variables, varDefs, fragments));
      continue;
    }
    const { alias, name, args, selections: sub } = selection;
    if (name === '__typename') {
      out[alias] = source.__typename;
      continue;
    }
    const typeFields = FIELDS[source.__typename];
    const fn = typeFields?.[name];
    if (!fn) throw new GqlError(`Cannot query field "${name}" on type "${source.__typename}".`);
    const value = fn(source, args, ctx, variables, varDefs);
    if (sub.length === 0) {
      out[alias] = value;
    } else if (value === null || value === undefined) {
      out[alias] = null;
    } else if (Array.isArray(value)) {
      out[alias] = value.map((entry) => {
        if (entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)) {
          return executeSelections(entry as Source, sub, ctx, variables, varDefs, fragments);
        }
        return entry;
      });
    } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[alias] = executeSelections(value as Source, sub, ctx, variables, varDefs, fragments);
    } else {
      throw new GqlError(`Field "${name}" on type "${source.__typename}" must not have a selection since type "${typeof value}" has no subfields.`);
    }
  }
  return out;
}

function runOperation(body: unknown, ctx: Ctx): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query field.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? record.variables : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error.' }] };
  }
  const operation =
    operationName !== null
      ? document.operations.find((op) => op.name === operationName)
      : document.operations.length === 1
        ? document.operations[0]
        : document.operations.find((op) => op.name === null);
  if (!operation) {
    return { data: null, errors: [{ message: operationName !== null ? `Unknown operation named "${operationName}".` : 'Must provide an operation name if there are multiple operations.' }] };
  }
  try {
    const root: Source = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
    const data = executeSelections(root, operation.selections, ctx, variables, operation.varDefs, document.fragments);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

export function graphql(ctx: Ctx): void {
  if (!authed(ctx)) {
    sendErr(ctx, 401, 'Requires authentication');
    return;
  }
  if (ctx.jsonBad) {
    sendErr(ctx, 400, 'Invalid JSON');
    return;
  }
  const body = ctx.json;
  if (Array.isArray(body)) {
    sendObj(ctx, 200, body.map((entry) => runOperation(entry, ctx)));
    return;
  }
  sendObj(ctx, 200, runOperation(body, ctx));
}
