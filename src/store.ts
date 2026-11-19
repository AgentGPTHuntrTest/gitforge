// The forge's whole world, in memory: repositories with their git objects and refs, and the
// issue/label/pull records the REST and MCP surfaces read and write. One process, one store; every
// id and number a sequential counter, every timestamp the trial's now, so two runs of one trial
// build byte-identical stores and answer identically. Git objects are kept loose (sha → payload);
// packs are parsed into this form on push and rebuilt on clone, never stored as packs.

import { NOW_ISO, NOW_EPOCH_SEC, NOW_TZ, FORGE_LOGIN } from './env.ts';
import { hashObject, parseCommit, parseTree, serializeTree, sortTreeEntries, type GitObject, type TreeEntry, MODE_FILE, MODE_TREE } from './git/objects.ts';

/** One issue comment. */
export interface ForgeComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One issue: per-repo sequential number, open or closed. */
export interface ForgeIssue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Label names as created on the repository, in creation order. */
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: ForgeComment[];
}

/** One end of a pull request: a bare branch name and the sha it pointed at when the pull opened. */
export interface ForgePullRef {
  readonly ref: string;
  sha: string;
  readonly label: string;
}

/** One pull request: open, closed, or merged (merged pulls are closed too). */
export interface ForgePull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: ForgePullRef;
  readonly base: ForgePullRef;
  merged: boolean;
  mergeable: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

/** One repository label: a name must be created here before an issue may carry it. */
export interface ForgeLabel {
  readonly id: number;
  readonly name: string;
  color: string;
  description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One branch, for the branches API. */
export interface ForgeBranch {
  readonly name: string;
  sha: string;
  readonly protectedBranch: false;
}

/** One repository: its record, its git store, its refs, and its issue/label/pull tables. */
export interface ForgeRepo {
  readonly id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** The repository's loose object store: sha → object. */
  readonly objects: Map<string, GitObject>;
  /** Full ref names ('refs/heads/main') → sha. */
  readonly refs: Map<string, string>;
  /** Issues indexed so that issues[number - 1] is issue `number`. */
  readonly issues: ForgeIssue[];
  /** The next issue number this repository hands out. */
  issueCounter: number;
  /** Labels by exact name. */
  readonly labels: Map<string, ForgeLabel>;
  /** Pulls indexed so that pulls[number - 1] is pull `number`. */
  readonly pulls: ForgePull[];
  pullCounter: number;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string;
}

/** The whole forge: every repository keyed by lowercased owner/name. */
export class Store {
  readonly repos: Map<string, ForgeRepo> = new Map();
  /** Repositories by database id, for global-id round trips. */
  private readonly reposById = new Map<number, ForgeRepo>();
  /** Issues by database id, with their repository. */
  private readonly issuesById = new Map<number, { repo: ForgeRepo; issue: ForgeIssue }>();
  /** Pulls by database id, with their repository. */
  private readonly pullsById = new Map<number, { repo: ForgeRepo; pull: ForgePull }>();
  private repoId = 1;
  private issueId = 1;
  private pullId = 1;
  private labelId = 1;
  private commentId = 1;

  /** The lowercased key a repository files under. */
  static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** A repository by owner and name, case-insensitively, or null. */
  getRepo(owner: string, name: string): ForgeRepo | null {
    return this.repos.get(Store.key(owner, name)) ?? null;
  }

  /** A repository by its database id, or null. */
  repoById(id: number): ForgeRepo | null {
    return this.reposById.get(id) ?? null;
  }

  /** An issue by its database id, with its repository, or null. */
  issueById(id: number): { repo: ForgeRepo; issue: ForgeIssue } | null {
    return this.issuesById.get(id) ?? null;
  }

  /** A pull by its database id, with its repository, or null. */
  pullById(id: number): { repo: ForgeRepo; pull: ForgePull } | null {
    return this.pullsById.get(id) ?? null;
  }

