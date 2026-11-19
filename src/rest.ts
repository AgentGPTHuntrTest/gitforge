// REST v3 under /api/v3, one route per surface the conformance suite drives: the API root, the
// viewer's repositories (created, listed, patched, deleted), branches and refs, commits, the
// contents API (create, read, update, delete), labels, issues and their comments, pull requests,
// their files and their squash merges. Status codes are the contract: 401 is the router's, 404 for
// anything the token cannot see (never 403), 400 for a malformed body, 409 for a stale blob sha,
// 422 for a duplicate name or an unknown label, and one JSON body shape per entity everywhere.

import { type HttpRequest, HttpResponse, QueryMap } from './http-shim.ts';

import { FORGE_LOGIN, NOW_ISO } from './env.ts';
import { errorMessage, nextRequestId, sendJson } from './http-util.ts';
import { lineCount, diffTrees, pullConflicts, squashMerge } from './merge.ts';
import {
  branchJson,
  commentJson,
  commitJson,
  dirEntryJson,
  fileJson,
  issueJson,
  labelFullJson,
  nextPageLink,
  OAUTH_SCOPES,
  pullJson,
  refJson,
  repoJson,
} from './serialize.ts';
import { Store, type ForgeIssue, type ForgePull, type ForgeRepo } from './store.ts';
import { invalidatePackCache } from './git/http.ts';
import { parseCommit, parseTree, type TreeEntry } from './git/objects.ts';

/** The per-repository cache of serialized issue bodies, keyed by issue id. */
const issueBodyCache = new WeakMap<ForgeRepo, Map<number, Buffer>>();

