// MCP at POST /mcp: JSON-RPC 2.0 over the Streamable HTTP transport, revision 2026-07-28. The
// handshake is the modern server/discover probe (never answered with a fatal error code), the tool
// list is a static document that answers byte-for-byte identically every time, and the six tools
// act on the same store the REST surface serves — objects created here read back over /api/v3 with
// their ids unchanged. Errors are JSON-RPC errors, never HTTP 500; a malformed body is 400 with
// -32700; no session id is ever issued (the client would then have to carry and delete it).

import type { IncomingMessage, ServerResponse } from 'node:http';

import { FORGE_LOGIN } from './env.ts';
import { sendJson } from './http-util.ts';
import { pullConflicts, squashMerge } from './merge.ts';
import { issueJson, pullJson, repoJson } from './serialize.ts';
import { Store, type ForgeRepo } from './store.ts';

/** The revision the client prefers, and the only one the forge needs to speak. */
const REVISION = '2026-07-28';

/** The server's identity, in both places a client may read it. */
const SERVER_INFO = { name: 'gitforge', version: '1.0.0' };

/** One tool's descriptor: the static document tools/list answers with. */
interface ToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { readonly type: string }>;
    readonly required: readonly string[];
  };
}

/** The six tools, canonical names, fixed order, fixed keys: byte-identical on every call. */
const TOOLS: readonly ToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' }, owner: { type: 'string' } }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    title: 'Get repository',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ owner: { type: 'string' }, repo: { type: 'string' } }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    title: 'Create issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    title: 'List issues',
    description: 'List a repository\u2019s issues, open by default.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** One JSON-RPC answer envelope. */
function rpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** One JSON-RPC error envelope. */
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** A string field of a tool's arguments. */
function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** An integer field of a tool's arguments. */
function argInt(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Whether every required property of a tool is present in the call's arguments. */
function missingRequired(tool: ToolDescriptor, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined);
}

/** The tools/list result: the static document, serialized byte-identically every time. */
function toolsListResult(): Record<string, unknown> {
  return { tools: TOOLS.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema })) };
}

/** A successful tools/call result: the domain object in both readable places. */
function toolCallResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

/** A tool-execution failure: `isError: true` with the message in both places. */
function toolCallError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** The repository a tool's owner/repo names, or a failure result naming the miss. */
function toolRepo(store: Store, args: Record<string, unknown>): ForgeRepo | { missing: string } {
  const owner = argString(args, 'owner');
  const repo = argString(args, 'repo');
  if (owner === undefined || repo === undefined) return { missing: 'owner and repo are required' };
  const found = store.getRepo(owner, repo);
  if (found === null) return { missing: `no repository ${owner}/${repo}` };
  return found;
}

/** Dispatch one tools/call: apply the tool to the store and build the result envelope. */
function callTool(store: Store, id: unknown, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) {
    return rpcError(id, -32602, `unknown tool: ${name}`);
  }
  const missing = missingRequired(tool, args);
  if (missing.length > 0) {
    return rpcError(id, -32602, `missing required arguments: ${missing.join(', ')}`);
  }
  switch (tool.name) {
    case 'create_repo': {
      const name2 = argString(args, 'name');
      if (name2 === undefined) return rpcError(id, -32602, 'missing required arguments: name');
      const repo = store.createRepo(name2, {
        description: argString(args, 'description') ?? '',
        isPrivate: args.private === true,
        owner: argString(args, 'owner') ?? FORGE_LOGIN,
      });
      return rpcResult(id, toolCallResult(repoJson(repo)));
    }
    case 'get_repo': {
      const found = toolRepo(store, args);
      if ('missing' in found) return rpcResult(id, toolCallError(found.missing));
      return rpcResult(id, toolCallResult(repoJson(found)));
    }
    case 'create_issue': {
      const found = toolRepo(store, args);
      if ('missing' in found) return rpcResult(id, toolCallError(found.missing));
      const title = argString(args, 'title') ?? '';
      const issue = store.createIssue(found, title, argString(args, 'body') ?? '');
      return rpcResult(id, toolCallResult(issueJson(found, issue)));
    }
    case 'list_issues': {
      const found = toolRepo(store, args);
      if ('missing' in found) return rpcResult(id, toolCallError(found.missing));
      const state = argString(args, 'state') ?? 'open';
      const issues = found.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      return rpcResult(id, toolCallResult({ issues: issues.map((issue) => issueJson(found, issue)) }));
    }
    case 'create_pull_request': {
      const found = toolRepo(store, args);
      if ('missing' in found) return rpcResult(id, toolCallError(found.missing));
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (head === undefined || base === undefined) return rpcError(id, -32602, 'missing required arguments: head, base');
      const pull = store.createPull(found, argString(args, 'title') ?? '', argString(args, 'body') ?? '', head, base);
      return rpcResult(id, toolCallResult(pullJson(pull)));
    }
    case 'merge_pull_request': {
      const found = toolRepo(store, args);
      if ('missing' in found) return rpcResult(id, toolCallError(found.missing));
      const number = argInt(args, 'pull_number');
      if (number === undefined) return rpcError(id, -32602, 'missing required arguments: pull_number');
      const pull = store.getPull(found, number);
      if (pull === null) return rpcResult(id, toolCallError(`no pull request #${number}`));
      if (pull.merged) return rpcResult(id, toolCallResult({ merged: true, number, state: 'closed' }));
      if (pullConflicts(store, found, pull)) return rpcResult(id, toolCallError(`pull request #${number} conflicts`));
      const mergeSha = squashMerge(store, found, pull);
      if (mergeSha === null) return rpcResult(id, toolCallError(`pull request #${number} conflicts`));
      store.markMerged(found, pull, mergeSha);
      return rpcResult(id, toolCallResult({ merged: true, number, state: 'closed', merge_commit_sha: mergeSha }));
    }
    default:
      return rpcError(id, -32601, `method not found: ${name}`);
  }
}

/** Serve POST /mcp; the router has already authenticated the request and read the body whole. */
export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  void req;
  let text: string;
  try {
    text = body.toString('utf8');
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const envelope = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (typeof envelope.method !== 'string') {
    sendJson(res, 400, rpcError(envelope.id ?? null, -32600, 'Invalid Request'));
    return;
  }
  const method: string = envelope.method;
  const id: unknown = envelope.id;

  // The modern handshake probe: the one answer every later request depends on.
  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [REVISION],
      capabilities: { tools: { listChanged: false } },
      instructions: 'GitHub-compatible forge: repository, issue and pull-request tools.',
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return;
  }

  // The legacy handshake, kept answering for a client that never discovered the modern one.
  if (method === 'initialize') {
    const params = (envelope.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, toolsListResult()));
    return;
  }

  if (method === 'tools/call') {
    const params = (envelope.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args =
      params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    sendJson(res, 200, callTool(store, id, name, args));
    return;
  }

  // Any other method: a JSON-RPC error, never HTTP 500.
  sendJson(res, 200, rpcError(id, -32601, `method not found: ${method}`));
}
