import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import test from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SOURCE_ROOTS = ['packages/ui/src', 'apps/desktop/src'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const RETIRED_COMPONENT_PACKAGE = '@base-ui' + '/react';

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
  const retired = ['alert', 'empty', 'spinner', 'kbd', 'data-table'];
  const survivors: string[] = [];
  for (const name of retired) {
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