/** One issue's serialized body, reused verbatim while the issue stands unchanged. */
function cachedIssueBody(repo: ForgeRepo, issue: ForgeIssue): Buffer {
  let cache = issueBodyCache.get(repo);
  if (cache === undefined) {
    cache = new Map();
    issueBodyCache.set(repo, cache);
  }
  const hit = cache.get(issue.id);
  if (hit !== undefined) return hit;
  const body = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`);
  cache.set(issue.id, body);
  return body;
}

/** Forget one issue's cached body (any mutation), or the whole cache when labels moved. */
function invalidateIssue(repo: ForgeRepo, issueId?: number): void {
  const cache = issueBodyCache.get(repo);
  if (cache === undefined) return;
  if (issueId === undefined) cache.clear();
  else cache.delete(issueId);
}

/** Parse a JSON request body, or answer 400 the way the protocol check wants. */
function jsonBody(res: HttpResponse, body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, errorMessage('Problems parsing JSON'));
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, errorMessage('Problems parsing JSON'));
    return null;
  }
}

/** A string field of a parsed body, or undefined. */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** The repository a route names, or a 404 and null (another owner's name is a 404 too). */
function findRepo(store: Store, res: HttpResponse, owner: string, name: string): ForgeRepo | null {
  const repo = store.getRepo(owner, name);
  if (repo === null) {
    sendJson(res, 404, errorMessage('Not Found'));
    return null;
  }
  return repo;
}

/** A positive page size from a query string, or the default. */
function pageSize(query: QueryMap, fallback: number, cap = 100): number {
  const raw = Number(query.get('per_page'));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), cap);
}

/** The sha a ref-ish query parameter names: a branch, a full ref, or a commit sha itself. */
function refOfParam(repo: ForgeRepo, query: QueryMap, param = 'ref'): string | null {
  const ref = query.get(param);
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const byRef = repo.refs.get(full);
  if (byRef !== undefined) return byRef;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) return ref.toLowerCase();
  return null;
}

/** The commits reachable from a tip, newest first (linear histories: the discovery order). */
function commitList(store: Store, repo: ForgeRepo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit === null) continue;
    out.push({ sha, message: commit.message });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** The sha of the commit a contents write builds on, or null when the branch is unborn. */
function tipOf(repo: ForgeRepo, branch: string | undefined): string | null {
  const name = branch ?? repo.defaultBranch;
  return repo.refs.get(`refs/heads/${name}`) ?? null;
}

/** A ref update that always fast-forwards (the commit's parent is the current tip). */
function advanceRef(store: Store, repo: ForgeRepo, branch: string | undefined, newTip: string): void {
  const name = branch ?? repo.defaultBranch;
  repo.refs.set(`refs/heads/${name}`, newTip);
  repo.pushedAt = NOW_ISO;
  invalidatePackCache(repo);
  void store;
}

/**
 * Serve one /api/v3 request; the router has already authenticated it, resolved the prefix, and
 * read the whole body. `sub` is the path after `/api/v3` (empty or `/` for the root).
 */
export function handleRest(store: Store, req: HttpRequest, res: HttpResponse, query: QueryMap, sub: string, body: Buffer): void {
  const method = req.method ?? 'GET';
  const segments = sub.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  // The API root: a JSON object with the token's scopes beside it.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
        organization_url: '/api/v3/orgs/{org}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': OAUTH_SCOPES });
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: 'forge-1.0.0' });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: FORGE_LOGIN, id: 1000, type: 'User', name: 'ada iversen' });
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const parsed = jsonBody(res, body);
      if (parsed === null) return;
      const name = str(parsed, 'name');
      if (name === undefined || name === '' || name.endsWith('.git')) {
        sendJson(res, 422, errorMessage('name is required'));
        return;
      }
      if (store.getRepo(FORGE_LOGIN, name) !== null) {
        sendJson(res, 422, errorMessage('name already exists on this account'));
        return;
      }
      const repo = store.createRepo(name, {
        description: str(parsed, 'description') ?? '',
        isPrivate: parsed.private === true,
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = pageSize(query, 30);
      const page = Math.max(1, Math.floor(Number(query.get('page')) || 1));
      const all = [...store.repos.values()].filter((repo) => repo.owner === FORGE_LOGIN);
      const start = (page - 1) * perPage;
      const pageItems = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const host = req.headers.host ?? 'forge.local';
        const link = nextPageLink(host, '/api/v3/user/repos', { page: String(page + 1), per_page: String(perPage) });
        if (link !== null) headers.link = link;
      }
      sendJson(res, 200, pageItems.map((repo) => repoJson(repo)), headers);
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  // Everything from here is /repos/{owner}/{repo}/...
  const [owner, name] = [segments[1], segments[2]];
  const repo = findRepo(store, res, owner, name);
  if (repo === null) return;
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = jsonBody(res, body);
      if (parsed === null) return;
      const description = str(parsed, 'description');
      if (description !== undefined) repo.description = description;
      repo.updatedAt = NOW_ISO;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      res.writeHead(204, { 'content-length': 0, 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const parsed = jsonBody(res, body);
    if (parsed === null) return;
    const ref = str(parsed, 'ref');
    const sha = str(parsed, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
      sendJson(res, 422, errorMessage('ref and sha are required'));
      return;
    }
    if (repo.refs.has(ref)) {
      sendJson(res, 422, errorMessage(`Reference already exists: ${ref}`));
      return;
    }
    if (!store.createRef(repo, ref, sha.toLowerCase())) {
      sendJson(res, 422, errorMessage('sha is not a commit the repository holds'));
      return;
    }
    invalidatePackCache(repo);
    sendJson(res, 201, refJson(ref, sha.toLowerCase()));
    return;
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length === 4 && method === 'GET') {
    const branch = rest[3];
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    sendJson(res, 200, refJson(`refs/heads/${branch}`, sha));
    return;
  }

  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, store.branches(repo).map((branch) => branchJson(branch)));
    return;
  }

  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const branch = rest[1];
    const found = store.branches(repo).find((entry) => entry.name === branch);
    if (found === undefined) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    sendJson(res, 200, branchJson(found));
    return;
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = refOfParam(repo, query, 'sha');
    if (tip === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    sendJson(res, 200, commitList(store, repo, tip).map((entry) => commitJson(entry.sha, entry.message)));
    return;
  }

  if (rest[0] === 'contents' && rest.length >= 2) {
    handleContents(store, req, res, query, repo, rest.slice(1), body);
    return;
  }

  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const parsed = jsonBody(res, body);
      if (parsed === null) return;
      const labelName = str(parsed, 'name');
      if (labelName === undefined || labelName === '') {
        sendJson(res, 422, errorMessage('name is required'));
        return;
      }
      const label = store.createLabel(repo, labelName, str(parsed, 'color') ?? 'ededed', str(parsed, 'description') ?? '');
      invalidateIssue(repo);
      sendJson(res, 201, labelFullJson(label));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelFullJson(label)));
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (rest[0] === 'issues' && rest.length === 1) {
    handleIssueList(store, res, query, repo, body, method);
    return;
  }

  if (rest[0] === 'issues' && rest.length === 2 && /^[0-9]+$/.test(rest[1])) {
    const number = Number(rest[1]);
    const issue = store.getIssue(repo, number);
    if (issue === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, null, {}, cachedIssueBody(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = jsonBody(res, body);
      if (parsed === null) return;
      const state = str(parsed, 'state');
      const title = str(parsed, 'title');
      const issueBody = str(parsed, 'body');
      if (state !== undefined) {
        if (state === 'closed') store.closeIssue(repo, issue);
        else if (state === 'open') {
          issue.state = 'open';
          issue.closedAt = null;
        }
      }
      if (title !== undefined) issue.title = title;
      if (issueBody !== undefined) issue.body = issueBody;
      invalidateIssue(repo, issue.id);
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (rest[0] === 'issues' && rest.length === 3 && /^[0-9]+$/.test(rest[1]) && rest[2] === 'comments') {
    const number = Number(rest[1]);
    const issue = store.getIssue(repo, number);
    if (issue === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    if (method === 'POST') {
      const parsed = jsonBody(res, body);
      if (parsed === null) return;
      const text = str(parsed, 'body');
      if (text === undefined) {
        sendJson(res, 422, errorMessage('body is required'));
        return;
      }
      const comment = store.addComment(issue, text);
      invalidateIssue(repo, issue.id);
      sendJson(res, 201, commentJson(comment));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(comment)));
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (rest[0] === 'pulls' && rest.length === 1) {
    handlePullList(store, res, query, repo, body, method);
    return;
  }

  if (rest[0] === 'pulls' && rest.length === 2 && /^[0-9]+$/.test(rest[1])) {
    const pull = store.getPull(repo, Number(rest[1]));
    if (pull === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJson(pull));
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (rest[0] === 'pulls' && rest.length === 3 && /^[0-9]+$/.test(rest[1]) && rest[2] === 'files' && method === 'GET') {
    const pull = store.getPull(repo, Number(rest[1]));
    if (pull === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    sendJson(res, 200, pullFiles(store, repo, pull));
    return;
  }

  if (rest[0] === 'pulls' && rest.length === 3 && /^[0-9]+$/.test(rest[1]) && rest[2] === 'merge' && method === 'PUT') {
    const parsed = jsonBody(res, body);
    if (parsed === null) return;
    const number = Number(rest[1]);
    const pull = store.getPull(repo, number);
    if (pull === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    if (pull.merged) {
      sendJson(res, 405, errorMessage('Pull Request is not mergeable'));
      return;
    }
    if (pullConflicts(store, repo, pull)) {
      sendJson(res, 405, errorMessage('Pull Request is not mergeable'));
      return;
    }
    const mergeSha = squashMerge(store, repo, pull);
    if (mergeSha === null) {
      sendJson(res, 405, errorMessage('Pull Request is not mergeable'));
      return;
    }
    store.markMerged(repo, pull, mergeSha);
    invalidatePackCache(repo);
    sendJson(res, 200, { merged: true, sha: mergeSha, message: `Pull request #${number} was merged with squash` });
    return;
  }

  sendJson(res, 404, errorMessage('Not Found'));
}

