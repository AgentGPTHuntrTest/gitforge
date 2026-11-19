// The JSON the REST v3 surface answers, shaped as GitHub answers it: the field names the checks
// assert, exact where the checks compare exactly, plus the timestamps and ids a GitHub client
// expects. Global ids are base64 of "<Type>:<db id>" — opaque, stable, and never the raw number.

import type { ForgeBranch, ForgeComment, ForgeIssue, ForgeLabel, ForgePull, ForgeRepo } from './store.ts';
import type { TreeEntry } from './git/objects.ts';

/** The kind names global ids carry. */
export type NodeKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

/** One entity's global (GraphQL) id: base64 of "<Type>:<db id>", opaque on the wire. */
export function globalId(kind: NodeKind, dbId: number): string {
  return Buffer.from(`${kind}:${dbId}`, 'utf8').toString('base64');
}

/** Decode a global id, or null when it is not one this forge minted. */
export function parseGlobalId(id: string): { kind: NodeKind; dbId: number } | null {
  const KINDS: readonly NodeKind[] = ['Repository', 'Issue', 'PullRequest', 'IssueComment'];
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    const kind = text.slice(0, at) as NodeKind;
    const dbId = Number(text.slice(at + 1));
    if (!Number.isInteger(dbId) || dbId <= 0) return null;
    return KINDS.includes(kind) ? { kind, dbId } : null;
  } catch {
    return null;
  }
}

/** The API root document, with the scopes header beside it. */
export const OAUTH_SCOPES = 'repo, read:org';

/** A repository as REST reads it. */
export function repoJson(repo: ForgeRepo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    has_issues: true,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    html_url: `/${repo.fullName}`,
  };
}

/** An issue as REST reads it; the state strings are lowercase here and upper in GraphQL. */
export function issueJson(repo: ForgeRepo, issue: ForgeIssue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name), name)),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}

/** A label as an issue's `labels[]` carries it (unknown labels fall back to a bare name). */
export function labelJson(label: ForgeLabel | undefined, name: string): Record<string, unknown> {
  if (label === undefined) return { name };
  return { id: label.id, node_id: globalId('Issue', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

/** A label as the labels route answers it. */
export function labelFullJson(label: ForgeLabel): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Issue', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    created_at: label.createdAt,
    updated_at: label.updatedAt,
  };
}

/** A pull request as REST reads it; a merged pull reports state "closed" with merged: true. */
export function pullJson(pull: ForgePull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged_by: null,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: pull.head.label,
      repo: null,
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: pull.base.label,
      repo: null,
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
    mergeable_state: pull.merged ? 'dirty' : 'clean',
  };
}

/** An issue comment as REST reads it. */
export function commentJson(comment: ForgeComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

/** A branch as the branches route answers it. */
export function branchJson(branch: ForgeBranch): Record<string, unknown> {
  return { name: branch.name, commit: { sha: branch.sha }, protected: branch.protectedBranch };
}

/** A commit as the commits route answers it; the message rides byte-exact from the commit object. */
export function commitJson(sha: string, message: string): Record<string, unknown> {
  return { sha, commit: { message } };
}

/** A ref as the git refs route answers it. */
export function refJson(ref: string, sha: string): Record<string, unknown> {
  return { ref, node_id: globalId('Repository', 0), object: { sha, type: 'commit', url: '' } };
}

/** One file at the contents route. */
export function fileJson(path: string, entry: TreeEntry, data: Buffer, encoding = 'base64'): Record<string, unknown> {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return {
    type: 'file',
    encoding,
    size: data.length,
    name,
    path,
    content: encoding === 'base64' ? data.toString('base64') : data.toString('utf8'),
    sha: entry.sha,
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
  };
}

/** One directory entry at the contents route: a file or a subdirectory. */
export function dirEntryJson(parent: string, entry: TreeEntry): Record<string, unknown> {
  const path = parent === '' ? entry.name : `${parent}/${entry.name}`;
  const name = entry.name;
  if (entry.mode === '040000') {
    return { type: 'dir', name, path, sha: entry.sha, url: '', git_url: '', _links: {} };
  }
  return { type: 'file', name, path, sha: entry.sha, url: '', git_url: '', _links: {} };
}

/** The GitHub error body every error route answers with. */
export function errorMessage(message: string): Record<string, unknown> {
  return { message, documentation_url: 'https://docs.github.com/rest' };
}

/** Build a `Link` header value's `rel="next"` part for one more page, or null on the last page. */
export function nextPageLink(host: string, path: string, params: Record<string, string>): string | null {
  const query = new URLSearchParams(params);
  const url = `http://${host}${path}?${query.toString()}`;
  return `<${url}>; rel="next"`;
}
