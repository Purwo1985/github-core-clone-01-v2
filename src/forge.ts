// Wiring: one router holding every route (REST, git smart HTTP, GraphQL,
// MCP, health), and the unmatched-route fallback that always answers JSON
// 404 — never an HTML page, never a bare connection close.

import { createHttpServer, sendErr, sendObj, Router, type Ctx } from './http.ts';
import type { Store } from './store.ts';
import {
  apiMeta,
  apiRoot,
  createGitRef,
  createLabel,
  createRepo,
  deleteContents,
  deleteRepo,
  getBranch,
  getContents,
  getGitRef,
  getRepo,
  getUser,
  listBranches,
  listCommits,
  listLabels,
  listUserRepos,
  patchRepo,
  putContents,
} from './rest.ts';
import {
  createIssue,
  createIssueComment,
  createPull,
  getIssue,
  getPull,
  listIssueComments,
  listIssues,
  listPullFiles,
  listPulls,
  mergePull,
  patchIssue,
} from './rest2.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';
import type { Server } from 'node:http';

export function createApp(store: Store): Server {
  const router = new Router();

  router.add('GET', '/healthz', (ctx: Ctx) => {
    sendObj(ctx, 200, { ok: true });
  });

  // REST v3
  router.add('GET', '/api/v3/', apiRoot);
  router.add('GET', '/api/v3/meta', apiMeta);
  router.add('GET', '/api/v3/user', getUser);
  router.add('POST', '/api/v3/user/repos', createRepo);
  router.add('GET', '/api/v3/user/repos', listUserRepos);
  router.add('GET', '/api/v3/repos/:owner/:repo', getRepo);
  router.add('PATCH', '/api/v3/repos/:owner/:repo', patchRepo);
  router.add('DELETE', '/api/v3/repos/:owner/:repo', deleteRepo);
  router.add('GET', '/api/v3/repos/:owner/:repo/branches', listBranches);
  router.add('GET', '/api/v3/repos/:owner/:repo/branches/:branch', getBranch);
  router.add('GET', '/api/v3/repos/:owner/:repo/commits', listCommits);
  router.add('POST', '/api/v3/repos/:owner/:repo/git/refs', createGitRef);
  router.add('GET', '/api/v3/repos/:owner/:repo/git/refs/heads/:branch', getGitRef);
  router.add('GET', '/api/v3/repos/:owner/:repo/contents/*', getContents);
  router.add('PUT', '/api/v3/repos/:owner/:repo/contents/*', putContents);
  router.add('DELETE', '/api/v3/repos/:owner/:repo/contents/*', deleteContents);
  router.add('POST', '/api/v3/repos/:owner/:repo/labels', createLabel);
  router.add('GET', '/api/v3/repos/:owner/:repo/labels', listLabels);
  router.add('POST', '/api/v3/repos/:owner/:repo/issues', createIssue);
  router.add('GET', '/api/v3/repos/:owner/:repo/issues', listIssues);
  router.add('GET', '/api/v3/repos/:owner/:repo/issues/:number', getIssue);
  router.add('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', patchIssue);
  router.add('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', createIssueComment);
  router.add('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', listIssueComments);
  router.add('POST', '/api/v3/repos/:owner/:repo/pulls', createPull);
  router.add('GET', '/api/v3/repos/:owner/:repo/pulls', listPulls);
  router.add('GET', '/api/v3/repos/:owner/:repo/pulls/:number', getPull);
  router.add('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', listPullFiles);
  router.add('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', mergePull);

  // Git smart HTTP
  router.add('GET', '/:owner/:repo/info/refs', infoRefs);
  router.add('POST', '/:owner/:repo/git-upload-pack', uploadPack);
  router.add('POST', '/:owner/:repo/git-receive-pack', receivePack);

  // GraphQL and MCP
  router.add('POST', '/api/graphql', graphql);
  router.add('POST', '/mcp', mcp);

  return createHttpServer(store, router, async (ctx: Ctx) => {
    sendErr(ctx, 404, 'Not Found');
  });
}
