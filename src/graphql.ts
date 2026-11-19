// GraphQL v4 at POST /api/graphql: a small, real parser for the documents gh and github-mcp-server
// send (operation names, variables with null values, aliases, inline enums and input objects,
// inline fragments) and a resolver over the same store the REST surface serves. Unknown fields are
// GraphQL-level errors — HTTP 200 with an errors array naming the field; unknown repositories are
// `data.repository: null` with no errors; an array body is operation batching, answered in order.

import { HttpResponse } from './http-shim.ts';

import { FORGE_LOGIN } from './env.ts';
import { sendJson } from './http-util.ts';
import { diffTrees, pullConflicts, squashMerge } from './merge.ts';
import { globalId, parseGlobalId } from './serialize.ts';
import { Store, type ForgeIssue, type ForgePull, type ForgeRepo } from './store.ts';

// ---------------------------------------------------------------- the parser

/** One parsed field selection. */
interface FieldSelection {
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }>;
  readonly selections: readonly Selection[] | null;
}

/** One parsed selection: a field or an inline fragment. */
type Selection =
  | { readonly kind: 'field'; readonly field: FieldSelection }
  | { readonly kind: 'fragment'; readonly on: string; readonly selections: readonly Selection[] };

/** One literal or variable value in the document. */
type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }> };

/** One parsed operation. */
interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly selections: readonly Selection[];
}

/** A tiny cursor: the whole document is a few hundred bytes. */
class Cursor {
  readonly text: string;
  at: number;

  constructor(text: string, at: number = 0) {
    this.text = text;
    this.at = at;
  }

  skipSpace(): void {
    while (this.at < this.text.length) {
      const char = this.text[this.at];
      if (char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === ',') this.at += 1;
      else break;
    }
  }

  /** The next punctuation or name token, or null at the end. */
  peek(): string | null {
    this.skipSpace();
    if (this.at >= this.text.length) return null;
    const char = this.text[this.at];
    if (char === '{' || char === '}' || char === '(' || char === ')' || char === ':' || char === '!' || char === '[' || char === ']' || char === '@') {
      return char;
    }
    if (char === '.' && this.text.slice(this.at, this.at + 3) === '...') return '...';
    if (char === '"') return '"';
    if (char === '$') return '$';
    const number = /^-?[0-9]+/.exec(this.text.slice(this.at));
    if (number !== null && number[0] !== '') return number[0];
    const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(this.text.slice(this.at));
    if (match !== null) return match[0];
    return char;
  }

  /** Consume a token; returns null at the end. */
  take(): string | null {
    const token = this.peek();
    if (token === null) return null;
    if (token === '...') this.at += 3;
    else if (token === '"') {
      const close = this.text.indexOf('"', this.at + 1);
      const value = this.text.slice(this.at + 1, close < 0 ? this.text.length : close);
      this.at = close < 0 ? this.text.length : close + 1;
      return `"${value}"`;
    } else this.at += token.length;
    return token;
  }

  /** Whether the next token is `token`, consuming it when it is. */
  eat(token: string): boolean {
    if (this.peek() === token) {
      this.at += token === '...' ? 3 : token.length;
      return true;
    }
    return false;
  }
}

/** Parse a whole document: one operation. Throws on malformed text. */
export function parseDocument(text: string): Operation {
  const cursor = new Cursor(text);
  let kind: 'query' | 'mutation' = 'query';
  cursor.skipSpace();
  let openedSet = false;
  if (cursor.eat('query')) kind = 'query';
  else if (cursor.eat('mutation')) kind = 'mutation';
  else if (cursor.eat('{')) openedSet = true;
  else throw new Error('a document opens with query, mutation or a selection set');
  if (!openedSet) {
    // An optional operation name, then optional variable definitions (values arrive per request).
    const next = cursor.peek();
    if (next !== null && next !== '{' && next !== '(' && /^[A-Za-z_]/.test(next)) cursor.take();
    if (cursor.eat('(')) {
      let depth = 1;
      while (depth > 0 && cursor.at < cursor.text.length) {
        const char = cursor.text[cursor.at];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        cursor.at += 1;
      }
    }
    if (!cursor.eat('{')) throw new Error('an operation opens a selection set');
  }
  const selections = parseSelectionSet(cursor);
  return { kind, selections };
}

