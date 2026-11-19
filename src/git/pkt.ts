// pkt-line framing, as the git wire protocol defines it: every payload line is a 4-byte lowercase
// hex length that counts the four prefix bytes and the payload, and three control packets sit at
// fixed lengths. Protocol v2 adds delim-pkt (0001) and response-end-pkt (0002); v0 knows only the
// flush. A length of 0 is the flush; 1 the delim; 2 the response end; anything under 4 or past the
// buffer is malformed and stops the read.

/** A control packet the stream can carry beside payload lines. */
export type PktControl = 'flush' | 'delim' | 'end';

/** One decoded pkt: either a payload or a control. */
export type Pkt =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'control'; readonly control: PktControl };

/** The flush-pkt: ends a v0 section (or the whole v0 response when last). */
export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
/** The delim-pkt: protocol v2's section separator. */
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');
/** The response-end-pkt: protocol v2's polite end when the client asked to hold the connection. */
export const PKT_RESPONSE_END: Buffer = Buffer.from('0002', 'ascii');

/** The largest payload one pkt can frame: 65535 total bytes minus the 4-byte prefix. */
export const MAX_PKT_PAYLOAD = 65531;

/** The 4-byte lowercase hex length prefix of a pkt whose total length is `total`. */
function hexPrefix(total: number): Buffer {
  return Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
}

/** One payload pkt: the 4-byte hex length prefix plus the payload, nothing else. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (body.length > MAX_PKT_PAYLOAD) throw new Error('pkt payload overflows one pkt-line');
  return Buffer.concat([hexPrefix(4 + body.length), body]);
}

/** One payload pkt with a trailing LF, as the ref advertisement lines are framed. */
export function pktText(line: string): Buffer {
  return pktLine(`${line}\n`);
}

/**
 * Read every pkt from a body, in order. A length that is not a frameable pkt (under 4, over the
 * remaining bytes, or not hex) stops the read at that offset: a server that answers a bad client
 * with what it framed so far beats one that dies mid-negotiation.
 */
export function readPkts(body: Buffer, from = 0): { pkts: Pkt[]; read: number } {
  const pkts: Pkt[] = [];
  let at = from;
  while (at + 4 <= body.length) {
    const len = Number.parseInt(body.toString('ascii', at, at + 4), 16);
    if (len === 0) {
      pkts.push({ kind: 'control', control: 'flush' });
      at += 4;
      continue;
    }
    if (len === 1) {
      pkts.push({ kind: 'control', control: 'delim' });
      at += 4;
      continue;
    }
    if (len === 2) {
      pkts.push({ kind: 'control', control: 'end' });
      at += 4;
      continue;
    }
    if (!Number.isFinite(len) || len < 4 || len > body.length - at) break;
    pkts.push({ kind: 'data', data: body.subarray(at + 4, at + len) });
    at += len;
  }
  return { pkts, read: at };
}

/**
 * Split one stream of pkts into sections at each delim-pkt (protocol v2's command framing): a
 * section is the pkts between two delims, flushes included where the protocol sends them. A v0
 * stream (no delims) comes back as one section.
 */
export function readSections(body: Buffer): Pkt[][] {
  const { pkts } = readPkts(body);
  const sections: Pkt[][] = [[]];
  for (const pkt of pkts) {
    if (pkt.kind === 'control' && pkt.control === 'delim') {
      sections.push([]);
    } else {
      sections[sections.length - 1].push(pkt);
    }
  }
  return sections;
}

/** The payload lines of a section as UTF-8 strings without their trailing LF, controls dropped. */
export function sectionLines(section: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const pkt of section) {
    if (pkt.kind === 'data') lines.push(pkt.data.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}
