// The forge's entry surface, one call: the raw TCP transport that serves every route — the boot
// probe, REST v3 under /api/v3, GraphQL at /api/graphql, MCP at /mcp, and git smart HTTP at
// /{owner}/{repo}.git/... — with HTTP/1.1 parsed by hand and one write per response. The server
// binds nothing itself; the entry listens on an ephemeral port and hands the port to the env.

import type { Server } from 'node:net';

import { createRawServer } from './src/raw-server.ts';
import type { Store } from './src/store.ts';

/** Build the server: bind nothing until the caller listens. */
export function createApp(store: Store): Server {
  return createRawServer(store);
}
