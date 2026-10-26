import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Content rules that the build cannot check on its own: frontmatter parses and
// has what the schema needs, the Chinese pages mirror the English ones, and
// every `demo:` (and every section's `<!-- demo: … -->`) names a file in
// demos/.

const ROOT = join(import.meta.dir, '..');
const SECTIONS = ['docs', 'elements', 'modules'];

interface Front { title?: unknown; description?: unknown; order?: unknown; demo?: unknown; group?: unknown }

// The keys of `GROUPS` in src/lib/sections.ts (which imports astro:content, so it is not imported here).
const GROUPS = ['start', 'platforms', 'delivery', 'ui', 'tools', 'primitives', 'base'];

function pagesOf(dir: string): Map<string, Front | Error> {
  const out = new Map<string, Front | Error>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const text = readFileSync(join(dir, name), 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    try {
      if (!match) throw new Error('no frontmatter');
      out.set(name, (Bun.YAML.parse(match[1]) ?? {}) as Front);
    } catch (error) {
      out.set(name, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return out;
}

const english = Object.fromEntries(SECTIONS.map((s) => [s, pagesOf(join(ROOT, s))]));
const chinese = Object.fromEntries(SECTIONS.map((s) => [s, pagesOf(join(ROOT, 'zh-CN', s))]));

test('frontmatter parses and has a title and description', () => {
  const problems: string[] = [];
  for (const [locale, sections] of [['', english], ['zh-CN/', chinese]] as const) {
    for (const section of SECTIONS) {
      for (const [name, front] of sections[section]) {
        const file = `${locale}${section}/${name}`;
        if (front instanceof Error) problems.push(`${file}: ${front.message.split('\n')[0]}`);
        else {
          if (typeof front.title !== 'string' || !front.title) problems.push(`${file}: missing title`);
          if (typeof front.description !== 'string' || !front.description) problems.push(`${file}: missing description`);
          if (front.order !== undefined && typeof front.order !== 'number') problems.push(`${file}: order is not a number`);
          if (front.group !== undefined && !GROUPS.includes(front.group as string)) problems.push(`${file}: unknown group ${String(front.group)}`);
        }
      }
    }
  }
  expect(problems).toEqual([]);
});

test('every English page has a Chinese counterpart with the same order, group and demo', () => {
  const problems: string[] = [];
  for (const section of SECTIONS) {
    for (const [name, en] of english[section]) {
      const zh = chinese[section].get(name);
      if (!zh) {
        problems.push(`zh-CN/${section}/${name}: missing`);
        continue;
      }
      if (en instanceof Error || zh instanceof Error) continue;
      if (en.order !== zh.order) problems.push(`zh-CN/${section}/${name}: order ${zh.order} ≠ ${en.order}`);
      if (en.group !== zh.group) problems.push(`zh-CN/${section}/${name}: group ${zh.group} ≠ ${en.group}`);
      if (en.demo !== zh.demo) problems.push(`zh-CN/${section}/${name}: demo ${zh.demo} ≠ ${en.demo}`);
    }
    for (const name of chinese[section].keys()) {
      if (!english[section].has(name)) problems.push(`zh-CN/${section}/${name}: no English page`);
    }
  }
  expect(problems).toEqual([]);
});

test('every element page names a demo (README "Demos")', () => {
  const missing: string[] = [];
  for (const [name, front] of english.elements) {
    if (name === 'index.md' || front instanceof Error) continue;
    if (typeof front.demo !== 'string') missing.push(`elements/${name}`);
  }
  expect(missing).toEqual([]);
});

test('every demo named in frontmatter exists in demos/', () => {
  const missing: string[] = [];
  for (const [locale, sections] of [['', english], ['zh-CN/', chinese]] as const) {
    for (const section of SECTIONS) {
      for (const [name, front] of sections[section]) {
        if (front instanceof Error || front.demo === undefined) continue;
        if (typeof front.demo !== 'string' || !existsSync(join(ROOT, 'demos', `${front.demo}.tsx`))) {
          missing.push(`${locale}${section}/${name}: demo ${String(front.demo)}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
});

test("every section's demo exists in demos/, on both languages' pages", () => {
  const problems: string[] = [];
  const sectionDemos = (file: string) =>
    existsSync(file) ? [...readFileSync(file, 'utf8').matchAll(/^<!--\s*demo:\s*([\w-]+)\s*-->$/gm)].map((m) => m[1]) : [];
  for (const section of SECTIONS) {
    for (const name of english[section].keys()) {
      const en = sectionDemos(join(ROOT, section, name));
      const zh = sectionDemos(join(ROOT, 'zh-CN', section, name));
      if (en.join() !== zh.join()) problems.push(`zh-CN/${section}/${name}: section demos ${zh} ≠ ${en}`);
      for (const demo of en) {
        if (!existsSync(join(ROOT, 'demos', `${demo}.tsx`))) problems.push(`${section}/${name}: demo ${demo}`);
      }
    }
  }
  expect(problems).toEqual([]);
});