/** Parse a selection set, the brace already seen by the caller's `eat`. */
function parseSelectionSet(cursor: Cursor): Selection[] {
  const selections: Selection[] = [];
  for (;;) {
    cursor.skipSpace();
    if (cursor.eat('}')) break;
    if (cursor.eat('...')) {
      // An inline fragment: `... on Type { ... }` (directives never appear in the suite's documents).
      if (!cursor.eat('on')) throw new Error('a fragment spread names a type');
      const on = cursor.take();
      if (on === null) throw new Error('a fragment names a type');
      if (!cursor.eat('{')) throw new Error('a fragment opens a selection set');
      selections.push({ kind: 'fragment', on, selections: parseSelectionSet(cursor) });
      continue;
    }
    const first = cursor.take();
    if (first === null) throw new Error('a selection set holds selections');
    let alias: string | null = null;
    let name = first;
    if (cursor.eat(':')) {
      alias = first;
      name = cursor.take() ?? '';
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (cursor.eat('(')) {
      for (;;) {
        if (cursor.eat(')')) break;
        const argName = cursor.take();
        if (argName === null || !cursor.eat(':')) {
          throw new Error(`an argument names a value (at ${cursor.at}, arg ${JSON.stringify(argName)}, next ${JSON.stringify(cursor.text.slice(cursor.at, cursor.at + 24))})`);
        }
        args.push({ name: argName, value: parseValue(cursor) });
      }
    }
    let nested: Selection[] | null = null;
    if (cursor.eat('{')) nested = parseSelectionSet(cursor);
    selections.push({ kind: 'field', field: { alias, name, args, selections: nested } });
  }
  return selections;
}

/** Parse one value: a variable, a literal, a list or an input object. */
function parseValue(cursor: Cursor): ValueNode {
  cursor.skipSpace();
  const token = cursor.peek();
  if (token === null) throw new Error('a value was expected');
  if (token === '$') {
    cursor.take();
    return { kind: 'variable', name: cursor.take() ?? '' };
  }
  if (token === '"') {
    const raw = cursor.take() ?? '""';
    return { kind: 'literal', value: raw.slice(1, -1) };
  }
  if (token === '[') {
    cursor.take();
    const values: ValueNode[] = [];
    for (;;) {
      if (cursor.eat(']')) break;
      values.push(parseValue(cursor));
    }
    return { kind: 'list', values };
  }
  if (token === '{') {
    cursor.take();
    const fields: { name: string; value: ValueNode }[] = [];
    for (;;) {
      if (cursor.eat('}')) break;
      const fieldName = cursor.take();
      if (fieldName === null || !cursor.eat(':')) throw new Error('an input field names a value');
      fields.push({ name: fieldName, value: parseValue(cursor) });
    }
    return { kind: 'object', fields };
  }
  const word = cursor.take();
  if (word === null) throw new Error('a value was expected');
  if (word === 'true') return { kind: 'literal', value: true };
  if (word === 'false') return { kind: 'literal', value: false };
  if (word === 'null') return { kind: 'literal', value: null };
  if (/^-?[0-9]+$/.test(word)) return { kind: 'literal', value: Number(word) };
  return { kind: 'literal', value: word };
}

/** Evaluate one argument value against the request's variables. */
function evaluate(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((value) => evaluate(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluate(field.value, variables);
      return out;
    }
  }
}

/** A field's argument values as a plain object. */
function argsOf(field: FieldSelection, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evaluate(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- the resolvers

/** What one field resolved to. */
type FieldResult =
  | { readonly kind: 'leaf'; readonly value: unknown }
  | { readonly kind: 'object'; readonly typeName: string; readonly value: unknown }
  | { readonly kind: 'list'; readonly typeName: string; readonly values: readonly unknown[] }
  | { readonly kind: 'null' };

/** The introspection field lists, exactly the names the probes require (extras allowed). */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
});

/** The SearchType enum values the probes require (ISSUE among them). */
const SEARCH_TYPE_VALUES: readonly string[] = ['ISSUE', 'REPOSITORY', 'USER'];

/** The issue range a connection page covers. */
interface IssuePage {
  readonly repo: ForgeRepo;
  readonly issues: readonly ForgeIssue[];
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

/** Resolve one field against its type's value; `errors` collects the unknown-field messages. */
function resolveField(
  store: Store,
  typeName: string,
  value: unknown,
  field: FieldSelection,
  variables: Readonly<Record<string, unknown>>,
  errors: { message: string }[],
): FieldResult | null {
  const args = argsOf(field, variables);
  const asString = (input: unknown): string => (typeof input === 'string' ? input : '');
  const asInt = (input: unknown): number | null => (typeof input === 'number' && Number.isInteger(input) ? input : null);

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { kind: 'object', typeName: 'User', value: { login: FORGE_LOGIN } };
      if (field.name === 'repository') {
        const repo = store.getRepo(asString(args.owner), asString(args.name));
        return repo === null ? { kind: 'null' } : { kind: 'object', typeName: 'Repository', value: repo };
      }
      if (field.name === 'node') {
        const id = asString(args.id);
        const parsed = parseGlobalId(id);
        if (parsed === null) return { kind: 'null' };
        if (parsed.kind === 'Repository') {
          const repo = store.repoById(parsed.dbId);
          return repo === null ? { kind: 'null' } : { kind: 'object', typeName: 'Repository', value: repo };
        }
        return { kind: 'null' };
      }
      if (field.name === '__type') {
        const name = asString(args.name);
        if (name === 'SearchType') return { kind: 'object', typeName: 'SearchTypeType', value: {} };
        if (TYPE_FIELDS[name] !== undefined) return { kind: 'object', typeName: '__Type', value: { name } };
        return { kind: 'null' };
      }
      break;
    }
    case 'User': {
      const user = value as { login: string };
      if (field.name === 'login') return { kind: 'leaf', value: user.login };
      break;
    }
    case 'Repository': {
      const repo = value as ForgeRepo;
      switch (field.name) {
        case 'id': return { kind: 'leaf', value: globalId('Repository', repo.id) };
        case 'databaseId': return { kind: 'leaf', value: repo.id };
        case 'name': return { kind: 'leaf', value: repo.name };
        case 'nameWithOwner': return { kind: 'leaf', value: repo.fullName };
        case 'owner': return { kind: 'object', typeName: 'User', value: { login: repo.owner } };
        case 'defaultBranchRef': return { kind: 'object', typeName: 'Ref', value: { name: repo.defaultBranch } };
        case 'viewerPermission': return { kind: 'leaf', value: 'ADMIN' };
        case 'hasIssuesEnabled': return { kind: 'leaf', value: true };
        case 'issue': {
          const number = asInt(args.number);
          const issue = number === null ? null : store.getIssue(repo, number);
          return issue === null ? { kind: 'null' } : { kind: 'object', typeName: 'Issue', value: { repo, issue } };
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? args.states.filter((state): state is string => typeof state === 'string') : null;
          const orderBy = (args.orderBy ?? null) as { field?: unknown; direction?: unknown } | null;
          const descending = orderBy !== null && orderBy.direction === 'DESC';
          let issues = states === null ? repo.issues : repo.issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
          if (descending) issues = [...issues].sort((a, b) => b.number - a.number);
          const total = issues.length;
          const first = asInt(args.first) ?? total;
          const afterRaw = typeof args.after === 'string' ? args.after : '';
          const start = cursorOffset(afterRaw);
          const end = Math.min(total, start + first);
          const page: IssuePage = { repo, issues, start, end, total };
          return { kind: 'object', typeName: 'IssueConnection', value: page };
        }
        case 'pullRequests': {
          const first = asInt(args.first) ?? repo.pulls.length;
          const list = repo.pulls.slice(0, first);
          return { kind: 'object', typeName: 'PullRequestConnection', value: { repo, list } };
        }
        case 'pullRequest': {
          const number = asInt(args.number);
          const pull = number === null ? null : store.getPull(repo, number);
          return pull === null ? { kind: 'null' } : { kind: 'object', typeName: 'PullRequest', value: { repo, pull } };
        }
        default: break;
      }
      break;
    }
    case 'Issue': {
      const holder = value as { repo: ForgeRepo; issue: ForgeIssue };
      switch (field.name) {
        case 'id': return { kind: 'leaf', value: globalId('Issue', holder.issue.id) };
        case 'number': return { kind: 'leaf', value: holder.issue.number };
        case 'title': return { kind: 'leaf', value: holder.issue.title };
        case 'state': return { kind: 'leaf', value: holder.issue.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'body': return { kind: 'leaf', value: holder.issue.body };
        default: break;
      }
      break;
    }
    case 'IssueConnection': {
      const page = value as IssuePage;
      if (field.name === 'nodes') {
        return { kind: 'list', typeName: 'Issue', values: page.issues.slice(page.start, page.end).map((issue) => ({ repo: page.repo, issue })) };
      }
      if (field.name === 'pageInfo') {
        return { kind: 'object', typeName: 'PageInfo', value: { hasNextPage: page.end < page.total, endCursor: encodeCursor(page.end) } };
      }
      break;
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; endCursor: string };
      if (field.name === 'hasNextPage') return { kind: 'leaf', value: info.hasNextPage };
      if (field.name === 'endCursor') return { kind: 'leaf', value: info.endCursor };
      break;
    }
    case 'PullRequest': {
      const holder = value as { repo: ForgeRepo; pull: ForgePull };
      switch (field.name) {
        case 'id': return { kind: 'leaf', value: globalId('PullRequest', holder.pull.id) };
        case 'number': return { kind: 'leaf', value: holder.pull.number };
        case 'state': return { kind: 'leaf', value: holder.pull.merged ? 'MERGED' : holder.pull.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'merged': return { kind: 'leaf', value: holder.pull.merged };
        case 'headRefName': return { kind: 'leaf', value: holder.pull.head.ref };
        case 'baseRefName': return { kind: 'leaf', value: holder.pull.base.ref };
        case 'mergeable': return { kind: 'leaf', value: pullConflicts(store, holder.repo, holder.pull) ? 'CONFLICTING' : 'MERGEABLE' };
        case 'files': return { kind: 'object', typeName: 'PullRequestFilesConnection', value: holder };
        default: break;
      }
      break;
    }
    case 'PullRequestFilesConnection': {
      const holder = value as { repo: ForgeRepo; pull: ForgePull };
      if (field.name === 'nodes') {
        const changes = diffTrees(store, holder.repo, holder.pull.head.sha, holder.pull.base.sha);
        return { kind: 'list', typeName: 'PullRequestFile', values: changes.map((change) => ({ path: change.path })) };
      }
      break;
    }
    case 'PullRequestFile': {
      const file = value as { path: string };
      if (field.name === 'path') return { kind: 'leaf', value: file.path };
      break;
    }
    case 'PullRequestConnection': {
      const holder = value as { repo: ForgeRepo; list: readonly ForgePull[] };
      if (field.name === 'nodes') {
        return { kind: 'list', typeName: 'PullRequest', values: holder.list.map((pull) => ({ repo: holder.repo, pull })) };
      }
      break;
    }
    case 'Ref': {
      const refValue = value as { name: string };
      if (field.name === 'name') return { kind: 'leaf', value: refValue.name };
      break;
    }
    case '__Type': {
      const typeValue = value as { name: string };
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[typeValue.name] ?? [];
        return { kind: 'list', typeName: '__Field', values: names.map((name) => ({ name })) };
      }
      if (field.name === 'enumValues') {
        return { kind: 'list', typeName: '__EnumValue', values: (TYPE_FIELDS[typeValue.name] ?? []).map((name) => ({ name })) };
      }
      break;
    }
    case 'SearchTypeType': {
      if (field.name === 'enumValues') {
        return { kind: 'list', typeName: '__EnumValue', values: SEARCH_TYPE_VALUES.map((name) => ({ name })) };
      }
      if (field.name === 'fields') {
        return { kind: 'list', typeName: '__Field', values: [] };
      }
      break;
    }
    case '__Field': {
      const field2 = value as { name: string };
      if (field.name === 'name') return { kind: 'leaf', value: field2.name };
      break;
    }
    case '__EnumValue': {
      const enumValue = value as { name: string };
      if (field.name === 'name') return { kind: 'leaf', value: enumValue.name };
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const asString2 = (v: unknown): string => (typeof v === 'string' ? v : '');
      if (field.name === 'createIssue') {
        const repo = repoByGlobalId(store, asString2(input.repositoryId));
        if (repo === null) return { kind: 'null' };
        const issue = store.createIssue(repo, asString2(input.title), asString2(input.body));
        return { kind: 'object', typeName: 'CreateIssuePayload', value: { repo, issue } };
      }
      if (field.name === 'closeIssue') {
        const found = issueByGlobalId(store, asString2(input.issueId));
        if (found === null) return { kind: 'null' };
        store.closeIssue(found.repo, found.issue);
        return { kind: 'object', typeName: 'CloseIssuePayload', value: { repo: found.repo, issue: found.issue } };
      }
      if (field.name === 'createPullRequest') {
        const repo = repoByGlobalId(store, asString2(input.repositoryId));
        if (repo === null) return { kind: 'null' };
        const pull = store.createPull(repo, asString2(input.title), '', asString2(input.headRefName), asString2(input.baseRefName));
        return { kind: 'object', typeName: 'PullRequestPayload', value: { repo, pull } };
      }
      if (field.name === 'mergePullRequest') {
        const found = pullByGlobalId(store, asString2(input.pullRequestId));
        if (found === null) return { kind: 'null' };
        const mergeSha = squashMerge(store, found.repo, found.pull);
        if (mergeSha === null) return { kind: 'null' };
        store.markMerged(found.repo, found.pull, mergeSha);
        return { kind: 'object', typeName: 'MergePullRequestPayload', value: { repo: found.repo, pull: found.pull } };
      }
      if (field.name === 'addComment') {
        const found = issueByGlobalId(store, asString2(input.subjectId));
        if (found === null) return { kind: 'null' };
        const comment = store.addComment(found.issue, asString2(input.body));
        return { kind: 'object', typeName: 'CommentAddedPayload', value: { repo: found.repo, issue: found.issue, comment } };
      }
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const holder = value as { repo: ForgeRepo; issue: ForgeIssue };
      if (field.name === 'issue') return { kind: 'object', typeName: 'Issue', value: holder };
      break;
    }
    case 'PullRequestPayload':
    case 'MergePullRequestPayload': {
      const holder = value as { repo: ForgeRepo; pull: ForgePull };
      if (field.name === 'pullRequest') return { kind: 'object', typeName: 'PullRequest', value: holder };
      break;
    }
    case 'CommentAddedPayload': {
      const holder = value as { repo: ForgeRepo; issue: ForgeIssue; comment: { id: number; body: string } };
      if (field.name === 'commentEdge') return { kind: 'object', typeName: 'CommentEdge', value: holder };
      break;
    }
    case 'CommentEdge': {
      const holder = value as { repo: ForgeRepo; issue: ForgeIssue; comment: { id: number; body: string } };
      if (field.name === 'node') return { kind: 'object', typeName: 'Comment', value: holder };
      break;
    }
    case 'Comment': {
      const holder = value as { comment: { id: number; body: string } };
      if (field.name === 'id') return { kind: 'leaf', value: globalId('IssueComment', holder.comment.id) };
      if (field.name === 'body') return { kind: 'leaf', value: holder.comment.body };
      break;
    }
  }
  // Unknown field: the GraphQL-level error the checks read by name.
  errors.push({ message: `Cannot query field '${field.name}' on type '${typeName}'.` });
  return null;
}

