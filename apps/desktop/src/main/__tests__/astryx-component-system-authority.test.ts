import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import test from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SOURCE_ROOTS = ['packages/ui/src', 'apps/desktop/src'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const RETIRED_COMPONENT_PACKAGE = '@base-ui' + '/react';
const RETIRED_PRIMITIVES = [
  'alert',
  'chip',
  'data-table',
  'empty',
  'item',
  'kbd',
  'segmented',
  'spinner',
  'tabs',
  'toolbar',
] as const;

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(resolve(REPO_ROOT, root), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

test('Astryx is the sole component foundation in source', async () => {
  const violations: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of await sourceFiles(root)) {
      const contents = await readFile(path, 'utf8');
      if (contents.includes(RETIRED_COMPONENT_PACKAGE)) {
        violations.push(path.slice(REPO_ROOT.length + 1));
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('generic Maka primitives do not duplicate published Astryx components', async () => {
  const survivors: string[] = [];
  for (const name of RETIRED_PRIMITIVES) {
    const path = `packages/ui/src/primitives/${name}.tsx`;
    try {
      await access(resolve(REPO_ROOT, path));
      survivors.push(path);
    } catch {
      // Missing is the required end state.
    }
  }

  assert.deepEqual(survivors, []);
});

test('workspace manifests do not restore the retired component dependency', async () => {
  for (const path of ['apps/desktop/package.json', 'packages/ui/package.json']) {
    const manifest = await readFile(resolve(REPO_ROOT, path), 'utf8');
    assert.equal(manifest.includes(RETIRED_COMPONENT_PACKAGE), false, path);
  }
});

test('product CSS does not restyle Astryx Banner internals', async () => {
  const css = await readFile(
    resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/chat-detail.css'),
    'utf8',
  );
  const artifactErrorRule = css.match(/\.maka-artifact-list-error\s*\{[^}]*\}/)?.[0] ?? '';

  assert.notEqual(artifactErrorRule, '');
  assert.doesNotMatch(artifactErrorRule, /display|grid-template|padding|border|background|color/);
  assert.doesNotMatch(css, /\.maka-artifact-list-error\s+(?:svg|strong|p)\b/);
});

test('command palette presents navigation keys as alternatives, not a chord', async () => {
  const source = await readFile(
    resolve(REPO_ROOT, 'apps/desktop/src/renderer/command-palette.tsx'),
    'utf8',
  );

  assert.doesNotMatch(source, /<Kbd keys="up\+down"\s*\/>/);
  assert.match(source, /<Kbd keys="up"\s*\/>\s*<Kbd keys="down"\s*\/>/);
  assert.match(
    source,
    /emptySearchText=\{\([\s\S]*?<EmptyState[\s\S]*?role="presentation"/,
    'Astryx CommandPalette owns the sole no-results live region',
  );
});
