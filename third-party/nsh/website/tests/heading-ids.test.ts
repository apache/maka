import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { headingsOf, idMap, remarkLocaleHeadingIds } from '../src/lib/remark-locale-heading-ids.js';

// A Chinese page's headings take the English page's ids, so a section link is
// the same, short and readable, in both languages. That needs the two pages to
// have the same outline: the same headings at the same levels, in order.

const ROOT = join(import.meta.dir, '..');
const SECTIONS = ['docs', 'elements', 'modules'];

function pages(): string[] {
  return SECTIONS.flatMap((s) =>
    readdirSync(join(ROOT, 'zh-CN', s))
      .filter((n) => n.endsWith('.md') && existsSync(join(ROOT, s, n)))
      .map((n) => join(ROOT, 'zh-CN', s, n)),
  );
}

test('every Chinese page has the English outline, so every heading gets the English id', () => {
  const drifted = pages().flatMap((p) => {
    const page = p.slice(ROOT.length + 1);
    const map = idMap(p);
    if (!map) return [`${page}: unreadable`];
    if (map.ids.length !== map.own.length) {
      return [`${page}: heading ${map.ids.length + 1} ("${map.own[map.ids.length]}") is at another level than the English one`];
    }
    // Headings pair by position: a section missing from the Chinese page
    // shifts the ids of every heading after it, even when the levels still
    // line up.
    if (map.own.length !== map.english.length) {
      return [`${page}: ${map.own.length} headings, the English page has ${map.english.length}`];
    }
    return [];
  });
  expect(drifted).toEqual([]);
}, 30_000);

test('Chinese heading ids are ASCII, never a percent-encoded title', () => {
  const nonAscii = pages().flatMap((p) => (idMap(p)?.ids ?? []).filter((id) => !/^[\x20-\x7e]*$/.test(id)).map((id) => `${p}#${id}`));
  expect(nonAscii).toEqual([]);
});

test('section links in Chinese pages point at an English id that exists on the target page', () => {
  const broken: string[] = [];
  for (const path of pages()) {
    const tree = unified().use(remarkParse).parse(readFileSync(path, 'utf8'));
    unified().use(remarkLocaleHeadingIds).runSync(tree, { path, history: [path] } as never);
    const visit = (node: any) => {
      if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
        const url: string = node.url;
        const at = url.indexOf('#');
        if (at !== -1 && !/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('/')) {
          const target = url.slice(0, at) ? resolve(dirname(path), url.slice(0, at)) : path;
          const fragment = url.slice(at + 1);
          if (target.endsWith('.md') && existsSync(target)) {
            const map = idMap(target);
            const ids = map ? map.ids : headingsOf(readFileSync(target, 'utf8')).map((h) => h.slug);
            if (!ids.includes(fragment)) broken.push(`${path.slice(ROOT.length + 1)} → ${url}`);
          }
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  }
  expect(broken).toEqual([]);
});


test('heading ids collapse repeated hyphens before numbering duplicates', () => {
  const source = '## Tracing with `--trace`\n## A -- B\n## A - B\n## A - B';
  expect(headingsOf(source).map((h) => h.slug)).toEqual([
    'tracing-with-trace', 'a-b', 'a-b-1', 'a-b-2',
  ]);
});

test('English and Chinese tracing headings and old section links use one hyphen', () => {
  for (const locale of ['', 'zh-CN/']) {
    const path = join(ROOT, locale, 'docs/testing-and-trace.md');
    const map = idMap(path)!;
    expect(map.ids).toContain('tracing-with-trace');
    const source = readFileSync(path, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
      + '\n[Trace](#tracing-with---trace)';
    const tree = unified().use(remarkParse).parse(source);
    // The production pipeline removes the title before assigning ids.
    if (tree.children[0]?.type === 'heading' && tree.children[0].depth === 1) tree.children.shift();
    unified().use(remarkLocaleHeadingIds).runSync(tree, { path } as never);
    const ids = tree.children.filter((n) => n.type === 'heading').map((n: any) => n.data.hProperties.id);
    expect(ids).toEqual(map.ids);
    expect((tree.children.at(-1) as any).children[0].url).toBe('#tracing-with-trace');
  }
});

test('all English and Chinese heading ids avoid consecutive hyphens', () => {
  const paths = pages().flatMap((p) => [p, p.replace('/zh-CN/', '/')]);
  expect(paths.flatMap((p) => idMap(p)!.ids.filter((id) => id.includes('--')))).toEqual([]);
}, 30_000);
