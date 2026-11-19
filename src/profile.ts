// Profiling (FORGE_PROFILE=1): where the server's own handling time goes, by route class.
// Off the request path entirely unless enabled; the numbers steer the optimization work.

import type { Store } from './store.ts';

/** The profiling counters. */
interface ProfileTable {
  count: number;
  totalMs: number;
  maxMs: number;
}

const profileCounts = new WeakMap<Store, Map<string, ProfileTable>>();

/** Bucket one handled request's cost. */
export function profile(store: Store, key: string, tookMs: number): void {
  let table = profileCounts.get(store);
  if (table === undefined) {
    table = new Map();
    profileCounts.set(store, table);
  }
  const row = table.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
  row.count += 1;
  row.totalMs += tookMs;
  row.maxMs = Math.max(row.maxMs, tookMs);
  table.set(key, row);
}

/** Classify a path for profiling: hot routes by name, the rest lumped. */
export function pathClass(path: string): string {
  if (path === '/healthz') return '/healthz';
  if (path === '/api/graphql') return '/api/graphql';
  if (path === '/mcp') return '/mcp';
  if (path === '/api/v3/user/repos') return '/api/v3/user/repos';
  if (path.includes('/issues/') && path.endsWith('/comments')) return 'issues-comments';
  if (path.includes('/issues/') && path.includes('/files')) return 'pulls-files';
  if (path.includes('/issues/')) return 'issue-get';
  if (path.endsWith('/issues')) return 'issues-list-or-create';
  if (path.endsWith('/pulls') && !path.includes('/pulls/')) return 'pulls-list-or-create';
  if (path.includes('/pulls/') && path.endsWith('/merge')) return 'pull-merge';
  if (path.includes('/pulls/')) return 'pull-get';
  if (path.endsWith('/info/refs')) return 'git-info/refs';
  if (path.endsWith('/git-upload-pack')) return 'git-upload-pack';
  if (path.endsWith('/git-receive-pack')) return 'git-receive-pack';
  if (path.includes('/contents/')) return 'contents';
  if (path.endsWith('/commits')) return 'commits';
  if (path.endsWith('/branches')) return 'branches';
  if (path.includes('/git/refs')) return 'git-refs';
  if (/^\/api\/v3\/repos\/[^/]+\/[^/]+$/.test(path)) return 'repo-get';
  return 'other';
}

/** The profiling counters, for the debug endpoint. */
export function profileRows(store: Store): { key: string; count: number; totalMs: number; maxMs: number }[] {
  const table = profileCounts.get(store) ?? new Map<string, ProfileTable>();
  return [...table.entries()]
    .map(([key, row]) => ({ key, count: row.count, totalMs: Math.round(row.totalMs * 100) / 100, maxMs: Math.round(row.maxMs * 100) / 100 }))
    .sort((a, b) => b.totalMs - a.totalMs);
}
