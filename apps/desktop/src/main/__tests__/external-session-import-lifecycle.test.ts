import assert from 'node:assert/strict';
import test from 'node:test';
import { ExternalSessionImportLifecycle } from '../../renderer/external-session-import-lifecycle.js';

test('blocks dialog close while an import is active', () => {
  const lifecycle = new ExternalSessionImportLifecycle();

  assert.equal(lifecycle.canClose(), true);
  const token = lifecycle.begin();
  assert.equal(lifecycle.canClose(), false);
  assert.equal(lifecycle.isCurrent(token), true);
  assert.equal(lifecycle.finish(token), true);
  assert.equal(lifecycle.canClose(), true);
});

test('invalidates an old completion before a later dialog lifetime starts', () => {
  const lifecycle = new ExternalSessionImportLifecycle();
  const oldToken = lifecycle.begin();

  lifecycle.invalidate();
  const newToken = lifecycle.begin();

  assert.equal(lifecycle.isCurrent(oldToken), false);
  assert.equal(lifecycle.finish(oldToken), false);
  assert.equal(lifecycle.isCurrent(newToken), true);
  assert.equal(lifecycle.canClose(), false);
});
