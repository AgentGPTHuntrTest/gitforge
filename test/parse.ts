// The PullRequestFiles document against the GraphQL parser, standalone.
import { parseDocument } from '../src/graphql.ts';

const doc = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}`;

try {
  const operation = parseDocument(doc);
  console.log('parsed ok:', operation.kind, operation.selections.length, 'top-level selections');
  const repository = operation.selections[0] as { kind: 'field'; field: { name: string; selections: readonly unknown[] | null } };
  console.log('first field:', repository.field.name, repository.field.selections?.length);
} catch (err) {
  console.log('parse error:', err instanceof Error ? err.message : String(err));
}
