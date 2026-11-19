// Packfile v2, both directions. receive-pack hands the forge a pack of pushed objects (full objects
// and possibly deltas) that it must parse into its store, and upload-pack answers clones and fetches
// with a pack it builds itself. The format is fixed by git: a 12-byte header, objects back-to-back
// each opened by a varint size/type header then one zlib stream, and a 20-byte sha1 trailer over the
// whole preceding body. Node's zlib sync API reports exactly how many input bytes one stream consumed
// (`inflateSync(buf, { info: true }).engine.bytesWritten`), which is what makes walking the objects
// of a pack without an index possible at all.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

import { hashObject, type GitObject, type GitObjectType, PACK_TYPE_OF, TYPE_OF_PACK_NUMBER } from './objects.ts';

/** A parsed pack: its objects keyed by sha, in the order the pack held them. */
export interface ParsedPack {
  /** Every object, full (deltas applied), keyed by its hex sha. */
  readonly objects: Map<string, GitObject>;
  /** The shas in pack order, for base-by-offset lookups and store insert order. */
  readonly order: readonly string[];
}

/** The pack type numbers that carry a delta payload. */
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

/** Read the little-endian 7-bit-group varint a delta header opens with. */
function readDeltaSize(delta: Buffer, at: number): { size: number; at: number } {
  let size = 0;
  let shift = 0;
  for (;;) {
    const b = delta[at];
    at += 1;
    size |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { size, at };
}

/**
 * Apply one git delta to its base, as `git apply-delta` does: a source size, a target size, then
 * copy ops (from the base, addressed by offset and length) and insert ops (literal bytes) until the
 * target is built. A malformed op stops the apply at the shortest sane boundary rather than throwing
 * mid-write into the store.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaSize(delta, 0);
  if (src.size !== base.length) throw new Error('delta base size mismatch');
  const dst = readDeltaSize(delta, src.at);
  const out = Buffer.allocUnsafe(dst.size);
  let at = dst.at;
  let wrote = 0;
  while (at < delta.length && wrote < dst.size) {
    const op = delta[at];
    at += 1;
    if ((op & 0x80) !== 0) {
      // Copy: bits 0..3 name the offset bytes, bits 4..6 the size bytes, little-endian; a size of
      // zero is git's shorthand for 0x10000.
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (1 << (4 + bit))) !== 0) {
          size |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of base bounds');
      base.copy(out, wrote, offset, offset + size);
      wrote += size;
    } else {
      // Insert: the low 7 bits are the literal length.
      const size = op & 0x7f;
      if (size === 0 || at + size > delta.length) throw new Error('delta insert out of bounds');
      delta.copy(out, wrote, at, at + size);
      at += size;
      wrote += size;
    }
  }
  if (wrote !== dst.size) throw new Error('delta produced the wrong target size');
  return out;
}

/**
 * Parse a whole packfile into full objects. Deltas resolve against their base wherever it lives:
 * earlier in the same pack (ofs-delta, by payload offset) or already in `known` (ref-delta, by sha,
 * including objects the same pack already produced). `known` is optional; without it a ref-delta
 * whose base is not in the pack throws, which is the only honest answer.
 */
export function readPack(buf: Buffer, known?: ReadonlyMap<string, GitObject>): ParsedPack {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile: missing PACK signature');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not 2 or 3`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const order: string[] = [];
  // Payload offsets by sha and by arrival, for ofs-delta bases.
  const offsetBySha = new Map<string, number>();
  const arrivals: { sha: string; offset: number }[] = [];
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const payloadAt = at;
    // The object header: type in bits 4..6 of the first byte, size in 4-bit then 7-bit groups.
    const first = buf[at];
    at += 1;
    let typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let cont = (first & 0x80) !== 0;
    while (cont) {
      const b = buf[at];
      at += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      cont = (b & 0x80) !== 0;
    }
    let base: GitObject | undefined;
    if (typeNum === TYPE_OFS_DELTA) {
      // A negative offset in git's "add one, shift seven" big-endian continuation encoding.
      let b = buf[at];
      at += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[at];
        at += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const baseAt = payloadAt - offset;
      const found = arrivals.find((entry) => entry.offset === baseAt);
      if (found === undefined) throw new Error('ofs-delta base not found in pack');
      base = objects.get(found.sha);
    } else if (typeNum === TYPE_REF_DELTA) {
      const baseSha = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      base = objects.get(baseSha) ?? known?.get(baseSha);
    } else if (!(typeNum in TYPE_OF_PACK_NUMBER)) {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
    // One zlib stream: inflate exactly it and learn where the next object starts.
    const inflated = inflateSync(buf.subarray(at), { info: true });
    const payload = Buffer.from(inflated.buffer);
    at += inflated.engine.bytesWritten;
    if (base === undefined && (typeNum === TYPE_OFS_DELTA || typeNum === TYPE_REF_DELTA)) {
      throw new Error('delta without a resolvable base');
    }
    let type: GitObjectType;
    let data: Buffer;
    if (typeNum === TYPE_OFS_DELTA || typeNum === TYPE_REF_DELTA) {
      type = base.type;
      data = applyDelta(base.data, payload);
    } else {
      type = TYPE_OF_PACK_NUMBER[typeNum];
      data = payload;
    }
    if (data.length !== size) throw new Error(`object size ${data.length} disagrees with header ${size}`);
    const sha = hashObject(type, data);
    objects.set(sha, { type, data });
    order.push(sha);
    arrivals.push({ sha, offset: payloadAt });
    offsetBySha.set(sha, payloadAt);
  }
  return { objects, order };
}

/** The header varint of one object: type in the first byte's high bits, size in 4- then 7-bit groups. */
function objectHeader(typeNum: number, size: number): Buffer {
  const out: number[] = [];
  let rest = size;
  let b = (typeNum << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    out.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(b);
  return Buffer.from(out);
}

/**
 * Write a packfile of full objects, in the order given: PACK v2 header, each object as one
 * deflate stream (no deltas: the forge's clones are small, and a full pack is always a legal pack),
 * and the sha1 trailer the reader verifies. Deterministic for a given object list.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0].write('PACK', 0, 'ascii');
  parts[0].writeUInt32BE(2, 4);
  parts[0].writeUInt32BE(objects.length, 8);
  for (const object of objects) {
    parts.push(objectHeader(PACK_TYPE_OF[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The sha1 a packfile ends with, or null when the body is too short to carry one. */
export function packTrailer(pack: Buffer): Buffer | null {
  if (pack.length < 20) return null;
  return pack.subarray(pack.length - 20);
}

/** Whether a packfile's trailer matches its body: what a clone's checksum verification does. */
export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expect = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  return expect.equals(pack.subarray(pack.length - 20));
}

/** A crc32 over a buffer, as the pack index carries per object (kept for verification paths). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let at = 0; at < data.length; at += 1) {
    crc = CRC32_TABLE[(crc ^ data[at]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();