/** The issues route: list with state/sort/direction filters, or create with label validation. */
function handleIssueList(store: Store, res: HttpResponse, query: QueryMap, repo: ForgeRepo, body: Buffer, method: string): void {
  if (method === 'POST') {
    const parsed = jsonBody(res, body);
    if (parsed === null) return;
    const title = str(parsed, 'title');
    if (title === undefined || title === '') {
      sendJson(res, 422, errorMessage('title is required'));
      return;
    }
    const labelsValue = parsed.labels;
    const labels = Array.isArray(labelsValue) ? labelsValue.filter((label): label is string => typeof label === 'string') : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) {
        sendJson(res, 422, errorMessage(`Label "${label}" does not exist`));
        return;
      }
    }
    const issue = store.createIssue(repo, title, str(parsed, 'body') ?? '', labels);
    sendJson(res, 201, issueJson(repo, issue));
    return;
  }
  if (method === 'GET') {
    const stateParam = query.get('state') ?? 'open';
    const direction = query.get('direction') === 'asc' ? 'asc' : 'desc';
    const perPage = pageSize(query, 30);
    let issues = repo.issues.filter((issue) => (stateParam === 'all' ? true : issue.state === stateParam));
    issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    sendJson(res, 200, issues.slice(0, perPage).map((issue) => issueJson(repo, issue)));
    return;
  }
  sendJson(res, 404, errorMessage('Not Found'));
}

