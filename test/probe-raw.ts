// The failing contents GET against the raw server, message in hand.
process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
process.env.MAKEFUN_TRIAL_NOW = '2026-11-19T00:00:00.000Z';
const { createApp } = await import('../app.ts');
const { Store } = await import('../src/store.ts');
const store = new Store();
const server = createApp(store);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const auth = { authorization: 'Bearer test-token-123', 'content-type': 'application/json' };
console.log('create repo:', (await fetch(`http://127.0.0.1:${port}/api/v3/user/repos`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'r' }) })).status);
const put2 = await fetch(`http://127.0.0.1:${port}/api/v3/repos/adaiversen/r/contents/config/token.css`, { method: 'PUT', headers: auth, body: JSON.stringify({ message: 'm', content: Buffer.from('hello smoke\n').toString('base64') }) });
console.log('put:', put2.status, (await put2.text()).slice(0, 200));
const get = await fetch(`http://127.0.0.1:${port}/api/v3/repos/adaiversen/r/contents/config/token.css`, { headers: auth });
console.log('get:', get.status, (await get.text()).slice(0, 200));
server.close();
process.exit(0);
