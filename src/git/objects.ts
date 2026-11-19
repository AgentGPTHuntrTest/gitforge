// Git's core object model: blob, tree, commit. A forge serves the wire protocol on its own store,
// so every object it keeps or hands out must hash and serialize exactly as git does: the sha1 of
// "<type> <size>\0<content>", tree entries in git's raw binary layout, commit headers in git's
// header order. No git binary exists in the trial, so this file *is* the object database's grammar.

import { createHash, hash as oneShotHash } from 'node:crypto';

/** The four object types a loose store holds; git's pack format numbers them 1..4 in this order. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** git's pack type numbers, in the order commit, tree, blob, tag. */
export const PACK_TYPE_OF: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

/** The type a pack type number names. */
export const TYPE_OF_PACK_NUMBER: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** One stored object: its type and its undecoded payload bytes. */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** The sha1 of an object as git computes it: over "<type> <size>\0" then the payload. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  // One-shot hashing where it exists: one digest call, no hash object created per entry.
  if (typeof oneShotHash === 'function') {
    return oneShotHash('sha1', Buffer.concat([header, data as Uint8Array], header.length + data.byteLength));
  }
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The sha1 of an already-stored object, cached by the store on write. */
export function hashStored(object: GitObject): string {
  return hashObject(object.type, object.data);
}

// ---------------------------------------------------------------- blobs

/** A blob is its bytes; this helper only exists so a store writer reads symmetrically. */
export function makeBlob(data: Uint8Array): GitObject {
  return { type: 'blob', data: Buffer.from(data) };
}

// ---------------------------------------------------------------- trees

/** One raw tree entry: the mode as git prints it, the name, and the target's hex sha. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/** git's mode strings, as tree entries and the REST contents API print them. */
export const MODE_FILE = '100644';
export const MODE_EXECUTABLE = '100755';
export const MODE_SYMLINK = '120000';
export const MODE_TREE = '040000';

/** Parse a raw tree: "<mode> <name>\0<20 raw sha bytes>" entries, in file order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < buf.length) {
    const space = buf.indexOf(0x20, at);
    if (space < 0) break;
    const nul = buf.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > buf.length) break;
    const mode = buf.toString('ascii', at, space);
    const name = buf.toString('utf8', space + 1, nul);
    const sha = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode: normalizeTreeMode(mode), name, sha });
    at = nul + 21;
  }
  return entries;
}

/**
 * git writes a tree entry's mode with no padding except the leading 1 of the file modes, so a
 * directory is "40000"; a store that round-trips trees should keep one canonical spelling per mode.
 */
export function normalizeTreeMode(mode: string): string {
  switch (mode) {
    case '100644':
    case '100755':
    case '120000':
    case '160000':
      return mode;
    case '40000':
    case '040000':
      return MODE_TREE;
    default:
      return mode;
  }
}

/** Serialize tree entries back to git's raw layout, name-sorted as git's tree order requires. */
export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const rawMode = entry.mode === MODE_TREE ? '40000' : entry.mode;
    parts.push(Buffer.from(`${rawMode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * git's tree sort: names compared as bytes, with one twist — a directory sorts as though its name
 * carried a trailing slash, so "foo" (file) sorts before "foo" (directory) which sorts as "foo/".
 */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const keyOf = (entry: TreeEntry): Buffer =>
    Buffer.from(entry.mode === MODE_TREE ? `${entry.name}/` : entry.name, 'utf8');
  return [...entries].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka.compare(kb) === 0 ? 0 : ka.compare(kb) < 0 ? -1 : 1;
  });
}

/** Hash tree entries into a stored tree object. */
export function makeTree(entries: readonly TreeEntry[]): GitObject {
  return { type: 'tree', data: serializeTree(entries) };
}

// ---------------------------------------------------------------- commits

/** One side of a commit's authorship, exactly as the header line carries it. */
export interface CommitPerson {
  readonly name: string;
  readonly email: string;
  readonly epochSec: number;
  /** The raw timezone string git wrote, like "+0000"; kept as written, never reinterpreted. */
  readonly tz: string;
}

/** A parsed commit: its tree, parents, authorship and message. */
export interface CommitObject {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: CommitPerson;
  readonly committer: CommitPerson;
  readonly message: string;
}

/** Format one person line: "Name <email> epoch tz". */
export function formatPerson(person: CommitPerson): string {
  return `${person.name} <${person.email}> ${person.epochSec} ${person.tz}`;
}

/** Parse one "Name <email> epoch tz" line into its parts. */
export function parsePerson(line: string): CommitPerson {
  const open = line.indexOf('<');
  const close = line.indexOf('>', open);
  const name = open > 0 ? line.slice(0, open).trimEnd() : line;
  const email = open >= 0 && close > open ? line.slice(open + 1, close) : '';
  const rest = close > 0 ? line.slice(close + 1).trim() : '';
  const parts = rest.split(/\s+/);
  const epochSec = parts.length > 0 && /^\d+$/.test(parts[0] ?? '') ? Number(parts[0]) : 0;
  const tz = parts.length > 1 && /^[+-]\d{4}$/.test(parts[1] ?? '') ? parts[1] : '+0000';
  return { name, email, epochSec, tz };
}

/** Parse a raw commit into its headers and message (headers before the first blank line). */
export function parseCommit(data: Uint8Array): CommitObject | null {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author: CommitPerson = { name: '', email: '', epochSec: 0, tz: '+0000' };
  let committer: CommitPerson = author;
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }
  if (tree === '') return null;
  return { tree, parents, author, committer, message };
}

/** Serialize a commit in git's header order: tree, parents, author, committer, blank, message. */
export function serializeCommit(commit: CommitObject): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatPerson(commit.author)}`);
  lines.push(`committer ${formatPerson(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** Hash commit fields into a stored commit object. */
export function makeCommit(commit: CommitObject): GitObject {
  return { type: 'commit', data: serializeCommit(commit) };
}

/** A commit's short sha, as REST listings print it: the first 7 hex characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
