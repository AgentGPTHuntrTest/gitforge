// The transport-independent request and response the forge's handlers speak: a parsed request
// (method, path, decoded query, lowercase headers, whole body) and a response that only buffers
// (status, headers, body) — the raw TCP transport serializes it in one write, and the Node http
// transport could feed the same core through a thin adapter. Keeping the surface this small is
// what lets the hot paths answer a request in tens of microseconds.

/** A parsed HTTP request, exactly the fields the handlers read. */
export interface HttpRequest {
  readonly method: string;
  /** The raw path, undecoded, as it arrived ('/api/v3/repos/a/b'). */
  readonly path: string;
  /** Query parameters, decoded on demand. */
  readonly query: QueryMap;
  /** Header names lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  /** The whole body, read before dispatch. */
  readonly body: Buffer;
}

/** The query parameters the handlers use, decoded lazily and cached. */
export class QueryMap {
  private readonly raw: string;
  private readonly cache = new Map<string, string | null>();

  constructor(raw: string) {
    this.raw = raw;
  }

  /** One parameter's value, decoded, or null when absent. */
  get(name: string): string | null {
    const hit = this.cache.get(name);
    if (hit !== undefined) return hit;
    const value = this.decode(this.find(name));
    this.cache.set(name, value);
    return value;
  }

  /** The raw `?`-less query text, split and decoded for one name. */
  private find(name: string): string | null {
    for (const pair of this.raw.split('&')) {
      if (pair === '') continue;
      const at = pair.indexOf('=');
      const key = at < 0 ? pair : pair.slice(0, at);
      if (key === name) return at < 0 ? '' : pair.slice(at + 1);
    }
    return null;
  }

  /** Percent-decoding plus the form encoding the suite's clients use; absent stays absent. */
  private decode(value: string | null): string | null {
    if (value === null) return null;
    if (value.indexOf('%') < 0 && value.indexOf('+') < 0) return value;
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      return value;
    }
  }
}

/** A buffered response: the handlers fill it, the transport writes it. */
export class HttpResponse {
  status = 200;
  headers: (readonly [string, string])[] = [];
  body: Buffer = Buffer.alloc(0);
  headersSent = false;

  /** Stage the status line and headers; nothing reaches a socket until end(). */
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    this.headers = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const);
    this.headersSent = true;
    return this;
  }

  /** Stage the body; the transport serializes status, headers and body in one write. */
  end(body?: Buffer | string): this {
    if (body !== undefined) this.body = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    return this;
  }
}