  /**
   * Create a repository. The owner is the token's login unless the caller names another (nothing
   * in the suite does); ids are sequential; the repository starts with no refs and no issues.
   */
  createRepo(name: string, options: Partial<Pick<ForgeRepo, 'description' | 'isPrivate' | 'owner'>> = {}): ForgeRepo {
    const owner = options.owner ?? FORGE_LOGIN;
    const key = Store.key(owner, name);
    const existing = this.repos.get(key);
    if (existing !== undefined) return existing;
    const repo: ForgeRepo = {
      id: this.repoId,
      name,
      owner,
      fullName: `${owner}/${name}`,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueCounter: 1,
      labels: new Map(),
      pulls: [],
      pullCounter: 1,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      pushedAt: NOW_ISO,
    };
    this.repoId += 1;
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /** Delete a repository; nothing later finds it. */
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  /** Create a label; an existing name returns the label it names. */
  createLabel(repo: ForgeRepo, name: string, color = 'ededed', description = ''): ForgeLabel {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: ForgeLabel = {
      id: this.labelId,
      name,
      color,
      description,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    this.labelId += 1;
    repo.labels.set(name, label);
    repo.updatedAt = NOW_ISO;
    return label;
  }

  /** Create an issue; labels must already exist as the repository's labels. */
  createIssue(repo: ForgeRepo, title: string, body: string, labels: readonly string[] = []): ForgeIssue {
    const issue: ForgeIssue = {
      id: this.issueId,
      number: repo.issueCounter,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      closedAt: null,
      comments: [],
    };
    this.issueId += 1;
    repo.issueCounter += 1;
    repo.issues.push(issue);
    repo.updatedAt = NOW_ISO;
    this.issuesById.set(issue.id, { repo, issue });
    return issue;
  }

  /** An issue by number, or null (numbers are per-repo and dense). */
  getIssue(repo: ForgeRepo, number: number): ForgeIssue | null {
    const issue = repo.issues[number - 1];
    return issue !== undefined && issue.number === number ? issue : null;
  }

  /** Close an issue in place. */
  closeIssue(repo: ForgeRepo, issue: ForgeIssue): void {
    issue.state = 'closed';
    issue.closedAt = NOW_ISO;
    issue.updatedAt = NOW_ISO;
    repo.updatedAt = NOW_ISO;
  }

  /** Add a comment to an issue. */
  addComment(issue: ForgeIssue, body: string): ForgeComment {
    const comment: ForgeComment = {
      id: this.commentId,
      body,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    this.commentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = NOW_ISO;
    return comment;
  }

  /** Create a pull request from branch `head` into branch `base`, both bare names. */
  createPull(repo: ForgeRepo, title: string, body: string, head: string, base: string): ForgePull {
    const pull: ForgePull = {
      id: this.pullId,
      number: repo.pullCounter,
      title,
      body,
      state: 'open',
      head: { ref: head, sha: this.refSha(repo, `refs/heads/${head}`) ?? '', label: `${repo.owner}:${head}` },
      base: { ref: base, sha: this.refSha(repo, `refs/heads/${base}`) ?? '', label: `${repo.owner}:${base}` },
      merged: false,
      mergeable: true,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    this.pullId += 1;
    repo.pullCounter += 1;
    repo.pulls.push(pull);
    repo.updatedAt = NOW_ISO;
    this.pullsById.set(pull.id, { repo, pull });
    return pull;
  }

  /** A pull by number, or null. */
  getPull(repo: ForgeRepo, number: number): ForgePull | null {
    const pull = repo.pulls[number - 1];
    return pull !== undefined && pull.number === number ? pull : null;
  }

  /** Mark a pull merged and closed, naming the merge commit. */
  markMerged(repo: ForgeRepo, pull: ForgePull, mergeCommitSha: string): void {
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = NOW_ISO;
    pull.updatedAt = NOW_ISO;
    pull.mergeCommitSha = mergeCommitSha;
    repo.updatedAt = NOW_ISO;
  }

  // ------------------------------------------------------------ the git side

  /** Store one object, hashing it; returns its sha. */
  addObject(repo: ForgeRepo, type: GitObject['type'], data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  /** One stored object, or null. */
  object(repo: ForgeRepo, sha: string): GitObject | null {
    return repo.objects.get(sha) ?? null;
  }

  /** A ref's sha, or null. */
  refSha(repo: ForgeRepo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /**
   * Whether `descendant` has `ancestor` among its ancestors: the walk a fast-forward check needs.
   * Small histories (the suite's are hundreds of commits), so parents are followed in memory.
   */
  isAncestor(repo: ForgeRepo, descendant: string, ancestor: string): boolean {
    if (descendant === ancestor) return true;
    const seen = new Set<string>([descendant]);
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return false;
  }

  /** Create a branch ref at a sha; the sha must be a commit the repository holds. */
  createRef(repo: ForgeRepo, ref: string, sha: string): boolean {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return false;
    if (repo.refs.has(ref)) return false;
    repo.refs.set(ref, sha);
    repo.pushedAt = NOW_ISO;
    return true;
  }

  /**
   * Apply a ref update the way receive-pack must: a create needs its new sha present, a delete
   * clears the ref, and an update must fast-forward from the old sha (or, when the old sha does not
   * match the ref's, fail with the reason git uses). Returns null on success or the failure word
   * for the report line ('non-fast-forward' or 'lock-segment' semantics folded into one).
   */
  updateRef(repo: ForgeRepo, ref: string, oldSha: string, newSha: string): null | 'missing-object' | 'non-fast-forward' {
    const current = repo.refs.get(ref);
    if (newSha === '0000000000000000000000000000000000000000') {
      // A delete: git requires the old sha to match, but the suite never force-pushes or deletes
      // through a mismatched old sha, so a present ref with a matching old sha is the only path.
      if (current !== undefined) repo.refs.delete(ref);
      return null;
    }
    const object = repo.objects.get(newSha);
    if (object === undefined || object.type !== 'commit') return 'missing-object';
    if (oldSha === '0000000000000000000000000000000000000000') {
      // A create.
      if (current !== undefined) return 'non-fast-forward';
      repo.refs.set(ref, newSha);
      repo.pushedAt = NOW_ISO;
      return null;
    }
    if (current === undefined || current !== oldSha) return 'non-fast-forward';
    if (!this.isAncestor(repo, newSha, oldSha)) return 'non-fast-forward';
    repo.refs.set(ref, newSha);
    repo.pushedAt = NOW_ISO;
    return null;
  }

  /** The repository's branches as ForgeBranch records, ref name order. */
  branches(repo: ForgeRepo): ForgeBranch[] {
    const out: ForgeBranch[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        out.push({ name: ref.slice('refs/heads/'.length), sha, protectedBranch: false });
      }
    }
    return out;
  }

  /**
   * Set one path in a tree (creating intermediate trees), returning the new root tree sha. The
   * blob must already be stored; `mode` is the git mode string for the entry.
   */
  setPath(repo: ForgeRepo, rootSha: string | null, path: string, mode: string, blobSha: string): string {
    const segments = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
    if (segments.length === 0) throw new Error('empty path');
    const name = segments[segments.length - 1];
    const dirs = segments.slice(0, -1);
    let dirSha = rootSha;
    // Walk down, rewriting each directory tree on the way back up.
    const rewritten: { sha: string }[] = [];
    for (const dir of dirs) {
      const entries = dirSha === null ? [] : this.treeEntries(repo, dirSha);
      const found = entries.find((entry) => entry.mode === MODE_TREE && entry.name === dir);
      dirSha = found === undefined ? null : found.sha;
      rewritten.push({ sha: dirSha === null ? '' : dirSha });
    }
    // Set the blob in the deepest directory (or the root).
    let deepestEntries = dirSha === null ? [] : this.treeEntries(repo, dirSha);
    deepestEntries = deepestEntries.filter((entry) => entry.name !== name || entry.mode === MODE_TREE);
    deepestEntries.push({ mode, name, sha: blobSha });
    let childSha = this.writeTree(repo, deepestEntries);
    // Rebuild upward: splice the rewritten child into each parent directory.
    for (let at = rewritten.length - 1; at >= 0; at -= 1) {
      const dirName = dirs[at];
      const parentSha = at === 0 ? rootSha : rewritten[at - 1].sha === '' ? null : rewritten[at - 1].sha;
      const parentEntries = parentSha === null ? [] : this.treeEntries(repo, parentSha);
      const kept = parentEntries.filter((entry) => entry.mode !== MODE_TREE || entry.name !== dirName);
      kept.push({ mode: MODE_TREE, name: dirName, sha: childSha });
      childSha = this.writeTree(repo, kept);
    }
    return childSha;
  }

  /**
   * Remove one path from a tree, pruning directories the removal empties. Returns the new root
   * tree sha, or null when the path was not there.
   */
  removePath(repo: ForgeRepo, rootSha: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
    if (segments.length === 0) return null;
    const removeAt = (dirSha: string, at: number): { sha: string } | null => {
      const entries = this.treeEntries(repo, dirSha);
      const name = segments[at];
      if (at === segments.length - 1) {
        const found = entries.some((entry) => entry.name === name && entry.mode !== MODE_TREE);
        if (!found) return null;
        return { sha: this.writeTree(repo, entries.filter((entry) => entry.name !== name)) };
      }
      const found = entries.find((entry) => entry.mode === MODE_TREE && entry.name === name);
      if (found === undefined) return null;
      const child = removeAt(found.sha, at + 1);
      if (child === null) return null;
      const kept = entries.filter((entry) => entry.name !== name);
      if (child.sha !== this.emptyTreeSha()) kept.push({ mode: MODE_TREE, name, sha: child.sha });
      return { sha: this.writeTree(repo, kept) };
    };
    const result = removeAt(rootSha, 0);
    return result === null ? null : result.sha;
  }

  /** A tree's entries, parsed and cached by the sha of nothing (histories are small). */
  treeEntries(repo: ForgeRepo, treeSha: string): TreeEntry[] {
    const object = repo.objects.get(treeSha);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Write one tree from entries, storing it; returns its sha. */
  writeTree(repo: ForgeRepo, entries: readonly TreeEntry[]): string {
    return this.addObject(repo, 'tree', serializeTree(sortTreeEntries(entries)));
  }

  /** The sha of git's empty tree. */
  emptyTreeSha(): string {
    return hashObject('tree', Buffer.alloc(0));
  }

  /**
   * Commit a tree onto a parent (or parentless), storing the commit; returns its sha. The identity
   * is the forge's own — deterministic, from the trial's now, never a wall clock.
   */
  writeCommit(repo: ForgeRepo, treeSha: string, parents: readonly string[], message: string): string {
    const person = { name: FORGE_LOGIN, email: `${FORGE_LOGIN}@forge.local`, epochSec: NOW_EPOCH_SEC, tz: NOW_TZ };
    const header = [
      `tree ${treeSha}`,
      ...parents.map((parent) => `parent ${parent}`),
      `author ${person.name} <${person.email}> ${person.epochSec} ${person.tz}`,
      `committer ${person.name} <${person.email}> ${person.epochSec} ${person.tz}`,
      '',
      '',
    ].join('\n');
    return this.addObject(repo, 'commit', Buffer.from(`${header}${message}`, 'utf8'));
  }

  /**
   * The flattened files of a commit: path → {mode, sha}, directories walked depth-first in tree
   * order. Used by the contents API and the pull-request file lists.
   */
  flatten(repo: ForgeRepo, commitSha: string): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const walk = (treeSha: string, prefix: string): void => {
      for (const entry of this.treeEntries(repo, treeSha)) {
        if (entry.mode === MODE_TREE) {
          walk(entry.sha, prefix === '' ? `${entry.name}/` : `${prefix}${entry.name}/`);
        } else {
          out.set(prefix === '' ? entry.name : `${prefix}${entry.name}`, entry);
        }
      }
    };
    const commit = repo.objects.get(commitSha);
    if (commit === undefined || commit.type !== 'commit') return out;
    const parsed = parseCommit(commit.data);
    if (parsed === null) return out;
    walk(parsed.tree, '');
    return out;
  }
}
