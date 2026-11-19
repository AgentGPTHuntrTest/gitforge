// The wire helpers every surface shares: one JSON sender that stamps the request id GitHub clients
// expect on every reply, the id counter itself (deterministic: same request order, same ids), and
// the body reader that buffers one request whole with a cap.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The request id counter: deterministic across runs because the suite's request order is fixed. */
let requestCounter = 0;

/** The next request id, non-empty on the wire. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `R${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Send a JSON body with the request id header and an exact content length. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  raw?: Buffer,
): void {
  const bytes = raw ?? Buffer.from(`${JSON.stringify(body ?? null)}\n`);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(bytes);
}

/** A reply with no body (204 and friends): still carries the id. */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': nextRequestId() });
  res.end();
}

/** The most one request body may hold; the suite's packs are far under. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read one request's body whole. Over-cap bodies end the response with a 413. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}
