import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('top-level package import does not initialize node:sqlite', () => {
  const packageEntry = new URL('../index.js', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(packageEntry)})`],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
