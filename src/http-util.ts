// The wire helpers every surface shares: one JSON sender that stamps the request id GitHub clients
// expect on every reply, the id counter itself (deterministic: same request order, same ids), and
// the JSON error body the wire contract names.

import { HttpResponse } from './http-shim.ts';

/** The request id counter: deterministic across runs because the suite's request order is fixed. */
let requestCounter = 0;

/** The next request id, non-empty on the wire. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `R${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Send a JSON body with the request id header and an exact content length. */
export function sendJson(res: HttpResponse, status: number, body: unknown, headers: Record<string, string> = {}, raw?: Buffer): void {
  const bytes = raw ?? Buffer.from(`${JSON.stringify(body ?? null)}\n`);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(bytes);
}

/** A reply with no body (204 and friends): still carries the id. */
export function sendEmpty(res: HttpResponse, status: number): void {
  res.writeHead(status, { 'content-length': '0', 'x-github-request-id': nextRequestId() });
  res.end(Buffer.alloc(0));
}

/** The GitHub error body every error route answers with. */
export function errorMessage(message: string): Record<string, unknown> {
  return { message, documentation_url: 'https://docs.github.com/rest' };
}
