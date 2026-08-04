import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as publicStorage from '../index.js';
import * as legacyTestSupport from '../legacy-execution-test-support.js';

test('retired execution file writers are absent from the production storage entrypoint', () => {
  assert.equal('createAgentRunStore' in publicStorage, false);
  assert.equal('createRuntimeEventStore' in publicStorage, false);
  assert.equal('createShellRunStore' in publicStorage, false);
  assert.equal(typeof publicStorage.createSqliteAgentRunStore, 'function');
  assert.equal(typeof publicStorage.createSqliteShellRunStore, 'function');
});

test('legacy execution writers are isolated behind explicit test support names', () => {
  assert.deepEqual(Object.keys(legacyTestSupport).sort(), [
    'createLegacyAgentRunStoreForTest',
    'createLegacyRuntimeEventStoreForTest',
    'createLegacyShellRunStoreForTest',
  ]);
});
