import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The element pages and the gallery's Elements (examples/gallery/App.tsx) list
// the same things in the same order: `nsh`'s primitives from the simplest
// (the pages' `order`), then `nsh/base`'s components by name. A gallery entry
// shows the pages its name joins with "and" ("WebView and Video"); a page with
// no gallery entry takes its place on the site alone.

const ROOT = join(import.meta.dir, '..');

interface Page { title: string; order?: unknown; group?: unknown }

const pages: Page[] = readdirSync(join(ROOT, 'elements'))
  .filter((name) => name.endsWith('.md') && name !== 'index.md')
  .map((name) => {
    const front = readFileSync(join(ROOT, 'elements', name), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return Bun.YAML.parse(front?.[1] ?? '') as Page;
  });

const app = readFileSync(join(ROOT, '../examples/gallery/App.tsx'), 'utf8');

/** The demos' names in one of App.tsx's lists (`const primitives: DemoEntry[] = [ … ];`). */
function gallery(list: string): string[] {
  const body = app.match(new RegExp(`^const ${list}: DemoEntry\\[\\] = \\[\\n([\\s\\S]*?)^\\];`, 'm'));
  if (!body) throw new Error(`examples/gallery/App.tsx has no \`const ${list}: DemoEntry[]\``);
  return [...body[1].matchAll(/^\s*\{ name: "([^"]+)"/gm)].map((m) => m[1]);
}

/** As the sidebar compares titles (`src/lib/sections.ts`). */
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

test('a primitive page has an order and a base page none, so the base pages list by name', () => {
  const problems: string[] = [];
  for (const page of pages) {
    if (page.group === 'primitives') {
      if (typeof page.order !== 'number') problems.push(`${page.title}: a primitive without an order`);
    } else if (page.group === 'base') {
      if (page.order !== undefined) problems.push(`${page.title}: a base component with order ${page.order}`);
    } else problems.push(`${page.title}: group ${String(page.group)}, not primitives or base`);
  }
  expect(problems).toEqual([]);
});

test("the gallery's primitives are primitive pages, in the pages' order", () => {
  const shown = gallery('primitives').flatMap((entry) => entry.split(' and '));
  const site = pages
    .filter((page) => page.group === 'primitives')
    .sort((a, b) => (a.order as number) - (b.order as number) || byName(a.title, b.title))
    .map((page) => page.title);
  expect(shown).toEqual(site.filter((title) => shown.includes(title)));
});

test("the gallery's components are base pages, by name", () => {
  const shown = gallery('components');
  expect(shown).toEqual([...shown].sort(byName));
  const site = pages
    .filter((page) => page.group === 'base')
    .map((page) => page.title)
    .sort(byName);
  expect(shown).toEqual(site.filter((title) => shown.includes(title)));
});
