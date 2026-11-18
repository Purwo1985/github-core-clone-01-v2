// The HTTP layer: a pre-compiled route trie over (method, path segments),
// one small request context, and the JSON reply helpers. Routes are
// registered once at boot; dispatch walks the trie in O(segments) with no
// regex and no per-request route table scan.
//
// A trailing `*` segment captures the rest of the path (a contents path),
// and a `:name` segment captures one segment.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  segments: string[];
  /** The `:name` / `*` captures, by name. */
  params: Map<string, string>;
  query: URLSearchParams;
  /** The raw request body, when one was read. */
  body: Buffer | null;
  /** Parsed JSON body, when the content was JSON and parsed cleanly. */
  json: unknown;
  jsonBad: boolean;
  /** The bearer token presented, or ''. */
  token: string;
  reqId: string;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

interface TrieNode {
  literal: Map<string, TrieNode>;
  param: { name: string; node: TrieNode } | null;
  star: { name: string; node: TrieNode } | null;
  handlers: Map<string, Handler>;
}

function newNode(): TrieNode {
  return { literal: new Map(), param: null, star: null, handlers: new Map() };
}

export class Router {
  #root = newNode();

  add(method: string, pattern: string, handler: Handler): void {
    const segments = pattern.split('/').filter((segment) => segment !== '');
    let node = this.#root;
    for (const segment of segments) {
      if (segment === '*') {
        if (!node.star) node.star = { name: '*', node: newNode() };
        node = node.star.node;
        break;
      }
      if (segment.startsWith(':')) {
        if (!node.param) node.param = { name: segment.slice(1), node: newNode() };
        node = node.param.node;
        continue;
      }
      let child = node.literal.get(segment);
      if (!child) {
        child = newNode();
        node.literal.set(segment, child);
      }
      node = child;
    }
    node.handlers.set(method, handler);
  }

  match(method: string, segments: readonly string[]): { handler: Handler; params: Map<string, string> } | null {
    const params = new Map<string, string>();
    let node = this.#root;
    let i = 0;
    while (i < segments.length) {
      const segment = segments[i] as string;
      const literal = node.literal.get(segment);
      if (literal) {
        node = literal;
        i += 1;
        continue;
      }
      if (node.param) {
        params.set(node.param.name, segment);
        node = node.param.node;
        i += 1;
        continue;
      }
      if (node.star) {
        params.set('*', segments.slice(i).join('/'));
        node = node.star.node;
        i = segments.length;
        break;
      }
      return null;
    }
    const handler = node.handlers.get(method);
    if (!handler) return null;
    return { handler, params };
  }

  /** True when the path exists under any method (for 405-free 404 handling). */
  hasPath(segments: readonly string[]): boolean {
    let node = this.#root;
    let i = 0;
    while (i < segments.length) {
      const segment = segments[i] as string;
      const literal = node.literal.get(segment);
      if (literal) {
        node = literal;
        i += 1;
        continue;
      }
      if (node.param) {
        node = node.param.node;
        i += 1;
        continue;
      }
      if (node.star) {
        node = node.star.node;
        i = segments.length;
        break;
      }
      return false;
    }
    return node.handlers.size > 0;
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';

let reqCounter = 0;

export function sendJson(ctx: Ctx, status: number, body: string, extra: Record<string, string> = {}): void {
  const res = ctx.res;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': ctx.reqId,
    ...extra,
  });
  res.end(body);
}

export function sendObj(ctx: Ctx, status: number, value: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx, status, JSON.stringify(value), extra);
}

export function sendErr(ctx: Ctx, status: number, message: string): void {
  sendObj(ctx, status, { message });
}

export function sendBytes(ctx: Ctx, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  const res = ctx.res;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.reqId,
    ...extra,
  });
  res.end(body);
}

export function sendEmpty(ctx: Ctx, status: number, extra: Record<string, string> = {}): void {
  const res = ctx.res;
  res.writeHead(status, { 'x-github-request-id': ctx.reqId, ...extra });
  res.end();
}

/** The bearer token of a request, or ''. */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? (match[1] as string) : '';
}

const MAX_BODY = 32 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

/** Build the server around a router and a store. */
export function createHttpServer(store: Store, router: Router, onRequest: (ctx: Ctx) => Promise<void>): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const reqId = `req-${(++reqCounter).toString(16)}`;
      let pathname = '/';
      let search = '';
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        pathname = url.pathname;
        search = url.search;
      } catch {
        pathname = '/';
      }
      const segments = pathname.split('/').filter((segment) => segment !== '').map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
      const method = req.method ?? 'GET';
      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      let body: Buffer | null = null;
      let json: unknown = undefined;
      let jsonBad = false;
      if (needsBody) {
        try {
          body = await readBody(req);
        } catch {
          const ctx0: Ctx = {
            store, req, res, method, segments, params: new Map(), query: new URLSearchParams(search),
            body: null, json: undefined, jsonBad: true, token: bearerToken(req), reqId,
          };
          sendErr(ctx0, 413, 'Request body too large');
          return;
        }
        const contentType = req.headers['content-type'] ?? '';
        if (body.length > 0 && contentType.includes('application/json')) {
          try {
            json = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            jsonBad = true;
          }
        }
      }
      const ctx: Ctx = {
        store, req, res, method, segments,
        params: new Map(), query: new URLSearchParams(search),
        body, json, jsonBad, token: bearerToken(req), reqId,
      };
      const matched = router.match(method, segments);
      if (matched) {
        ctx.params = matched.params;
        try {
          await matched.handler(ctx);
        } catch (err) {
          if (!res.writableEnded) {
            sendErr(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
          }
        }
        return;
      }
      try {
        await onRequest(ctx);
      } catch (err) {
        if (!res.writableEnded) sendErr(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}

/** Split a path into segments, decoding each one. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}
