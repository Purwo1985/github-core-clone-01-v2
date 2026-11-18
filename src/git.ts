// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack
// and v0 receive-pack with side-band-64k and report-status. Packs are
// built by the store (cached per ask); advertisements and ls-refs rows are
// cached per repository ref version.

import {
  ZERO_OID,
  decodePktLines,
  isOid,
  packetTexts,
  pktLine,
  pktLines,
  readPack,
  type GitObject,
} from './objects.ts';
import { sendBytes, sendErr, sendJson, type Ctx } from './http.ts';
import type { Repo } from './store.ts';

const AGENT = 'forge-v2/1.0.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V2_CAPABILITIES =
  'version 2\n' +
  'ls-refs=unborn\n' +
  'fetch=shallow wait-for-done\n' +
  'server-option\n' +
  'object-format=sha1\n' +
  `agent=${AGENT}\n`;

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow object-format=sha1 agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** The v2 capability advertisement: the same bytes for every repository. */
const V2_ADVERTISEMENT = pktLines([V2_CAPABILITIES.split('\n').filter((line) => line !== '').map((line) => `${line}\n`), 'flush'].flat());

function authed(ctx: Ctx): boolean {
  if (ctx.store.token === '') return true;
  return ctx.token !== '' && ctx.token === ctx.store.token;
}

function lookupGitRepo(ctx: Ctx): Repo | null {
  const owner = ctx.params.get('owner') ?? '';
  let name = ctx.params.get('repo') ?? '';
  if (name.endsWith('.git')) name = name.slice(0, -4);
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    sendJson(ctx, 404, { message: 'Not Found' });
    return null;
  }
  return repo;
}

/** A v0 ref advertisement: service preamble, refs, capabilities on the first line. */
function v0Advertisement(ctx: Ctx, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = ctx.store.lsRefs(repo);
  const headOid = ctx.store.headOid(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headTarget = ctx.store.headTarget(repo);
    const first = headOid ? `${headOid} HEAD\0${caps}\n` : `${ZERO_OID} capabilities^{}\0${caps}\n`;
    lines.push(first);
    for (const row of refs) {
      if (row.name === 'HEAD') continue;
      lines.push(`${row.oid} ${row.name}\n`);
      if (row.peeled) lines.push(`${row.peeled} ${row.name}^{}\n`);
    }
    void headTarget;
  }
  lines.push('flush');
  return pktLines(lines);
}

