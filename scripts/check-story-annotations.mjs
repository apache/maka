#!/usr/bin/env node
/**
 * check-story-annotations.mjs — the machine-checkable half of the Storybook
 * fidelity convention (apps/desktop/stories/FIDELITY.md).
 *
 * Every `Product/*` story must carry a `// Real path:` comment naming how a
 * user reaches the state it renders. Whether that sentence is TRUE is a review
 * question and always will be — a schema is satisfied by a plausible lie just
 * as easily. Whether it EXISTS is mechanical, and review demonstrably does not
 * hold that line: chat-surface.stories.tsx reached thirteen stories with twelve
 * annotations before anyone noticed.
 *
 * `Primitives/*` and `Design System/*` are exempt, per FIDELITY.md: they show a
 * component's states, not a product surface.
 *
 * This is the shape #1724 kept when it deleted the source-scanning contract
 * suite — a fast scripts/check-*.mjs guarding a non-cosmetic invariant, not a
 * 675-test suite asserting on source text. It runs in CI's typecheck job next
 * to check-dead-css.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const STORYBOOK_CONFIG = join(REPO_ROOT, 'apps/desktop/.storybook/main.ts');
const STORY_ROOTS = ['apps/desktop/stories', 'packages/ui/stories'];
const EXEMPT_TITLE_PREFIXES = ['Primitives/', 'Design System/'];

// `export const Name: Story = …` and nothing else, including the form that
// wraps onto the next line. A story written in another shape is not skipped —
// a guard that silently ignores what it cannot parse passes *because* it did
// not understand, which is the failure it exists to prevent. So ANY_EXPORT is
// deliberately wider than STORY_EXPORT and covers `export {}` re-exports and
// `export async function` too: anything it matches and STORY_EXPORT does not
// is reported rather than waved through. Widening STORY_EXPORT is a deliberate
// edit here.
const STORY_EXPORT = /^export const ([A-Za-z0-9_]+): Story =(?:\s|$)/;
const ANY_EXPORT =
  /^export (?:default |async )?(?:const|function|let|var|class|\{)\s*([A-Za-z0-9_]+)?/;
// Anchored at `const meta`, not the first `title:` in the file: a fixture
// literal carrying its own `title` would otherwise decide the whole file's
// namespace — including exempting it outright with `Design System/…`.
const TITLE = /const meta[\s\S]*?title:\s*['"]([^'"]+)['"]/;
// `\S` after the colon: an empty `// Real path:` is not an annotation.
const REAL_PATH = /^\s*\/\/\s*Real path:\s*\S/;
// Every glob main.ts loads stories from, so an added root is caught as well as
// a removed one.
const CONFIG_GLOB = /['"](?:.*?)([\w./-]*?stories)\/\*\*\/\*\.stories\.@?\(?[\w|)]+['"]/g;

async function storyFiles(root) {
  const entries = await readdir(join(REPO_ROOT, root), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && /\.stories\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * The scan roots are restated here rather than parsed out of main.ts, so this
 * asserts they still match what Storybook actually loads — in both directions.
 * A root dropped from main.ts leaves this scanning a tree Storybook ignores; a
 * root added there would otherwise go unchecked in silence.
 */
export function checkStorybookRoots(config, problems) {
  const configFile = relative(REPO_ROOT, STORYBOOK_CONFIG);
  for (const root of STORY_ROOTS) {
    // Match the full root, not its last segment: both roots end in `stories`,
    // so a leaf match stays satisfied by the other one and silently passes.
    if (!config.includes(`${root}/**/*.stories.`)) {
      problems.push(`${configFile}: no longer loads ${root}; update STORY_ROOTS`);
    }
  }
  for (const [, loaded] of config.matchAll(CONFIG_GLOB)) {
    if (!STORY_ROOTS.some((root) => loaded.endsWith(root))) {
      problems.push(`${configFile}: loads ${loaded}, which is not in STORY_ROOTS`);
    }
  }
}

export function checkFile(rel, source, problems) {
  const title = source.match(TITLE)?.[1];
  if (!title) {
    problems.push(`${rel}: no meta title found`);
    return;
  }
  if (EXEMPT_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) return;
  if (!title.startsWith('Product/')) {
    problems.push(`${rel}: title "${title}" is neither Product/* nor an exempt namespace`);
    return;
  }

  const lines = source.split('\n');
  lines.forEach((line, index) => {
    const anyExport = line.match(ANY_EXPORT);
    if (!anyExport) return;
    const storyExport = line.match(STORY_EXPORT);
    if (!storyExport) {
      const name = anyExport[1] ?? line.trim();
      problems.push(`${rel}:${index + 1}: ${name} is not \`export const <Name>: Story = …\``);
      return;
    }
    // Walk back over the contiguous comment block directly above the export.
    let cursor = index - 1;
    let annotated = false;
    while (cursor >= 0 && lines[cursor].trim().startsWith('//')) {
      if (REAL_PATH.test(lines[cursor])) annotated = true;
      cursor -= 1;
    }
    if (!annotated) {
      problems.push(`${rel}:${index + 1}: ${storyExport[1]} has no \`// Real path:\` comment`);
    }
  });
}

async function findProblems() {
  const problems = [];
  checkStorybookRoots(await readFile(STORYBOOK_CONFIG, 'utf8'), problems);
  for (const root of STORY_ROOTS) {
    for (const path of await storyFiles(root)) {
      checkFile(relative(REPO_ROOT, path), await readFile(path, 'utf8'), problems);
    }
  }
  return problems.sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const problems = await findProblems();
  if (problems.length > 0) {
    console.error(`check-story-annotations: ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('\nSee apps/desktop/stories/FIDELITY.md.');
    process.exit(1);
  }
  console.log('check-story-annotations: every Product/* story names its real path ✓');
}
