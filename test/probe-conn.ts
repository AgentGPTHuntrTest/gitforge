// Does undici keep one connection alive against the raw server, or reconnect per request?
process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
process.env.MAKEFUN_TRIAL_NOW = '2026-11-19T00:00:00.000Z';
const { createApp } = await import('../app.ts');
const { Store } = await import('../src/store.ts');
const net = await import('node:net');

const store = new Store();
const server = createApp(store) as unknown as net.Server;
let connections = 0;
server.on('connection', () => { connections += 1; });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const auth = { authorization: 'Bearer test-token-123' };
await fetch(`http://127.0.0.1:${port}/api/v3/user/repos`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'r' }) });
const started = connections;
for (let at = 0; at < 20; at += 1) {
  await fetch(`http://127.0.0.1:${port}/healthz`);
}
console.log('connections for 20 GETs after warmup:', connections - started);
const startedPosts = connections;
for (let at = 0; at < 10; at += 1) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/adaiversen/r/issues`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) });
  if (res.status !== 201) console.log('unexpected status', res.status, await res.text());
}
console.log('connections for 10 POSTs:', connections - startedPosts);
server.close();
process.exit(0);
