// The raw TCP transport: HTTP/1.1 parsed by hand off the socket, one buffer per request, one
// write per response, and keep-alive held open without a single intermediate object beyond the
// parser's own slice. The handlers stay synchronous; a request is read whole, routed, answered,
// and the socket goes straight back to waiting for the next one. This is where the per-request
// cost the benchmark measures actually lives, so nothing here allocates more than it must.

import { createServer, type Socket } from 'node:net';

import { Store } from './store.ts';
import { type HttpRequest, HttpResponse, QueryMap } from './http-shim.ts';
import { route } from './router.ts';
import { pathClass, profile } from './profile.ts';

/** The most one request body may hold; the suite's packs are far under. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The reason phrases the forge answers with. */
const REASON: Readonly<Record<number, string>> = Object.freeze({
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
});

/** Serialize one staged response into the bytes the wire carries. */
function serialize(res: HttpResponse, close: boolean): Buffer {
  const headers: string[] = [`HTTP/1.1 ${res.status} ${REASON[res.status] ?? 'OK'}`];
  let hasLength = false;
  for (const [name, value] of res.headers) {
    if (name === 'content-length') hasLength = true;
    headers.push(`${name}: ${value}`);
  }
  if (!hasLength) headers.push(`content-length: ${res.body.length}`);
  if (close) headers.push('connection: close');
  const head = Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'latin1');
  return Buffer.concat([head, res.body], head.length + res.body.length);
}

/** One connection's parser state. */
interface ConnectionState {
  buffer: Buffer;
  /** The offset of the next unparsed byte (requests pipelined in one chunk are rare but legal). */
  closed: boolean;
}

/** Serve the forge over raw TCP: bind nothing until the caller listens; the entry listens on an
 * ephemeral port and hands it to the env. */
export function createRawServer(store: Store): ReturnType<typeof createServer> {
  return createServer((socket: Socket) => {
    // Nagle off: a response is one write, and it must leave at once (Node's http module does the
    // same on every connection it accepts).
    socket.setNoDelay(true);
    const state: ConnectionState = { buffer: Buffer.alloc(0), closed: false };
    socket.on('data', (chunk: Buffer) => {
      if (state.closed) return;
      state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
      if (state.buffer.length > MAX_BODY_BYTES + 65536) {
        socket.destroy();
        return;
      }
      for (;;) {
        const served = serveOne(store, state, socket);
        if (!served) break;
      }
    });
    socket.on('error', () => {
      state.closed = true;
      socket.destroy();
    });
  });
}

/**
 * Parse and answer one whole request from the connection's buffer, returning false when the
 * buffer holds less than a complete request (the next chunk continues it).
 */
function serveOne(store: Store, state: ConnectionState, socket: Socket): boolean {
  const buffer = state.buffer;
  const headEnd = buffer.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    // A header block that never ends: give up rather than buffer forever.
    if (buffer.length > 65536) socket.destroy();
    return false;
  }
  const head = buffer.toString('latin1', 0, headEnd);
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const space = requestLine.indexOf(' ');
  const second = space < 0 ? -1 : requestLine.indexOf(' ', space + 1);
  if (space <= 0 || second <= space) {
    socket.destroy();
    return false;
  }
  const method = requestLine.slice(0, space);
  const target = requestLine.slice(space + 1, second);
  const version = requestLine.slice(second + 1);
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') {
    socket.destroy();
    return false;
  }
  const headers: Record<string, string> = {};
  let close = version === 'HTTP/1.0';
  for (let at = 1; at < lines.length; at += 1) {
    const line = lines[at];
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
    if (name === 'connection') {
      if (value.toLowerCase() === 'close') close = true;
      else if (value.toLowerCase() === 'keep-alive') close = false;
    }
  }

  // The body: the suite's clients always send content-length; chunked is handled too, for safety.
  let bodyStart = headEnd + 4;
  let bodyEnd = bodyStart;
  const lengthHeader = headers['content-length'];
  if (lengthHeader !== undefined && /^\d+$/.test(lengthHeader)) {
    const length = Number(lengthHeader);
    if (length > MAX_BODY_BYTES) {
      const res = new HttpResponse();
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(Buffer.from('{"message":"Payload too large"}\n'));
      socket.write(serialize(res, true));
      socket.end();
      state.closed = true;
      return false;
    }
    bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return false;
  } else if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
    const chunked = parseChunked(buffer, bodyStart);
    if (chunked === null) return false;
    bodyStart = chunked.bodyStart;
    bodyEnd = chunked.bodyEnd;
    if (bodyStart !== bodyEnd && buffer.length < bodyEnd) return false;
  }

  const queryAt = target.indexOf('?');
  const path = queryAt < 0 ? target : target.slice(0, queryAt);
  const query = new QueryMap(queryAt < 0 ? '' : target.slice(queryAt + 1));
  const body =
    headers['transfer-encoding']?.toLowerCase().includes('chunked')
      ? decodeChunked(buffer, bodyStart, bodyEnd)
      : buffer.subarray(bodyStart, bodyEnd);

  const res = new HttpResponse();
  const request: HttpRequest = { method, path, query, headers, body };
  const profiling = process.env.FORGE_PROFILE === '1';
  const startedAt = profiling ? process.hrtime.bigint() : 0n;
  try {
    route(store, request, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      const detail = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && process.env.FORGE_DEBUG === '1' ? ` :: ${String(err.stack).slice(0, 600)}` : '';
      res.end(Buffer.from(`{"message":"Internal error: ${detail}${stack}"}\n`));
    }
  }
  if (profiling) {
    const took = Number(process.hrtime.bigint() - startedAt) / 1e6;
    profile(store, `${method} ${pathClass(path)}`, took);
  }

  state.buffer = buffer.subarray(bodyEnd);
  socket.write(serialize(res, close));
  if (close) {
    socket.end();
    state.closed = true;
    return false;
  }
  return state.buffer.length >= 4;
}

/** A chunked body's decoded bytes (the suite never sends chunked; this is safety). */
function decodeChunked(buffer: Buffer, start: number, end: number): Buffer {
  const parts: Buffer[] = [];
  let at = start;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = Number.parseInt(buffer.toString('latin1', at, lineEnd).split(';')[0] ?? '', 16);
    if (!Number.isFinite(size) || size === 0) break;
    at = lineEnd + 2;
    if (at + size > end) break;
    parts.push(buffer.subarray(at, at + size));
    at = at + size + 2;
  }
  return parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts);
}

/** Parse a chunked body's extent; returns its decoded bounds, or null when incomplete. */
function parseChunked(buffer: Buffer, start: number): { bodyStart: number; bodyEnd: number } | null {
  let at = start;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', at);
    if (lineEnd < 0) return null;
    const size = Number.parseInt(buffer.toString('latin1', at, lineEnd).split(';')[0] ?? '', 16);
    if (!Number.isFinite(size)) return null;
    at = lineEnd + 2;
    if (size === 0) {
      if (buffer.length < at + 2) return null;
      return { bodyStart: start, bodyEnd: at + 2 };
    }
    if (buffer.length < at + size + 2) return null;
    at = at + size + 2;
  }
}
