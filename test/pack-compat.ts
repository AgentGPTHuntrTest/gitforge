// The suite's writePack output against my readPack: the exact bytes both sides agree on.
process.env.MAKEFUN_TRIAL_NOW = '2026-11-19T00:00:00.000Z';
const { writePack } = await import('../../github-core-clone-01-kit/program/env/src/git-client.ts');
const { readPack } = await import('../src/git/pack.ts');
const { hashObject } = await import('../src/git/objects.ts');

const blob = Buffer.from('the quick brown fox\njumps over the lazy dog\n'.repeat(20));
const treeBytes = Buffer.concat([
  Buffer.from(`100644 sample.txt\0`, 'utf8'),
  Buffer.from(hashObject('blob', blob), 'hex'),
]);
const commit = Buffer.from(
  `tree ${hashObject('tree', treeBytes)}\n` +
    `author A U Thor <author@example.com> 1735689600 +0000\n` +
    `committer A U Thor <author@example.com> 1735689600 +0000\n\nfixture: first commit\n`,
  'utf8',
);

const pack = writePack([
  { type: 'blob', data: blob },
  { type: 'tree', data: treeBytes },
  { type: 'commit', data: commit },
]);
console.log('suite pack bytes:', pack.length, 'header:', pack.subarray(0, 12).toString('hex'));
try {
  const parsed = readPack(pack);
  console.log('parsed objects:', parsed.order.length);
  for (const sha of parsed.order) {
    const object = parsed.objects.get(sha)!;
    console.log(' ', object.type, sha);
  }
} catch (err) {
  console.log('readPack threw:', err instanceof Error ? err.message : String(err));
}