/** The pulls route: list with a state filter (default open), or create with tip snapshots. */
function handlePullList(store: Store, res: HttpResponse, query: QueryMap, repo: ForgeRepo, body: Buffer, method: string): void {
  if (method === 'POST') {
    const parsed = jsonBody(res, body);
    if (parsed === null) return;
    const title = str(parsed, 'title');
    const head = str(parsed, 'head');
    const base = str(parsed, 'base');
    if (title === undefined || head === undefined || base === undefined) {
      sendJson(res, 422, errorMessage('title, head and base are required'));
      return;
    }
    if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
      sendJson(res, 422, errorMessage('head and base must name branches of this repository'));
      return;
    }
    const pull = store.createPull(repo, title, str(parsed, 'body') ?? '', head, base);
    sendJson(res, 201, pullJson(pull));
    return;
  }
  if (method === 'GET') {
    const stateParam = query.get('state') ?? 'open';
    const perPage = pageSize(query, 30);
    const pulls = repo.pulls.filter((pull) => (stateParam === 'all' ? true : stateParam === 'closed' ? pull.state === 'closed' : pull.state === 'open'));
    sendJson(res, 200, [...pulls].sort((a, b) => a.number - b.number).slice(0, perPage).map((pull) => pullJson(pull)));
    return;
  }
  sendJson(res, 404, errorMessage('Not Found'));
}

