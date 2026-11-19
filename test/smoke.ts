// A smoke run against a fresh forge, started in-process on an ephemeral port: the routes a first
// integration pass should prove. Run: node --experimental-strip-types test/smoke.ts
import { strict as assert } from 'node:assert';

// The env vars first: the app's modules read them at load, so the imports come after.
process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
process.env.MAKEFUN_TRIAL_NOW = '2026-11-19T00:00:00.000Z';
process.env.MAKEFUN_TRIAL_SEED = 'ab12cd34ef56';

const { createApp } = await import('../app.ts');
const { Store } = await import('../src/store.ts');

const store = new Store();
const server = createApp(store);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN;
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/vnd.github+json' };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = auth): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// Boot and auth discipline.
assert.equal((await call('GET', '/healthz', undefined, {})).json.ok, true);
assert.equal((await call('GET', '/api/v3/repos/adaiversen/nope', undefined, {})).status, 401);
assert.equal((await call('GET', '/api/v3/no-such-route', undefined, {})).status, 401);
assert.equal((await call('GET', '/api/v3/no-such-route')).status, 404);
assert.equal((await call('GET', '/api/v3/')).status, 200);
assert.equal((await call('GET', '/api/v3/meta')).json.installed_version.length > 0, true);
assert.equal((await call('GET', '/api/v3/user')).json.login, 'adaiversen');

// A repository, its first commit, and its issue.
const created = await call('POST', '/api/v3/user/repos', { name: 'smoke-repo', private: true, description: 'smoke' });
assert.equal(created.status, 201, `create repo: ${created.status} ${created.text}`);
assert.equal(created.json.private, true);
const dup = await call('POST', '/api/v3/user/repos', { name: 'smoke-repo' });
assert.equal(dup.status, 422);
assert.match(dup.json.message, /already exists/i);
const put = await call('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/config/token.css', {
  message: 'Tidy issue pagination',
  content: Buffer.from('hello smoke\n').toString('base64'),
});
assert.equal(put.status, 201, `put contents: ${put.status} ${put.text}`);
assert.match(put.json.commit.sha, /^[0-9a-f]{40}$/);
const read = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/config/token.css');
assert.equal(read.status, 200);
assert.equal(Buffer.from(read.json.content, 'base64').toString(), 'hello smoke\n');
const dir = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/config');
assert.equal(dir.status, 200);
assert.equal(Array.isArray(dir.json), true);
assert.equal(dir.json.some((entry: any) => entry.name === 'token.css'), true);
const branches = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/branches');
assert.equal(branches.json.some((branch: any) => branch.name === 'main'), true);
const commits = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/commits');
assert.equal(commits.json[0].commit.message, 'Tidy issue pagination');

// A branch, a commit on it, and the issue flows.
const ref = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/git/refs', { ref: 'refs/heads/develop-smoke', sha: put.json.commit.sha });
assert.equal(ref.status, 201, `create ref: ${ref.status} ${ref.text}`);
const onBranch = await call('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/config/on-branch.txt', {
  message: 'branch commit',
  content: Buffer.from('on branch\n').toString('base64'),
  branch: 'develop-smoke',
});
assert.equal(onBranch.status, 201, `branch commit: ${onBranch.status} ${onBranch.text}`);
const branchCommits = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/commits?sha=develop-smoke');
assert.equal(branchCommits.json.some((entry: any) => entry.sha === onBranch.json.commit.sha), true);
const mainCommits = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/commits');
assert.equal(mainCommits.json.some((entry: any) => entry.sha === onBranch.json.commit.sha), false);

const label = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/labels', { name: 'bug', color: 'ededed' });
assert.equal(label.status, 201);
const issue = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'Incorrect GraphQL node ids', body: 'the body', labels: ['bug'] });
assert.equal(issue.status, 201, `create issue: ${issue.status} ${issue.text}`);
assert.equal(issue.json.state, 'open');
assert.equal(issue.json.labels[0].name, 'bug');
const badLabel = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'x', body: 'y', labels: ['nope'] });
assert.equal(badLabel.status, 422);
const second = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'second', body: 'b' });
assert.equal(second.json.number, issue.json.number + 1);
const one = await call('GET', `/api/v3/repos/adaiversen/smoke-repo/issues/${issue.json.number}`);
assert.equal(one.json.title, 'Incorrect GraphQL node ids');
const closed = await call('PATCH', `/api/v3/repos/adaiversen/smoke-repo/issues/${second.json.number}`, { state: 'closed' });
assert.equal(closed.json.state, 'closed');
const openList = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/issues?state=open');
assert.equal(openList.json.some((entry: any) => entry.number === second.json.number), false);
assert.equal(openList.json.some((entry: any) => entry.number === issue.json.number), true);
const comment = await call('POST', `/api/v3/repos/adaiversen/smoke-repo/issues/${issue.json.number}/comments`, { body: 'a comment' });
assert.equal(comment.status, 201);
const comments = await call('GET', `/api/v3/repos/adaiversen/smoke-repo/issues/${issue.json.number}/comments`);
assert.equal(comments.json.some((entry: any) => entry.body === 'a comment'), true);

