// The forge's router, transport-independent: the boot probe, REST v3 under /api/v3, GraphQL at
// /api/graphql, MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git/... — one JSON 404 for
// everything else. Auth is the router's: every API surface answers 401 without the trial's bearer
// token (git never does), decided before any dispatch, exactly as the wire contract states.

import { tokenOk } from './env.ts';
import { handleGraphql } from './graphql.ts';
import { handleGit } from './git/http.ts';
import { sendJson, errorMessage } from './http-util.ts';
import { type HttpRequest, HttpResponse } from './http-shim.ts';
import { handleMcp } from './mcp.ts';
import { profileRows } from './profile.ts';
import { handleRest } from './rest.ts';
import { Store, type ForgeRepo } from './store.ts';

/** The git smart HTTP path shape: /{owner}/{repo}.git/{rest}. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** Answer the 401 every unauthenticated API request receives. */
function unauthorized(res: HttpResponse): void {
  sendJson(res, 401, errorMessage('Requires authentication'));
}

/** Route one whole request; the transport serializes whatever the handlers stage. */
export function route(store: Store, req: HttpRequest, res: HttpResponse): void {
  const method = req.method;
  const path = req.path;

  // The boot probe: no auth, 200 {"ok":true}.
  if (path === '/healthz') {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
    return;
  }
  if (path === '/__profile' && process.env.FORGE_PROFILE === '1') {
    sendJson(res, 200, { rows: profileRows(store) });
    return;
  }

  // The three API surfaces: authenticated as a group, 401 before any dispatch.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    if (!tokenOk(req.headers.authorization)) {
      unauthorized(res);
      return;
    }
    handleGraphql(store, res, req.body);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    if (!tokenOk(req.headers.authorization)) {
      unauthorized(res);
      return;
    }
    handleMcp(store, res, req.body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!tokenOk(req.headers.authorization)) {
      unauthorized(res);
      return;
    }
    handleRest(store, req, res, req.query, path.slice('/api/v3'.length), req.body);
    return;
  }

  // Git smart HTTP: matched by its path shape, authenticated never (the suite always presents the
  // token, and a 401 here would fail every git check).
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]);
    const name = decodeSegment(gitMatch[2]);
    const repo: ForgeRepo | null = store.getRepo(owner, name.endsWith('.git') ? name.slice(0, -4) : name);
    if (repo === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    handleGit(store, req, res, repo, req.query, req.body);
    return;
  }

  sendJson(res, 404, errorMessage('Not Found'));
}

/** Decode one path segment, tolerating malformed escapes. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
