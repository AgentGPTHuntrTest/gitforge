// Run the suite's benchmark against a fresh in-process forge and print the server-side profile.
process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
process.env.MAKEFUN_TRIAL_NOW = '2026-11-19T00:00:00.000Z';
process.env.MAKEFUN_TRIAL_SEED = 'ab12cd34ef56';
process.env.FORGE_PROFILE = '1';

const { createApp } = await import('../app.ts');
const { Store } = await import('../src/store.ts');

const store = new Store();
const server = createApp(store);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
console.log('forge on port', port);

const kit = 'D:/Gitest/github-core-clone-01-kit';
const child = (await import('node:child_process')).spawn(
  'D:/Gitest/tools/node22/node-v22.23.5-win-x64/node.exe',
  ['--experimental-strip-types', 'sdk/run.ts', '--url', `http://127.0.0.1:${port}`, '--token', 'test-token-123', '--timeout-ms', '15000', '--perf'],
  { cwd: kit, stdio: ['ignore', 'pipe', 'pipe'] },
);
let out = '';
child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
await new Promise<void>((resolve) => child.on('close', () => resolve()));

const at = out.lastIndexOf('perf points_total');
console.log(out.slice(Math.max(0, at - 800)));

const res = await fetch(`http://127.0.0.1:${port}/__profile`);
const profile = (await res.json()) as { rows: { key: string; count: number; totalMs: number; maxMs: number }[] };
console.log('\nserver-side handling time (count >= 4):');
let total = 0;
for (const row of profile.rows) {
  if (row.count < 4) continue;
  total += row.totalMs;
  console.log(row.key.padEnd(22), String(row.count).padStart(6), `${Math.round(row.totalMs)}ms`.padStart(9), `avg ${(row.totalMs / row.count).toFixed(3)}ms`.padStart(15), `max ${row.maxMs.toFixed(1)}ms`);
}
console.log('server-side total:', `${Math.round(total)}ms`);
server.close();
process.exit(0);
