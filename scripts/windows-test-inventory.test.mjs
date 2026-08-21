import assert from 'node:assert/strict';
import test from 'node:test';
import { excludesWindows } from './windows-test-inventory.mjs';

test('exempts a complete Windows-false ternary from the skip inventory', () => {
  assert.equal(
    excludesWindows("process.platform === 'win32' ? false : 'Windows-only regression'"),
    false,
  );
  assert.equal(
    excludesWindows("((process.platform === 'win32' ? false : 'Windows-only regression'))"),
    false,
  );
});

test('keeps a composite expression that can still skip on Windows', () => {
  assert.equal(
    excludesWindows(
      "(process.platform === 'win32' ? false : 'Unix-only') || process.env.CI === '1'",
    ),
    true,
  );
  assert.equal(
    excludesWindows(
      "(process.platform === 'win32' ? false : 'Unix-only') || (process.env.CI === '1')",
    ),
    true,
  );
});

test('keeps a direct Windows exclusion in the skip inventory', () => {
  assert.equal(excludesWindows("process.platform === 'win32' ? 'POSIX-only' : false"), true);
});
