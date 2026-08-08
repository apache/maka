import assert from 'node:assert/strict';
import test from 'node:test';
import { ExternalSessionImportLifecycle } from '../../renderer/external-session-import-lifecycle.js';
import { getExternalSessionImportCopy } from '../../renderer/locales/external-session-import-copy.js';

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

test('commit uncertainty copy directs users to inspect sessions before retrying', () => {
  const zhCopy = getExternalSessionImportCopy('zh');
  const enCopy = getExternalSessionImportCopy('en');

  assert.match(zhCopy.importOutcomeUnknownDescription, /检查 Maka 会话列表/);
  assert.match(zhCopy.importOutcomeUnknownDescription, /不要再次导入/);
  assert.doesNotMatch(zhCopy.importOutcomeUnknownDescription, /请重试/);
  assert.match(enCopy.importOutcomeUnknownDescription, /check the Maka Session list/i);
  assert.match(enCopy.importOutcomeUnknownDescription, /do not import it again/i);
});