/** One pull's changed files: the head snapshot against the base snapshot, counts included. */
function pullFiles(store: Store, repo: ForgeRepo, pull: ForgePull): Record<string, unknown>[] {
  const changes = diffTrees(store, repo, pull.head.sha, pull.base.sha);
  const out: Record<string, unknown>[] = [];
  for (const change of changes) {
    const beforeBlob = blobAt(repo, pull.base.sha, change.path);
    const afterBlob = change.sha === null ? null : repo.objects.get(change.sha);
    const beforeText = beforeBlob !== null ? beforeBlob.data.toString('utf8') : '';
    const afterText = afterBlob !== undefined && afterBlob.type === 'blob' ? afterBlob.data.toString('utf8') : '';
    const status = change.sha === null ? 'removed' : beforeBlob !== null ? 'modified' : 'added';
    const additions = change.sha === null ? 0 : Math.max(1, lineCount(afterText));
    const deletions = beforeBlob !== null ? Math.max(1, lineCount(beforeText)) : 0;
    out.push({
      filename: change.path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/** The blob at one path under one commit, or null. */
function blobAt(repo: ForgeRepo, commitSha: string, path: string): { sha: string; data: Buffer } | null {
  const segments = path.split('/').filter((part) => part !== '');
  const commitObject = repo.objects.get(commitSha);
  if (commitObject === undefined || commitObject.type !== 'commit') return null;
  const commit = parseCommit(commitObject.data);
  if (commit === null) return null;
  let treeSha: string = commit.tree;
  for (let at = 0; at < segments.length; at += 1) {
    const treeObject = repo.objects.get(treeSha);
    if (treeObject === undefined || treeObject.type !== 'tree') return null;
    const found = parseTree(treeObject.data).find((entry) => entry.name === segments[at]);
    if (found === undefined) return null;
    if (at === segments.length - 1) {
      if (found.mode === '040000') return null;
      const blob = repo.objects.get(found.sha);
      if (blob === undefined || blob.type !== 'blob') return null;
      return { sha: found.sha, data: blob.data };
    }
    if (found.mode !== '040000') return null;
    treeSha = found.sha;
  }
  return null;
}

/** The contents route: read a file or a directory, create and update files, delete them. */
function handleContents(
  store: Store,
  req: HttpRequest,
  res: HttpResponse,
  query: QueryMap,
  repo: ForgeRepo,
  pathSegments: readonly string[],
  body: Buffer,
): void {
  const method = req.method ?? 'GET';
  const path = pathSegments.join('/');
  if (path === '') {
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }

  if (method === 'GET') {
    const tip = refOfParam(repo, query);
    if (tip === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    const commitObject = repo.objects.get(tip);
    if (commitObject === undefined || commitObject.type !== 'commit') {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    const commit = parseCommit(commitObject.data);
    if (commit === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    let currentSha: string = commit.tree;
    let walked: TreeEntry | undefined;
    let parentPath = '';
    for (let at = 0; at < pathSegments.length; at += 1) {
      const treeObject = repo.objects.get(currentSha);
      if (treeObject === undefined || treeObject.type !== 'tree') {
        sendJson(res, 404, errorMessage('Not Found'));
        return;
      }
      const found = parseTree(treeObject.data).find((entry) => entry.name === pathSegments[at]);
      if (found === undefined) {
        sendJson(res, 404, errorMessage('Not Found'));
        return;
      }
      if (at === pathSegments.length - 1) {
        walked = found;
        break;
      }
      if (found.mode !== '040000') {
        sendJson(res, 404, errorMessage('Not Found'));
        return;
      }
      parentPath = parentPath === '' ? found.name : `${parentPath}/${found.name}`;
      currentSha = found.sha;
    }
    if (walked === undefined) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    if (walked.mode === '040000') {
      const treeObject = repo.objects.get(walked.sha);
      if (treeObject === undefined || treeObject.type !== 'tree') {
        sendJson(res, 404, errorMessage('Not Found'));
        return;
      }
      const entries = parseTree(treeObject.data).map((entry) => dirEntryJson(parentPath, entry));
      sendJson(res, 200, entries);
      return;
    }
    const blob = repo.objects.get(walked.sha);
    if (blob === undefined || blob.type !== 'blob') {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    sendJson(res, 200, fileJson(path, walked, blob.data));
    return;
  }

  if (method === 'PUT') {
    const parsed = jsonBody(res, body);
    if (parsed === null) return;
    const content = str(parsed, 'content');
    if (content === undefined) {
      sendJson(res, 422, errorMessage('content is required'));
      return;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content, 'base64');
    } catch {
      sendJson(res, 422, errorMessage('content is not valid base64'));
      return;
    }
    const branch = str(parsed, 'branch');
    const expectedSha = str(parsed, 'sha')?.toLowerCase();
    const tip = tipOf(repo, branch);
    const current = tip === null ? null : blobAt(repo, tip, path);
    if (current !== null && expectedSha !== undefined && expectedSha !== current.sha) {
      sendJson(res, 409, errorMessage(`the sha parameter does not match ${path}`));
      return;
    }
    const blobSha = store.addObject(repo, 'blob', bytes);
    const rootTree = tip === null ? null : commitTreeOf(repo, tip);
    const newTree = store.setPath(repo, rootTree, path, '100644', blobSha);
    const commitSha = store.writeCommit(repo, newTree, tip === null ? [] : [tip], str(parsed, 'message') ?? 'update');
    advanceRef(store, repo, branch, commitSha);
    const baseName = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    sendJson(res, current === null ? 201 : 200, {
      content: { name: baseName, path, sha: blobSha, encoding: 'base64', size: bytes.length, type: 'file' },
      commit: { sha: commitSha, message: str(parsed, 'message') ?? 'update' },
    });
    return;
  }

  if (method === 'DELETE') {
    const parsed = jsonBody(res, body);
    if (parsed === null) return;
    const tip = tipOf(repo, undefined);
    if (tip === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    const current = blobAt(repo, tip, path);
    if (current === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    const expectedSha = str(parsed, 'sha')?.toLowerCase();
    if (expectedSha !== undefined && expectedSha !== current.sha) {
      sendJson(res, 409, errorMessage(`the sha parameter does not match ${path}`));
      return;
    }
    const rootTree = commitTreeOf(repo, tip);
    const nextTree = store.removePath(repo, rootTree, path);
    if (nextTree === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    const commitSha = store.writeCommit(repo, nextTree, [tip], str(parsed, 'message') ?? 'delete');
    advanceRef(store, repo, undefined, commitSha);
    sendJson(res, 200, { commit: { sha: commitSha } });
    return;
  }

  sendJson(res, 404, errorMessage('Not Found'));
}

/** The tree sha of a commit the repository holds, or null. */
function commitTreeOf(repo: ForgeRepo, commitSha: string): string | null {
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return commit === null ? null : commit.tree;
}