export function infoRefs(ctx: Ctx): void {
  if (!authed(ctx)) {
    sendErr(ctx, 401, 'Requires authentication');
    return;
  }
  const service = ctx.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(ctx, 404, { message: 'Not Found' });
    return;
  }
  const repo = lookupGitRepo(ctx);
  if (!repo) return;
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    sendBytes(ctx, 200, V2_ADVERTISEMENT, UPLOAD_AD);
    return;
  }
  const body = v0Advertisement(ctx, repo, service);
  sendBytes(ctx, 200, body, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchAsk {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

/** Split a sideband payload into band-1 packets of at most 65515 data bytes. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function fetchV2(ctx: Ctx, repo: Repo, lines: readonly string[]): void {
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) ask.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) ask.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) ask.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) ask.depth = n;
    }
  }
  const { pack, shallowOut, unshallowOut } = ctx.store.fetchPack(repo, ask.wants, ask.haves, ask.depth, ask.shallow);
  const parts: Buffer[] = [];
  parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    const section: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of shallowOut) section.push(`shallow ${oid}\n`);
    for (const oid of unshallowOut) section.push(`unshallow ${oid}\n`);
    section.push('flush');
    parts.push(pktLines(section));
  }
  if (pack.length > 32) {
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(Buffer.from('0000', 'ascii'));
  }
  sendBytes(ctx, 200, Buffer.concat(parts), UPLOAD_RESULT);
}

function lsRefsV2(ctx: Ctx, repo: Repo, lines: readonly string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const headOid = ctx.store.headOid(repo);
  const headTarget = ctx.store.headTarget(repo);
  if (keep('HEAD')) {
    if (headOid) {
      out.push(symrefs ? `${headOid} HEAD symref-target:${headTarget}\n` : `${headOid} HEAD\n`);
    } else if (unborn) {
      out.push(`unborn HEAD symref-target:${headTarget}\n`);
    }
  }
  for (const row of ctx.store.lsRefs(repo)) {
    if (!keep(row.name)) continue;
    let line = `${row.oid} ${row.name}`;
    if (symrefs && row.symrefTarget) line += ` symref-target:${row.symrefTarget}`;
    if (peel && row.peeled) line += ` peeled:${row.peeled}`;
    out.push(`${line}\n`);
  }
  const body = pktLines([...out, 'flush']);
  sendBytes(ctx, 200, body, UPLOAD_RESULT);
}

function fetchV0(ctx: Ctx, repo: Repo, lines: readonly string[]): void {
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const first = text.slice(5).split(' ')[0] as string;
      if (isOid(first)) ask.wants.push(first);
    } else if (text.startsWith('have ')) ask.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) ask.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) ask.depth = n;
    }
  }
  const { pack, shallowOut, unshallowOut } = ctx.store.fetchPack(repo, ask.wants, ask.haves, ask.depth, ask.shallow);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  if (pack.length > 32) {
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  sendBytes(ctx, 200, Buffer.concat(parts), UPLOAD_RESULT);
}

export function uploadPack(ctx: Ctx): void {
  if (!authed(ctx)) {
    sendErr(ctx, 401, 'Requires authentication');
    return;
  }
  const repo = lookupGitRepo(ctx);
  if (!repo) return;
  const body = ctx.body ?? Buffer.alloc(0);
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    sendBytes(ctx, 400, Buffer.from('bad request', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const lines = packetTexts(packets);
  const first = (lines[0] ?? '').replace(/\n$/, '');
  const isV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2 && first === 'command=ls-refs') {
    lsRefsV2(ctx, repo, lines.slice(1));
    return;
  }
  if (isV2 && first === 'command=fetch') {
    fetchV2(ctx, repo, lines.slice(1));
    return;
  }
  if (!isV2 && lines.some((line) => line.startsWith('want '))) {
    fetchV0(ctx, repo, lines);
    return;
  }
  sendBytes(ctx, 400, Buffer.from('bad request', 'utf8'), 'text/plain; charset=utf-8');
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(ctx: Ctx): void {
  if (!authed(ctx)) {
    sendErr(ctx, 401, 'Requires authentication');
    return;
  }
  const repo = lookupGitRepo(ctx);
  if (!repo) return;
  const body = ctx.body ?? Buffer.alloc(0);
  let decoded;
  try {
    decoded = decodePktLines(body);
  } catch {
    sendBytes(ctx, 400, Buffer.from('bad request', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const lines = packetTexts(decoded.packets);
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  const packBytes = decoded.rest;
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updates = commands.filter((command) => command.newOid !== ZERO_OID);
  if (commands.length === 0) {
    sendBytes(ctx, 400, Buffer.from('bad request', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  // Unpack first: every object lands in the arena before any ref moves.
  if (updates.length > 0) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(packBytes, (oid) => ctx.store.getObject(oid));
        for (const [oid, object] of read.objects) {
          const existing = ctx.store.getObject(oid);
          if (!existing) ctx.store.objects.set(oid, object as GitObject);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  if (!unpackOk) {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
    report.unshift(`unpack ${unpackDetail}\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push(`ng ${command.ref} no such ref\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          ctx.store.deleteRef(repo, command.ref);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push(`ng ${command.ref} already exists\n`);
        } else {
          ctx.store.setRef(repo, command.ref, command.newOid);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Update: the old value must match, and the new tip must descend from it.
      if (current === undefined || current !== command.oldOid) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (!ctx.store.isAncestor(command.oldOid, command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        ctx.store.setRef(repo, command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      }
    }
  }
  const reportBuf = pktLines(report);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < reportBuf.length; off += CHUNK) {
    const slice = reportBuf.subarray(off, Math.min(reportBuf.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  sendBytes(ctx, 200, Buffer.concat(parts), RECEIVE_RESULT);
}
