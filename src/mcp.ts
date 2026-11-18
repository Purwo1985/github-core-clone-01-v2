// MCP (Model Context Protocol) over Streamable HTTP: JSON-RPC 2.0 on
// POST /mcp. Both the modern `server/discover` era (2026-07-28) and the
// legacy `initialize` handshake are served, and the tools act on the same
// store as REST and GraphQL, so a tool call is visible through every API.

import { sendEmpty, sendErr, sendObj, type Ctx } from './http.ts';
import { authed } from './rest.ts';
import type { Issue, Pull, Repo } from './store.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18', '2024-11-05'];

let sessionCounter = 0;

// ---------------------------------------------------------------------------
// tool definitions: the list response is a frozen constant, so two
// tools/list calls are byte-identical.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type RpcId = string | number | null;

function rpcResult(ctx: Ctx, id: RpcId, result: unknown): void {
  sendObj(ctx, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(ctx: Ctx, id: RpcId, code: number, message: string, httpStatus = 200): void {
  sendObj(ctx, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolText(ctx: Ctx, id: RpcId, payload: unknown): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  rpcResult(ctx, id, { content: [{ type: 'text', text }], structuredContent: payload });
}

function toolError(ctx: Ctx, id: RpcId, message: string): void {
  rpcResult(ctx, id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
}

function strArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Resolve a repository from owner+repo, or from a full_name fallback. */
function resolveRepo(ctx: Ctx, args: Record<string, unknown>): Repo | null {
  const owner = strArg(args, 'owner');
  const name = strArg(args, 'repo');
  if (owner !== '' && name !== '') {
    const repo = ctx.store.getRepo(owner, name);
    if (repo) return repo;
  }
  const fullName = strArg(args, 'full_name');
  const slash = fullName.indexOf('/');
  if (slash > 0) {
    return ctx.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1)) ?? null;
  }
  return null;
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueSummary(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullSummary(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: pull.headRef,
    base: pull.baseRef,
    merge_commit_sha: pull.mergeCommitSha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------

function callTool(ctx: Ctx, id: RpcId, params: unknown): void {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    rpcError(ctx, id, -32602, 'Invalid params: expected an object with name and arguments.');
    return;
  }
  const record = params as Record<string, unknown>;
  const rawName = typeof record.name === 'string' ? record.name : '';
  const args = (record.arguments !== null && typeof record.arguments === 'object' && !Array.isArray(record.arguments) ? record.arguments : {}) as Record<string, unknown>;
  // Tools may carry a server prefix; match by suffix, case-insensitively.
  const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === rawName.toLowerCase() || rawName.toLowerCase().endsWith(`_${candidate.name.toLowerCase()}`) || rawName.toLowerCase().endsWith(candidate.name.toLowerCase()));
  if (!tool) {
    rpcError(ctx, id, -32601, `Unknown tool: ${rawName}`);
    return;
  }
  const missing = tool.inputSchema.required.filter((field) => {
    const value = args[field];
    return value === undefined || value === null || value === '';
  });
  // full_name can stand in for owner+repo.
  const hasFullName = strArg(args, 'full_name') !== '';
  const missingReal = missing.filter((field) => !((field === 'owner' || field === 'repo') && hasFullName));
  if (missingReal.length > 0) {
    toolError(ctx, id, `Missing required argument(s): ${missingReal.join(', ')}`);
    return;
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const name = strArg(args, 'name');
        const description = strArg(args, 'description');
        const isPrivate = args.private === true;
        const existing = ctx.store.getRepo(ctx.store.viewer.login, name);
        if (existing) {
          toolError(ctx, id, `Repository ${ctx.store.viewer.login}/${name} already exists.`);
          return;
        }
        const repo = ctx.store.createRepo(ctx.store.viewer.login, name, isPrivate, description);
        toolText(ctx, id, repoSummary(repo));
        return;
      }
      case 'get_repo': {
        const repo = resolveRepo(ctx, args);
        if (!repo) {
          toolError(ctx, id, 'Repository not found.');
          return;
        }
        toolText(ctx, id, repoSummary(repo));
        return;
      }
      case 'create_issue': {
        const repo = resolveRepo(ctx, args);
        if (!repo) {
          toolError(ctx, id, 'Repository not found.');
          return;
        }
        const title = strArg(args, 'title');
        const body = strArg(args, 'body');
        const issue = ctx.store.createIssue(repo, title, body);
        toolText(ctx, id, issueSummary(repo, issue));
        return;
      }
      case 'list_issues': {
        const repo = resolveRepo(ctx, args);
        if (!repo) {
          toolError(ctx, id, 'Repository not found.');
          return;
        }
        const state = strArg(args, 'state') || 'open';
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => a.createdSeq - b.createdSeq)
          .map((issue) => issueSummary(repo, issue));
        toolText(ctx, id, { issues });
        return;
      }
      case 'get_issue': {
        const repo = resolveRepo(ctx, args);
        if (!repo) {
          toolError(ctx, id, 'Repository not found.');
          return;
        }
        const issue = repo.issues.get(numArg(args, 'issue_number'));
        if (!issue) {
          toolError(ctx, id, 'Issue not found.');
          return;
        }
        toolText(ctx, id, issueSummary(repo, issue));
        return;
      }
      case 'create_pull_request': {
        const repo = resolveRepo(ctx, args);
        if (!repo) {
          toolError(ctx, id, 'Repository not found.');
          return;
        }
        const pull = ctx.store.createPull(repo, strArg(args, 'title'), strArg(args, 'body'), strArg(args, 'head'), strArg(args, 'base'));
        if (!pull) {
          toolError(ctx, id, 'Could not create pull request: head or base branch does not exist, or a pull request already exists for this head.');
          return;
        }
        toolText(ctx, id, pullSummary(repo, pull));
        return;
      }
      case 'merge_pull_request': {
        const repo = resolveRepo(ctx, args);
        if (!repo) {
          toolError(ctx, id, 'Repository not found.');
          return;
        }
        const pull = repo.pulls.get(numArg(args, 'pull_number'));
        if (!pull) {
          toolError(ctx, id, 'Pull request not found.');
          return;
        }
        const mergeSha = ctx.store.mergePull(repo, pull);
        if (mergeSha === null) {
          toolError(ctx, id, 'Pull request cannot be merged.');
          return;
        }
        toolText(ctx, id, { merged: true, sha: mergeSha, ...pullSummary(repo, pull) });
        return;
      }
      default:
        rpcError(ctx, id, -32601, `Unknown tool: ${rawName}`);
    }
  } catch (err) {
    toolError(ctx, id, err instanceof Error ? err.message : 'Tool call failed.');
  }
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

export function mcp(ctx: Ctx): void {
  if (!authed(ctx)) {
    sendErr(ctx, 401, 'Requires authentication');
    return;
  }
  if (ctx.jsonBad || ctx.json === undefined) {
    rpcError(ctx, null, -32700, 'Parse error: request body is not valid JSON.', 400);
    return;
  }
  const body = ctx.json as Record<string, unknown>;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    rpcError(ctx, null, -32600, 'Invalid Request: expected a JSON-RPC object.');
    return;
  }
  const method = typeof body.method === 'string' ? body.method : '';
  const id: RpcId = body.id === undefined ? null : (body.id as string | number);
  const isNotification = body.id === undefined;
  if (method === '') {
    rpcError(ctx, id, -32600, 'Invalid Request: missing method.');
    return;
  }
  // Notifications (no id) are acknowledged with an empty 202.
  if (isNotification) {
    sendEmpty(ctx, 202);
    return;
  }
  switch (method) {
    case 'server/discover': {
      rpcResult(ctx, id, {
        supportedVersions: [...PROTOCOL_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return;
    }
    case 'initialize': {
      sessionCounter += 1;
      ctx.res.setHeader('Mcp-Session-Id', `forge-${sessionCounter}`);
      rpcResult(ctx, id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return;
    }
    case 'ping': {
      rpcResult(ctx, id, {});
      return;
    }
    case 'tools/list': {
      rpcResult(ctx, id, { tools: TOOLS });
      return;
    }
    case 'tools/call': {
      callTool(ctx, id, body.params);
      return;
    }
    default:
      rpcError(ctx, id, -32601, `Method not found: ${method}`);
  }
}
