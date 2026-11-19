// Squash merges and the tree arithmetic they need: a three-way rule the REST, GraphQL and MCP
// surfaces share. A pull's head and base are snapshotted when it opens, but mergeability is decided
// live against the base branch's current tip: the paths the head changed since the merge base must
// not be paths the base has changed since the same ancestor, or the merge is a conflict (405).

import { parseCommit, MODE_TREE } from './git/objects.ts';
import type { Store, ForgeRepo, ForgePull } from './store.ts';

/** A tree's files at one commit: path → {mode, sha}. */
export type TreeFiles = Map<string, { mode: string; sha: string }>;

/** The paths a commit tree changed relative to another, with the new state (null = removed). */
export interface TreeChange {
  readonly path: string;
  readonly mode: string;
  readonly sha: string | null;
}

/** Read one commit's tree as path → entry, or an empty map for a missing commit. */
export function filesOf(store: Store, repo: ForgeRepo, commitSha: string): TreeFiles {
  const out: TreeFiles = new Map();
  const walk = (treeSha: string, prefix: string): void => {
    for (const entry of store.treeEntries(repo, treeSha)) {
      if (entry.mode === MODE_TREE) {
        walk(entry.sha, prefix === '' ? `${entry.name}/` : `${prefix}${entry.name}/`);
      } else {
        out.set(prefix === '' ? entry.name : `${prefix}${entry.name}`, { mode: entry.mode, sha: entry.sha });
      }
    }
  };
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return out;
  const commit = parseCommit(object.data);
  if (commit === null) return out;
  walk(commit.tree, '');
  return out;
}

/** The changes `newer` carries relative to `older`: added, modified and removed paths. */
export function diffTrees(store: Store, repo: ForgeRepo, newerSha: string, olderSha: string): TreeChange[] {
  const newer = filesOf(store, repo, newerSha);
  const older = filesOf(store, repo, olderSha);
  const changes: TreeChange[] = [];
  for (const [path, entry] of newer) {
    const was = older.get(path);
    if (was === undefined) {
      changes.push({ path, mode: entry.mode, sha: entry.sha });
    } else if (was.sha !== entry.sha) {
      changes.push({ path, mode: entry.mode, sha: entry.sha });
    }
  }
  for (const [path, entry] of older) {
    if (!newer.has(path)) {
      changes.push({ path, mode: entry.mode, sha: null });
    }
  }
  // A stable order: path ascending, so two runs list the same changes the same way.
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/**
 * The youngest commit both `a` and `b` descend from, or null when the histories never meet. Walks
 * the shorter queue first; the suite's histories are one-parent chains, so this is a few hops.
 */
export function mergeBase(store: Store, repo: ForgeRepo, aSha: string, bSha: string): string | null {
  const ancestorsOf = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return seen;
  };
  const aAncestors = ancestorsOf(aSha);
  // Walk b newest-first; the first commit also in a's ancestry is the merge base.
  const queue = [bSha];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (aAncestors.has(sha)) return sha;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Whether a pull conflicts as things stand: both sides changed one path since their merge base. */
export function pullConflicts(store: Store, repo: ForgeRepo, pull: ForgePull): boolean {
  const baseTip = store.refSha(repo, `refs/heads/${pull.base.ref}`);
  if (baseTip === null) return true;
  const base = mergeBase(store, repo, pull.head.sha, baseTip);
  if (base === null) return true;
  const headChanges = diffTrees(store, repo, pull.head.sha, base);
  const baseChanges = diffTrees(store, repo, baseTip, base);
  const baseChanged = new Set(baseChanges.map((change) => change.path));
  return headChanges.some((change) => baseChanged.has(change.path));
}

/**
 * Squash-merge a pull onto its base branch: one new commit on the base whose tree is the base's
 * tree with every head-side change applied. Returns the merge commit's sha, or null on a conflict
 * (a path both sides changed since the merge base). The base ref moves to the new commit.
 */
export function squashMerge(store: Store, repo: ForgeRepo, pull: ForgePull): string | null {
  const baseRef = `refs/heads/${pull.base.ref}`;
  const baseTip = store.refSha(repo, baseRef);
  if (baseTip === null) return null;
  const base = mergeBase(store, repo, pull.head.sha, baseTip);
  if (base === null) return null;
  const headChanges = diffTrees(store, repo, pull.head.sha, base);
  const baseChanges = diffTrees(store, repo, baseTip, base);
  const baseChanged = new Set(baseChanges.map((change) => change.path));
  if (headChanges.some((change) => baseChanged.has(change.path))) return null;
  // Apply the head's changes onto the base tip's tree.
  const baseCommitObject = repo.objects.get(baseTip);
  if (baseCommitObject === undefined || baseCommitObject.type !== 'commit') return null;
  const baseCommit = parseCommit(baseCommitObject.data);
  if (baseCommit === null) return null;
  let rootTree = baseCommit.tree;
  for (const change of headChanges) {
    if (change.sha === null) {
      const next = store.removePath(repo, rootTree, change.path);
      if (next !== null) rootTree = next;
    } else {
      rootTree = store.setPath(repo, rootTree, change.path, change.mode, change.sha);
    }
  }
  const mergeSha = store.writeCommit(repo, rootTree, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(baseRef, mergeSha);
  repo.pushedAt = repo.pushedAt; // timestamps never move: the trial's now is the only now
  return mergeSha;
}

/** Count a text's lines the way a diff would: split on LF, a trailing empty line counts none. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}
