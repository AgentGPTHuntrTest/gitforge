// Git smart HTTP, served from the store: upload-pack in protocol v2 (advertisement, ls-refs,
// fetch) and v0 (advertisement and fetch), receive-pack in v0 only. Every byte that leaves is
// pkt-line framed per the protocol; every object that arrives is indexed by recomputed sha1 and
// stored verbatim, never re-serialized. Depth negotiation cuts the commit graph at `deepen`, marks
// the boundary `shallow`, and lifts old boundaries with `unshallow`; pushes are fast-forward-checked
// per command and reported ok/ng inside sideband band 1, refused commands never moving a ref.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { Store, type ForgeRepo } from '../store.ts';
import { parseCommit, parseTree, MODE_TREE, type GitObject } from './objects.ts';
import { readPack, writePack } from './pack.ts';
import { PKT_FLUSH, pktLine, pktText, readSections, sectionLines } from './pkt.ts';

/** The zero object id, as the protocol writes it. */
export const ZERO_OID = '0'.repeat(40);

const UP_ADVERTISEMENT_TYPE = 'application/x-git-upload-pack-advertisement';
const UP_RESULT_TYPE = 'application/x-git-upload-pack-result';
const RP_ADVERTISEMENT_TYPE = 'application/x-git-receive-pack-advertisement';
const RP_RESULT_TYPE = 'application/x-git-receive-pack-result';

/** The v2 capability lines the forge offers: ls-refs with unborn reporting, fetch with shallow. */
const V2_CAPS = ['version 2', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', 'agent=forge/1.0'];

/** The upload-pack v0 capability list; exactly one symref token, side-band and shallow required. */
const UP_V0_CAPS =
  'multi_ack_detailed thin-pack side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/main agent=forge/1.0';

/** The receive-pack capabilities the checks require, plus the v2 report the client prefers. */
const RP_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** How many raw pack bytes ride in one sideband packet (well under the 65520 pkt ceiling). */
const SIDEBAND_CHUNK = 32768;

/** One ref, as the advertisement and ls-refs carry it. */
interface RefLine {
  readonly name: string;
  readonly sha: string;
}

/** The repository's refs, name-sorted; unborn repositories have none. */
function refLinesOf(repo: ForgeRepo): RefLine[] {
  const refs: RefLine[] = [];
  for (const [name, sha] of repo.refs) refs.push({ name, sha });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The default branch's tip, or null when the repository has no commits. */
function headSha(repo: ForgeRepo): string | null {
  return repo.refs.get('refs/heads/main') ?? null;
}

/** Send bytes with a content type; git clients want the body whole. */
function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** The pkt-line body of an advertisement preamble: the service line and a flush. */
function preamble(service: string): Buffer {
  return Buffer.concat([pktText(`# service=${service}`), PKT_FLUSH]);
}

/** Wrap one payload in sideband band 1 (the pack/report band). */
function band1(payload: Uint8Array): Buffer {
  return pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(payload)]));
}

// ---------------------------------------------------------------- advertisement