/** Execute a selection set against one type's value. */
function executeSet(
  store: Store,
  selections: readonly Selection[],
  typeName: string,
  value: unknown,
  variables: Readonly<Record<string, unknown>>,
  errors: { message: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.on === typeName) {
        Object.assign(out, executeSet(store, selection.selections, typeName, value, variables, errors));
      }
      continue;
    }
    const field = selection.field;
    const result = resolveField(store, typeName, value, field, variables, errors);
    const key = field.alias ?? field.name;
    if (result === null) {
      out[key] = null;
      continue;
    }
    if (result.kind === 'null') {
      out[key] = null;
      continue;
    }
    if (result.kind === 'leaf') {
      out[key] = result.value;
      continue;
    }
    if (field.selections === null) {
      out[key] = null;
      continue;
    }
    if (result.kind === 'object') {
      out[key] = executeSet(store, field.selections, result.typeName, result.value, variables, errors);
    } else {
      out[key] = result.values.map((entry) => executeSet(store, field.selections ?? [], result.typeName, entry, variables, errors));
    }
  }
  return out;
}

/** A cursor's offset, or 0 when it does not decode. */
function cursorOffset(cursor: string): number {
  if (cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return 0;
    const offset = Number(text.slice('cursor:'.length));
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

/** A cursor for one offset: opaque, non-empty, stable. */
function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

/** The repository a global id names, or null. */
function repoByGlobalId(store: Store, id: string): ForgeRepo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return store.repoById(parsed.dbId);
}

/** The issue a global id names, with its repository, or null. */
function issueByGlobalId(store: Store, id: string): { repo: ForgeRepo; issue: ForgeIssue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  return store.issueById(parsed.dbId);
}

/** The pull a global id names, with its repository, or null. */
function pullByGlobalId(store: Store, id: string): { repo: ForgeRepo; pull: ForgePull } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  return store.pullById(parsed.dbId);
}

/** Run one operation body: `{query, variables}`. Returns the `{data, errors}` envelope. */
function runOperation(store: Store, query: unknown, variables: unknown): Record<string, unknown> {
  if (typeof query !== 'string') return { errors: [{ message: 'a request carries a query document' }] };
  const vars: Record<string, unknown> =
    variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
  let operation: Operation;
  try {
    operation = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: `Cannot parse the document: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const errors: { message: string }[] = [];
  const data = executeSet(store, operation.selections, operation.kind === 'mutation' ? 'Mutation' : 'Query', null, vars, errors);
  const out: Record<string, unknown> = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

/** Serve POST /api/graphql: one operation or an array of them, answered in order. */
export function handleGraphql(store: Store, res: HttpResponse, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.map((entry) => {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        return runOperation(store, record.query, record.variables ?? null);
      }
      return { errors: [{ message: 'a request carries a query document' }] };
    });
    sendJson(res, 200, replies);
    return;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (typeof record.query !== 'string') {
      sendJson(res, 400, { message: 'a request carries a query document' });
      return;
    }
    sendJson(res, 200, runOperation(store, record.query, record.variables ?? null));
    return;
  }
  sendJson(res, 400, { message: 'a request carries a query document' });
}
