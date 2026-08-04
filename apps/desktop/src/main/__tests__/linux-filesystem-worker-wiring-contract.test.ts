import assert from 'node:assert/strict';
import { buildDesktopBuiltinTools } from '../desktop-builtin-tools.js';
import { test } from 'node:test';

test('Desktop exposes Edit only when a filesystem worker is available', () => {
  const withoutWorker = buildDesktopBuiltinTools({});
  const withWorker = buildDesktopBuiltinTools({ filesystemWorker: {} as never });

  assert.equal(withoutWorker.some((tool) => tool.name === 'Edit'), false);
  assert.equal(withWorker.some((tool) => tool.name === 'Edit'), true);
});
