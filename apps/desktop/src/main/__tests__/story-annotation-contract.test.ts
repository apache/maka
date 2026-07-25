/**
 * #1433 item 6: every product-level story carries a path annotation.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN. This checks that someone wrote a
 * sentence above each story. It cannot check the sentence is TRUE — only a
 * reviewer following the call chain can. The name says "annotation", not
 * "reachability", because that is the whole of what it enforces.
 *
 * That is still worth having. The convention (apps/desktop/stories/FIDELITY.md)
 * exists because two findings in #1433 — a 135px hero offset and a broken
 * vertical centring — were measured against a story that composed a state the
 * app never renders, and neither reproduced in the built app. Requiring the
 * sentence forces someone to trace the path once and gives reviewers something
 * concrete to disagree with. Writing the annotation is the work; this test only
 * stops a new story from skipping it.
 *
 * The gap is real and has already bitten: `CommandPaletteEmpty` shipped with a
 * confidently-worded path to a state `buildCommandList` cannot produce, and
 * this test passed it. Prose is checked by people.
 *
 * Design-system and primitive stories are exempt — they demonstrate a
 * component's states, not a product surface, and there is no user path to a
 * Button variant.
 */

import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { REPO_ROOT } from './main-process-contract-source-helpers.js';

const STORY_ROOTS = [
  join(REPO_ROOT, 'apps/desktop/stories'),
  join(REPO_ROOT, 'packages/ui/stories'),
];

const CONVENTION_DOC = 'apps/desktop/stories/FIDELITY.md';

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

/**
 * The CSF title. Anchored to the `meta` object rather than the first `title:`
 * anywhere in the file — fixture data routinely carries a `title` field, and
 * matching that would silently exempt the whole file from every assertion
 * below. Both quote styles, because nothing forces single quotes.
 */
function metaTitle(source: string): string | undefined {
  const meta = source.match(/const meta[\s\S]*?\n\}/);
  return meta?.[0].match(/title:\s*['"]([^'"]+)['"]/)?.[1];
}

async function readStoryFiles(): Promise<StoryFile[]> {
  const files = (await Promise.all(STORY_ROOTS.map(listStoryFiles))).flat();
  return Promise.all(
    files.map(async (path) => {
      const source = await readFile(path, 'utf8');
      return { path: relative(REPO_ROOT, path), source, title: metaTitle(source) };
    }),
  );
}

/**
 * Story exports declared in this file, with the line each one starts on.
 * Covers both CSF idioms — the annotated `: Story` form and the inferred
 * `satisfies Story` form this repo already uses for `meta`. Matching only the
 * first would let a story opt out of the contract by changing how it is typed.
 */
function storyExports(source: string): Array<{ name: string; line: number }> {
  const lines = source.split('\n');
  const exports: Array<{ name: string; line: number }> = [];
  const usesSatisfies = /satisfies Story\b/.test(source);
  lines.forEach((text, index) => {
    const typed = text.match(/^export const (\w+)\s*:\s*Story\s*=/);
    const inferred = usesSatisfies ? text.match(/^export const (\w+)\s*=\s*\{/) : null;
    const name = typed?.[1] ?? inferred?.[1];
    if (name) exports.push({ name, line: index });
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

describe('#1433 item 6 — product stories carry a path annotation', () => {
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

  /**
   * The convention itself lives in one file. It used to be a ~10-line block
   * pasted into every story file, which drifted on day one: 17 byte-identical
   * copies plus one older wording in app-shell.stories.tsx. A substring check
   * cannot catch that, so there is nothing left to keep in sync — each file
   * points at the doc instead of restating it.
   */
  it('every product story file points at the one convention doc', async () => {
    const files = await readStoryFiles();
    const productFiles = files.filter((file) => file.title?.startsWith('Product/'));
    const missing = productFiles
      .filter((file) => !file.source.includes(CONVENTION_DOC))
      .map((file) => file.path);

    assert.deepEqual(
      missing,
      [],
      `these product story files do not point at ${CONVENTION_DOC}:\n${missing.join('\n')}`,
    );

    await assert.doesNotReject(
      () => readFile(join(REPO_ROOT, CONVENTION_DOC), 'utf8'),
      `${CONVENTION_DOC} must exist — every product story file points at it`,
    );
  });

  it('exempts design-system and primitive stories, which have no user path', async () => {
    const files = await readStoryFiles();
    const exempt = files.filter(
      (file) => file.title?.startsWith('Primitives/') || file.title?.startsWith('Design System/'),
    );
    assert.ok(exempt.length > 0, 'primitive/design-system stories should still exist');

    // The exemption has to be demonstrated, not asserted: these files DO
    // export stories and DO lack annotations, and the first test still passes.
    // A vacuous check here (`length >= 0`) would keep passing even if the
    // exemption silently stopped applying to anything.
    const unannotated = exempt.filter((file) =>
      storyExports(file.source).some((story) => !hasReachablePathComment(file.source, story.line)),
    );
    assert.ok(
      unannotated.length > 0,
      'expected at least one exempt file with unannotated stories, proving the exemption is load-bearing',
    );
  });
});
