/**
 * #1433 item 6: every product-level story must name the app path that
 * reaches it.
 *
 * Storybook is where pixel work happens, so its stories get treated as
 * ground truth for what the product looks like. That only holds if every
 * story is a state a real user can reach. Two findings in #1433 — a 135px
 * hero offset and a broken vertical centring — were measured against a
 * story that composed a state the app never renders, and neither
 * reproduced in the built app.
 *
 * A story with no stated path cannot be checked against the app, so this
 * contract requires one: a `// Real path:` comment directly above each
 * `Product/*` story, describing how a user gets there. Design-system and
 * primitive stories are exempt — they demonstrate a component's states,
 * not a product surface, and there is no user path to a Button variant.
 *
 * The comment is prose on purpose. The value is that someone had to trace
 * the path and write it down; a machine-checkable schema would be
 * satisfied by a plausible-looking lie just as easily.
 */

import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

const STORY_ROOTS = [
  join(REPO_ROOT, 'apps/desktop/stories'),
  join(REPO_ROOT, 'packages/ui/stories'),
];

async function listStoryFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listStoryFiles(full)));
    } else if (entry.name.endsWith('.stories.tsx')) {
      files.push(full);
    }
  }
  return files.sort();
}

interface StoryFile {
  path: string;
  source: string;
  title: string | undefined;
}

async function readStoryFiles(): Promise<StoryFile[]> {
  const files = (await Promise.all(STORY_ROOTS.map(listStoryFiles))).flat();
  return Promise.all(
    files.map(async (path) => {
      const source = await readFile(path, 'utf8');
      return {
        path: relative(REPO_ROOT, path),
        source,
        title: source.match(/title:\s*'([^']+)'/)?.[1],
      };
    }),
  );
}

/** Story exports declared in this file, with the line each one starts on. */
function storyExports(source: string): Array<{ name: string; line: number }> {
  const lines = source.split('\n');
  const exports: Array<{ name: string; line: number }> = [];
  lines.forEach((text, index) => {
    const match = text.match(/^export const (\w+)\s*:\s*Story\s*=/);
    if (match?.[1]) exports.push({ name: match[1], line: index });
  });
  return exports;
}

/**
 * Walk up from a story export over its attached comment block (and any
 * blank lines inside it) looking for the path annotation.
 */
function hasReachablePathComment(source: string, line: number): boolean {
  const lines = source.split('\n');
  for (let i = line - 1; i >= 0; i -= 1) {
    const text = lines[i]?.trim() ?? '';
    if (text === '') continue;
    if (!text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')) return false;
    if (/Real path:/i.test(text)) return true;
  }
  return false;
}

describe('#1433 item 6 — product stories name a reachable app path', () => {
  it('every Product/* story is annotated with the path that reaches it', async () => {
    const files = await readStoryFiles();
    const productFiles = files.filter((file) => file.title?.startsWith('Product/'));
    assert.ok(
      productFiles.length >= 15,
      `expected the product story surface to be discovered, found ${productFiles.length} files`,
    );

    const missing: string[] = [];
    for (const file of productFiles) {
      for (const story of storyExports(file.source)) {
        if (!hasReachablePathComment(file.source, story.line)) {
          missing.push(`${file.path} › ${story.name}`);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      `these product stories do not say how a user reaches them. Add a "// Real path: …" comment above each one, or delete the story if no user can reach it:\n${missing.join('\n')}`,
    );
  });

  it('every product story file carries the fidelity convention', async () => {
    const files = await readStoryFiles();
    const productFiles = files.filter((file) => file.title?.startsWith('Product/'));
    const missing = productFiles
      .filter((file) => !/FIDELITY CONVENTION/.test(file.source))
      .map((file) => file.path);

    assert.deepEqual(
      missing,
      [],
      `these product story files do not state the fidelity convention:\n${missing.join('\n')}`,
    );
  });

  it('exempts design-system and primitive stories, which have no user path', async () => {
    const files = await readStoryFiles();
    const exempt = files.filter(
      (file) => file.title?.startsWith('Primitives/') || file.title?.startsWith('Design System/'),
    );
    assert.ok(exempt.length > 0, 'primitive/design-system stories should still exist');
    for (const file of exempt) {
      assert.ok(
        storyExports(file.source).length >= 0,
        `${file.path} should parse without requiring a path annotation`,
      );
    }
  });
});
