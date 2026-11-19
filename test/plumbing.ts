// A plumbing smoke test: hash objects against git's known vectors, round-trip a tree, round-trip a
// pack, and confirm the pkt-line reader and writer agree. Run: node --experimental-strip-types test/plumbing.ts
import { strict as assert } from 'node:assert';
import { makeBlob, hashObject, parseCommit, makeCommit, makeTree, parseTree, serializeTree, MODE_FILE, MODE_TREE } from '../src/git/objects.ts';
import { readPack, writePack, packChecksumOk } from '../src/git/pack.ts';
import { pktLine, pktText, readPkts, PKT_FLUSH, PKT_DELIM } from '../src/git/pkt.ts';

// git hash-object --stdin vectors, confirmed against real git.
assert.equal(hashObject('blob', Buffer.from('what is up, doc?')), 'bd9dbf5aae1a3862dd1526723246b20206e5fc37');
assert.equal(hashObject('blob', Buffer.from('hello world\n')), '3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
const tree = makeTree([
  { mode: MODE_FILE, name: 'hello', sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad' },
  { mode: MODE_TREE, name: 'sub', sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' },
]);
// git mktree --missing over the same entries: 609755375b0ed329d4e0b64832add8c99a601dd7.
assert.equal(hashObject('tree', tree.data), '609755375b0ed329d4e0b64832add8c99a601dd7');
assert.deepEqual(parseTree(tree.data), [
  { mode: '100644', name: 'hello', sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad' },
  { mode: '040000', name: 'sub', sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' },
]);
assert.equal(serializeTree(parseTree(tree.data)).toString('hex'), tree.data.toString('hex'));

// A commit round-trip, tree and parents preserved.
const person = { name: 'A U Thor', email: 'author@example.com', epochSec: 1735689600, tz: '+0000' };
const commit = makeCommit({ tree: tree.data ? hashObject('tree', tree.data) : '', parents: ['4b825dc642cb6eb9a060e54bf8d69288fbee4904'], author: person, committer: person, message: 'subject\n\nbody\n' });
const parsed = parseCommit(commit.data);
assert.ok(parsed !== null);
assert.equal(parsed.author.email, 'author@example.com');
assert.equal(parsed.parents.length, 1);
assert.equal(parsed.message, 'subject\n\nbody\n');

// A pack round-trip: write, verify the checksum, read, and compare shas.
const blob = makeBlob(Buffer.from('pack payload\n'));
const pack = writePack([blob, tree, commit]);
assert.ok(packChecksumOk(pack));
const read = readPack(pack);
assert.equal(read.order.length, 3);
for (const sha of read.order) {
  const obj = read.objects.get(sha);
  assert.ok(obj !== undefined);
}
assert.ok(read.objects.get(hashObject('blob', Buffer.from('pack payload\n'))) !== undefined);
assert.ok(read.objects.get(hashObject('commit', commit.data)) !== undefined);

// pkt-line: write three payloads and a flush, read them back in order.
const stream = Buffer.concat([pktText('line one'), pktLine(Buffer.from('raw')), PKT_FLUSH, PKT_DELIM, pktText('after delim')]);
const { pkts } = readPkts(stream);
assert.equal(pkts.length, 5);
assert.equal(pkts[0].kind === 'data' ? pkts[0].data.toString('utf8') : '', 'line one\n');
assert.equal(pkts[2].kind, 'control');
assert.equal(pkts[2].kind === 'control' ? pkts[2].control : '', 'flush');
assert.equal(pkts[3].kind === 'control' ? pkts[3].control : '', 'delim');

console.log('plumbing ok');
