import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { remarkDocLinks } from '../src/lib/remark-doc-links.js';

test("a machine translation's links stay in its language", () => {
  const link = { type: 'link', url: '../elements/list.md#props', children: [] };
  remarkDocLinks()({ type: 'root', children: [link] }, { path: join(process.cwd(), 'translations/ko/docs/goals.md') });
  expect(link.url).toBe('/ko/elements/list#props');
});
