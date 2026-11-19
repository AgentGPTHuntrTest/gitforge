// Probe a live forge's contents state after the smoke PUT: where the walk answers 404.
const base = 'http://127.0.0.1:8123';
const auth = { authorization: 'Bearer test-token-123', 'content-type': 'application/json', accept: 'application/vnd.github+json' };
async function show(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(base + path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  console.log(method, path, '->', res.status, text.slice(0, 300));
}
await show('GET', '/api/v3/repos/adaiversen/smoke-repo');
await show('GET', '/api/v3/repos/adaiversen/smoke-repo/branches');
await show('GET', '/api/v3/repos/adaiversen/smoke-repo/commits');
await show('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/config');
await show('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/config/token.css');