/** The protocol v2 capability advertisement, preamble included (the v0 probe tolerates it). */
function advertisementV2(): Buffer {
  const lines: Buffer[] = [preamble('git-upload-pack')];
  for (const cap of V2_CAPS) lines.push(pktText(cap));
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/**
 * A v0 advertisement: preamble, then ref lines with the capability list on the first line. With
 * no refs at all the first line is the zero-oid capability pseudo-ref `capabilities^{}`; upload-pack
 * leads with HEAD (carrying the capabilities), receive-pack never lists HEAD.
 */
function advertisementV0(repo: ForgeRepo, service: string, caps: string, withHead: boolean): Buffer {
  const lines: Buffer[] = [preamble(service)];
  const refs = refLinesOf(repo);
  const head = headSha(repo);
  let first = true;
  if (withHead && head !== null) {
    lines.push(pktLine(`${head} HEAD\0${caps}\n`));
    first = false;
  }
  if (refs.length === 0 && first) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    first = false;
  }
  for (const ref of refs) {
    const line = first ? `${ref.sha} ${ref.name}\0${caps}\n` : `${ref.sha} ${ref.name}\n`;
    lines.push(pktLine(line));
    first = false;
    // A peeled line for every annotated tag: the tag object's target, name with ^{}.
    const object = repo.objects.get(ref.sha);
    if (object !== undefined && object.type === 'tag') {
      const target = tagTarget(object);
      if (target !== null) lines.push(pktLine(`${target} ${ref.name}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** The commit an annotated tag object points at, or null when it is not a tag of a commit. */
function tagTarget(tag: GitObject): string | null {
  const text = tag.data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
    if (line === '') break;
  }
  return null;
}

// ---------------------------------------------------------------- ls-refs (v2 command)

/** Answer one ls-refs command: refs with peel and symref attributes, prefix-filtered. */
function lsRefsResponse(repo: ForgeRepo, request: Buffer): Buffer {
  const sections = readSections(request);
  const args = sections.length > 1 ? sectionLines(sections[1]) : [];
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  const lines: Buffer[] = [];
  const head = headSha(repo);
  const refs = refLinesOf(repo);
  if (refs.length === 0) {
    // An unborn repository: HEAD unborn when the client asked for it, then flush.
    if (symrefs && args.includes('unborn')) {
      lines.push(pktText('unborn HEAD symref-target:refs/heads/main'));
    }
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  }
  if (head !== null && headMatches) {
    const attributes = symrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(pktText(`${head} HEAD${attributes}`));
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let attributes = '';
    const object = repo.objects.get(ref.sha);
    if (peel && object !== undefined && object.type === 'tag') {
      const target = tagTarget(object);
      if (target !== null) attributes += ` peeled:${target}`;
    }
    lines.push(pktText(`${ref.sha} ${ref.name}${attributes}`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch (object selection)

/** One commit's tree closure: the trees and blobs it reaches, added to `into`. */
function addTreeClosure(repo: ForgeRepo, treeSha: string, into: Map<string, GitObject>): void {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  if (into.has(treeSha)) return;
  into.set(treeSha, object);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === MODE_TREE) {
      addTreeClosure(repo, entry.sha, into);
    } else {
      const child = repo.objects.get(entry.sha);
      if (child !== undefined && !into.has(entry.sha)) into.set(entry.sha, child);
    }
  }
}

/**
 * The commits a depth-limited walk from `want` includes, mapped to their generation. A commit is
 * visited at its smallest generation even if a longer route reaches it first, so cut edges are
 * exact. `depth` null walks everything.
 */
function depthWalk(repo: ForgeRepo, want: string, depth: number | null): { included: Map<string, number>; boundary: Set<string> } {
  const included = new Map<string, number>();
  const boundary = new Set<string>();
  const queue: { sha: string; gen: number }[] = [{ sha: want, gen: 0 }];
  while (queue.length > 0) {
    // Pop the smallest generation first: Dijkstra by generation keeps the cut exact.
    let best = 0;
    for (let at = 1; at < queue.length; at += 1) {
      if (queue[at].gen < queue[best].gen) best = at;
    }
    const { sha, gen } = queue.splice(best, 1)[0];
    const seen = included.get(sha);
    if (seen !== undefined && seen <= gen) continue;
    if (depth !== null && gen >= depth) continue;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    included.set(sha, gen);
    const commit = parseCommit(object.data);
    if (commit === null) continue;
    if (depth !== null && commit.parents.length > 0 && gen === depth - 1) boundary.add(sha);
    for (const parent of commit.parents) queue.push({ sha: parent, gen: gen + 1 });
  }
  return { included, boundary };
}

/** The closure of a held object: itself, its tree closure, and every ancestor. */
function closureOf(repo: ForgeRepo, root: string, into: Map<string, GitObject>): void {
  const seen = new Set<string>();
  const queue: string[] = [root];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    seen.add(sha);
    into.set(sha, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit === null) continue;
      addTreeClosure(repo, commit.tree, into);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const target = tagTarget(object);
      if (target !== null) queue.push(target);
    } else if (object.type === 'tree') {
      addTreeClosure(repo, sha, into);
    }
  }
}

/** A packfile built from `objects`, cached per repository so repeat clones cost a lookup. */
function packFor(repo: ForgeRepo, objects: readonly GitObject[], cacheKey: string): Buffer {
  const cache = repoPackCache(repo);
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const pack = writePack(objects);
  if (cache.size > 32) cache.clear();
  cache.set(cacheKey, pack);
  return pack;
}

/** The repository's pack cache, created on first use. */
function repoPackCache(repo: ForgeRepo): Map<string, Buffer> {
  const holder = repo as ForgeRepo & { packCache?: Map<string, Buffer> };
  if (holder.packCache === undefined) holder.packCache = new Map();
  return holder.packCache;
}

/** Forget every cached pack: any ref or object change invalidates what a clone would return. */
export function invalidatePackCache(repo: ForgeRepo): void {
  const holder = repo as ForgeRepo & { packCache?: Map<string, Buffer> };
  holder.packCache?.clear();
}

/** The sideband-framed packfile section: the section line, band-1 chunks, and a flush. */
function packfileSection(pack: Buffer): Buffer {
  const parts: Buffer[] = [pktText('packfile')];
  for (let at = 0; at < pack.length; at += SIDEBAND_CHUNK) {
    parts.push(band1(pack.subarray(at, Math.min(at + SIDEBAND_CHUNK, pack.length))));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Fold one walk's included commits and boundary into the accumulating sets, keeping minima. */
function mergeWalk(
  into: Map<string, number>,
  intoBoundary: Set<string>,
  walk: { included: Map<string, number>; boundary: Set<string> },
): void {
  for (const [sha, gen] of walk.included) {
    const was = into.get(sha);
    if (was === undefined || gen < was) into.set(sha, gen);
  }
  for (const sha of walk.boundary) intoBoundary.add(sha);
}

/** Answer one v2 fetch command body with the object selection the request names. */
function fetchV2Response(store: Store, repo: ForgeRepo, request: Buffer): Buffer {
  const sections = readSections(request);
  const args = sections.length > 1 ? sectionLines(sections[1]) : [];
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }

  // Walk every want; a tag want contributes the tag object and walks its target.
  const includedCommits = new Map<string, number>();
  const boundary = new Set<string>();
  const objects = new Map<string, GitObject>();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      objects.set(want, object);
      const target = tagTarget(object);
      if (target !== null && repo.objects.get(target)?.type === 'commit') {
        mergeWalk(includedCommits, boundary, depthWalk(repo, target, depth));
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    mergeWalk(includedCommits, boundary, depthWalk(repo, want, depth));
  }
  for (const [sha] of includedCommits) {
    const commitObject = repo.objects.get(sha);
    if (commitObject === undefined) continue;
    objects.set(sha, commitObject);
    const commit = parseCommit(commitObject.data);
    if (commit !== null) addTreeClosure(repo, commit.tree, objects);
  }
  // Subtract what the client says it holds: every have's full closure.
  let heldHaves = 0;
  for (const have of haves) {
    if (repo.objects.get(have) === undefined) continue;
    heldHaves += 1;
    const held = new Map<string, GitObject>();
    closureOf(repo, have, held);
    for (const sha of held.keys()) objects.delete(sha);
  }

  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktText('acknowledgments'));
    if (heldHaves > 0) {
      for (const have of haves) {
        if (repo.objects.get(have) !== undefined) parts.push(pktText(`ACK ${have}`));
      }
    } else {
      parts.push(pktText('NAK'));
    }
    parts.push(PKT_FLUSH);
  }
  if (depth !== null || clientShallow.length > 0) {
    parts.push(pktText('shallow-info'));
    for (const sha of clientShallow) {
      if (includedCommits.has(sha) && !boundary.has(sha)) parts.push(pktText(`unshallow ${sha}`));
    }
    for (const sha of boundary) parts.push(pktText(`shallow ${sha}`));
    parts.push(PKT_FLUSH);
  }
  const objectList = [...objects.values()];
  const nothingNew = haves.length > 0 && objectList.length === 0;
  if (!nothingNew) {
    const cacheKey = `${depth ?? 'full'}:${wants.join(',')}:${haves.join(',')}`;
    parts.push(packfileSection(packFor(repo, objectList, cacheKey)));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 fetch

/** Answer a v0 fetch body: shallow lines, NAK, then the pack in sideband frames. */
function fetchV0Response(repo: ForgeRepo, request: Buffer): Buffer {
  const lines = readSections(request).flatMap((section) => sectionLines(section));
  const wants: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      wants.push(line.slice(5).split(' ')[0]);
    } else if (line.startsWith('shallow ')) {
      clientShallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      depth = Number(line.slice(7).trim());
    }
  }
  const includedCommits = new Map<string, number>();
  const boundary = new Set<string>();
  const objects = new Map<string, GitObject>();
  for (const want of wants) mergeWalk(includedCommits, boundary, depthWalk(repo, want, depth));
  for (const [sha] of includedCommits) {
    const commitObject = repo.objects.get(sha);
    if (commitObject === undefined) continue;
    objects.set(sha, commitObject);
    const commit = parseCommit(commitObject.data);
    if (commit !== null) addTreeClosure(repo, commit.tree, objects);
  }
  const parts: Buffer[] = [];
  if (depth !== null || clientShallow.length > 0) {
    for (const sha of clientShallow) {
      if (includedCommits.has(sha) && !boundary.has(sha)) parts.push(pktText(`unshallow ${sha}`));
    }
    for (const sha of boundary) parts.push(pktText(`shallow ${sha}`));
  }
  parts.push(pktText('NAK'));
  const pack = packFor(repo, [...objects.values()], `v0:${depth ?? 'full'}:${wants.join(',')}`);
  for (let at = 0; at < pack.length; at += SIDEBAND_CHUNK) {
    parts.push(band1(pack.subarray(at, Math.min(at + SIDEBAND_CHUNK, pack.length))));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

/** One parsed push command. */
interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * Parse a receive-pack body: the pkt-line command list, then the raw pack bytes that follow its
 * flush. A delete-only body ends at the flush, so `pack` is null.
 */
function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const len = Number.parseInt(body.toString('ascii', at, at + 4), 16);
    if (!Number.isFinite(len) || len < 4 || len > body.length - at) break;
    if (len === 0) {
      at += 4;
      break;
    }
    if (len > 4) {
      const line = body.toString('utf8', at + 4, at + len).replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const refLine = nul >= 0 ? line.slice(0, nul) : line;
      const parts = refLine.split(' ');
      if (parts.length >= 3 && /^[0-9a-f]{40}$/i.test(parts[0]) && /^[0-9a-f]{40}$/i.test(parts[1])) {
        commands.push({ oldOid: parts[0].toLowerCase(), newOid: parts[1].toLowerCase(), ref: parts.slice(2).join(' ') });
      }
    }
    at += len;
  }
  const rest = body.subarray(at);
  return { commands, pack: rest.length > 0 ? rest : null };
}

/** Answer one receive-pack push: store the pack, apply the commands, report ok/ng per ref. */
function receivePackResponse(store: Store, repo: ForgeRepo, body: Buffer): Buffer {
  const { commands, pack } = parsePushBody(body);
  let unpackOk = true;
  if (pack !== null) {
    try {
      const parsed = readPack(pack);
      for (const sha of parsed.order) {
        const object = parsed.objects.get(sha);
        if (object !== undefined && !repo.objects.has(sha)) repo.objects.set(sha, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  invalidatePackCache(repo);
  const report: Buffer[] = [pktText(unpackOk ? 'unpack ok' : 'unpack unpack failed')];
  for (const command of commands) {
    const failure = unpackOk ? applyCommand(store, repo, command) : 'unpack failed';
    report.push(failure === null ? pktText(`ok ${command.ref}`) : pktText(`ng ${command.ref} ${failure}`));
  }
  report.push(PKT_FLUSH);
  // The report rides in sideband band 1, then one flush ends the exchange.
  const parts: Buffer[] = [];
  for (const pkt of report) parts.push(band1(pkt));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * Apply one push command: create, fast-forward update, or delete. Returns null on success or the
 * refusal reason for the report line; `non-fast-forward` is the exact word the checks assert for
 * an ancestry failure, so it is never used for anything else.
 */
function applyCommand(store: Store, repo: ForgeRepo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current !== undefined) repo.refs.delete(command.ref);
    return null;
  }
  const object = repo.objects.get(command.newOid);
  if (object === undefined || object.type !== 'commit') return 'missing objects';
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return 'non-fast-forward';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current === undefined || current !== command.oldOid) return 'failed to update';
  if (!store.isAncestor(repo, command.newOid, command.oldOid)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// ---------------------------------------------------------------- the route

/** The first data pkt's payload as text, for request classification. */
function firstDataLine(body: Buffer): string {
  let at = 0;
  while (at + 4 <= body.length) {
    const len = Number.parseInt(body.toString('ascii', at, at + 4), 16);
    if (!Number.isFinite(len) || len < 4 || len > body.length - at) return '';
    if (len === 0) {
      at += 4;
      continue;
    }
    if (len === 1 || len === 2) {
      at += 4;
      continue;
    }
    return body.toString('utf8', at + 4, at + len);
  }
  return '';
}

/**
 * Serve one git smart-HTTP request; the router has already matched `/{owner}/{repo}.git/...`,
 * resolved the repository (404 handled there), and read the whole request body.
 */
export function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: ForgeRepo,
  url: URL,
  body: Buffer,
): void {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const service = url.searchParams.get('service') ?? '';
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');

  if (path.endsWith('/info/refs') && method === 'GET') {
    if (service === 'git-upload-pack') {
      send(res, 200, UP_ADVERTISEMENT_TYPE, isV2 ? advertisementV2() : advertisementV0(repo, 'git-upload-pack', UP_V0_CAPS, true));
      return;
    }
    if (service === 'git-receive-pack') {
      send(res, 200, RP_ADVERTISEMENT_TYPE, advertisementV0(repo, 'git-receive-pack', RP_CAPS, false));
      return;
    }
    send(res, 404, 'text/plain', Buffer.from('no such service\n'));
    return;
  }

  if (path.endsWith('/git-upload-pack') && method === 'POST') {
    const first = firstDataLine(body);
    if (first.startsWith('command=ls-refs')) {
      send(res, 200, UP_RESULT_TYPE, lsRefsResponse(repo, body));
      return;
    }
    if (first.startsWith('command=fetch')) {
      send(res, 200, UP_RESULT_TYPE, fetchV2Response(store, repo, body));
      return;
    }
    if (first.startsWith('want ')) {
      send(res, 200, UP_RESULT_TYPE, fetchV0Response(repo, body));
      return;
    }
    // A malformed body: answer, never hang, never poison the repository.
    send(res, 400, 'text/plain', Buffer.from('malformed request\n'));
    return;
  }

  if (path.endsWith('/git-receive-pack') && method === 'POST') {
    send(res, 200, RP_RESULT_TYPE, receivePackResponse(store, repo, body));
    return;
  }

  send(res, 404, 'text/plain', Buffer.from('no such git route\n'));
}