// A pull request, its files, and its squash merge.
const pull = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/pulls', {
  title: 'Improve MCP tool schemas',
  body: 'pr body',
  head: 'develop-smoke',
  base: 'main',
});
assert.equal(pull.status, 201, `create pull: ${pull.status} ${pull.text}`);
assert.equal(pull.json.head.ref, 'develop-smoke');
assert.equal(pull.json.base.ref, 'main');
const pullFiles = await call('GET', `/api/v3/repos/adaiversen/smoke-repo/pulls/${pull.json.number}/files`);
assert.equal(pullFiles.json.some((file: any) => file.filename === 'config/on-branch.txt' && file.status === 'added'), true, JSON.stringify(pullFiles.json));
const merge = await call('PUT', `/api/v3/repos/adaiversen/smoke-repo/pulls/${pull.json.number}/merge`, { merge_method: 'squash' });
assert.equal(merge.status, 200, `merge: ${merge.status} ${merge.text}`);
assert.equal(merge.json.merged, true);
const mergedPull = await call('GET', `/api/v3/repos/adaiversen/smoke-repo/pulls/${pull.json.number}`);
assert.equal(mergedPull.json.merged, true);
assert.equal(mergedPull.json.state, 'closed');
assert.equal(typeof mergedPull.json.merged_at, 'string');
assert.match(String(mergedPull.json.merged_at), /.+/);
assert.equal(mergedPull.json.merge_commit_sha, merge.json.sha);
const mergedContent = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/config/on-branch.txt?ref=main');
assert.equal(Buffer.from(mergedContent.json.content, 'base64').toString(), 'on branch\n');

// GraphQL: the viewer, a repository, introspection, and a mutation round trip.
const gql = async (query: string, variables: Record<string, unknown> = {}): Promise<any> => {
  const answer = await call('POST', '/api/graphql', { query, variables });
  assert.equal(answer.status, 200, `graphql: ${answer.text}`);
  return answer.json;
};
const viewer = await gql('query { viewer { login } }');
assert.equal(viewer.data.viewer.login, 'adaiversen');
const repoQuery = await gql('query R($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }', { owner: 'adaiversen', name: 'smoke-repo' });
assert.equal(repoQuery.data.repository.name, 'smoke-repo');
assert.equal(repoQuery.data.repository.defaultBranchRef.name, 'main');
assert.equal(repoQuery.data.repository.viewerPermission, 'ADMIN');
const missing = await gql('query M($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { name } }', { owner: 'adaiversen', name: 'smoke-missing' });
assert.equal(missing.data.repository, null);
assert.equal(missing.errors, undefined);
const introspected = await gql('query { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }');
const fieldNames = introspected.data.Issue.fields.map((field: any) => field.name);
for (const name of ['id', 'number', 'title', 'state', 'body']) assert.equal(fieldNames.includes(name), true, `Issue fields lack ${name}`);
const invalid = await gql('query { viewer { login noSuchFieldOnViewer } }');
assert.equal(invalid.errors.length > 0, true);
assert.equal(invalid.errors.some((error: any) => error.message.includes('noSuchFieldOnViewer')), true);
const batched = await call('POST', '/api/graphql', [
  { query: 'query { viewer { login } }', variables: {} },
  { query: 'query { Issue: __type(name: "Issue") { fields { name } } }', variables: {} },
]);
assert.equal(Array.isArray(batched.json), true);
assert.equal(batched.json.length, 2);
assert.equal(batched.json[0].data.viewer.login, 'adaiversen');
assert.equal((await call('POST', '/api/graphql', { query: 'query { viewer { login } }' }, { 'content-type': 'application/json' })).status, 401);

// MCP: the modern handshake, the tool list twice, and a call that mints an issue REST can read.
const discover = await call('POST', '/mcp', { jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: { _meta: {} } });
assert.equal(discover.status, 200, `discover: ${discover.text}`);
assert.equal(discover.json.result.supportedVersions.includes('2026-07-28'), true);
assert.equal(typeof discover.json.result.serverInfo.name, 'string');
const list1 = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {} } });
const list2 = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: {} } });
assert.equal(JSON.stringify(list1.json.result.tools), JSON.stringify(list2.json.result.tools));
const toolNames = list1.json.result.tools.map((tool: any) => tool.name);
for (const name of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
  assert.equal(toolNames.includes(name), true, `tools/list lacks ${name}`);
}
const mcpIssue = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'smoke-repo', title: 'made over mcp', body: 'mcp body' }, _meta: {} } });
assert.equal(mcpIssue.json.result.isError, false, mcpIssue.text);
const mcpNumber = mcpIssue.json.result.structuredContent.number;
const restRead = await call('GET', `/api/v3/repos/adaiversen/smoke-repo/issues/${mcpNumber}`);
assert.equal(restRead.status, 200);
assert.equal(restRead.json.title, 'made over mcp');
const unknownTool = await call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mcp_no_such_tool_x', arguments: {}, _meta: {} } });
assert.equal(unknownTool.json.error.code, -32602);
const parseError = await fetch(`${URL_BASE}/mcp`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"jsonrpc":' });
assert.equal(parseError.status, 400);
assert.equal((await parseError.json() as any).error.code, -32700);

// Unknown routes and methods stay JSON 404s.
assert.equal((await call('GET', '/')).status, 404);
assert.equal((await call('GET', '/api/v3/repos/adaiversen/nope/branches')).status, 404);

server.close();
console.log('smoke ok');
