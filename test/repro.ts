// Reproduce the contents PUT/GET 404 in-process, with the internals visible.
import { createApp } from '../app.ts';
import { Store } from '../src/store.ts';
import { parseCommit } from '../src/git/objects.ts';

process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
process.env.MAKEFUN_TRIAL_NOW = '2026-11-19T00:00:00.000Z';

const store = new Store();
const server = createApp(store);
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const auth = { authorization: 'Bearer test-token-123', 'content-type': 'application/json' };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

console.log('create:', (await call('POST', '/api/v3/user/repos', { name: 'probe', private: true })).status);
const put = await call('PUT', '/api/v3/repos/adaiversen/probe/contents/config/token.css', {
  message: 'Tidy issue pagination',
  content: Buffer.from('hello smoke\n').toString('base64'),
});
console.log('put:', put.status, put.text);

const repo = store.getRepo('adaiversen', 'probe')!;
console.log('refs:', JSON.stringify([...repo.refs.entries()]));
const tip = repo.refs.get('refs/heads/main')!;
const commitObject = repo.objects.get(tip)!;
const parsed = parseCommit(commitObject.data);
console.log('commit tree:', parsed.tree);
const treeObject = repo.objects.get(parsed.tree);
console.log('tree object present:', treeObject !== undefined, treeObject?.type);
if (treeObject !== undefined) {
  console.log('tree bytes:', JSON.stringify(treeObject.data.toString('latin1')));
}

const get = await call('GET', '/api/v3/repos/adaiversen/probe/contents/config/token.css');
console.log('get:', get.status, get.text.slice(0, 200));
const dir = await call('GET', '/api/v3/repos/adaiversen/probe/contents/config');
console.log('dir:', dir.status, dir.text.slice(0, 500));
server.close();
process.exit(0);
