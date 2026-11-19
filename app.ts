// The forge's HTTP surface, routed: the boot probe, REST v3 under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git/... — one JSON 404 for everything else.
// Auth is the router's: every API surface answers 401 without the trial's bearer token (git never
// does), decided before any dispatch, exactly as the wire contract states. The server binds nothing
// itself; the entry listens on an ephemeral port and hands the port to the env.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { tokenOk } from './src/env.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleGit } from './src/git/http.ts';
import { readBody, sendJson } from './src/http-util.ts';
import { handleMcp } from './src/mcp.ts';
import { errorMessage } from './src/serialize.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';

/** The git smart HTTP path shape: /{owner}/{repo}.git/{rest}. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** Answer the 401 every unauthenticated API request receives. */
function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, errorMessage('Requires authentication'));
}

/** Route one request once its body is read. */
function route(store: Store, req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  // The boot probe: no auth, 200 {"ok":true}.
  if (path === '/healthz') {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, errorMessage('Not Found'));
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
    handleGraphql(store, req, res, body);
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
    handleMcp(store, req, res, body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!tokenOk(req.headers.authorization)) {
      unauthorized(res);
      return;
    }
    const sub = path.slice('/api/v3'.length);
    handleRest(store, req, res, url, sub, body);
    return;
  }

  // Git smart HTTP: matched by its path shape, authenticated never (the suite always presents the
  // token, and a 401 here would fail every git check).
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]);
    const name = decodeSegment(gitMatch[2]);
    const repo = store.getRepo(owner, name.endsWith('.git') ? name.slice(0, -4) : name);
    if (repo === null) {
      sendJson(res, 404, errorMessage('Not Found'));
      return;
    }
    handleGit(store, req, res, repo, url, body);
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

/**
 * Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral
 * port. A request's body is read whole before routing (git POSTs carry packs), and a client that
 * hangs up mid-body is routine, never an error.
 */
export function createApp(store: Store): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    let routed = false;
    const method = req.method ?? 'GET';
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const finish = (body: Buffer): void => {
      if (routed) return;
      routed = true;
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://forge.local');
      } catch {
        sendJson(res, 404, errorMessage('Not Found'));
        return;
      }
      try {
        route(store, req, res, url, body);
      } catch (err) {
        // A handler fault never kills the server: answer, log, keep serving.
        if (!res.headersSent) {
          sendJson(res, 500, errorMessage(`Internal error: ${err instanceof Error ? err.message : String(err)}`));
        } else {
          res.end();
        }
      }
    };
    if (!hasBody) {
      finish(Buffer.alloc(0));
      return;
    }
    readBody(req)
      .then((body) => finish(body))
      .catch(() => {
        if (!res.headersSent) sendJson(res, 413, errorMessage('Payload too large'));
        else res.end();
      });
    res.on('close', () => {
      routed = true;
    });
  });
}
