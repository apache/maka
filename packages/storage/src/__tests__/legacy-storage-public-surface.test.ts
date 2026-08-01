import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as publicStorage from '../index.js';
import * as publicInteractionStore from '../interaction-store-public.js';
import * as legacyTestSupport from '../legacy-storage-test-support.js';

const retiredRootWriters = [
  'createDeepResearchStore',
  'createLegacyFileSessionStore',
  'createPlanReminderStore',
  'createPlanStore',
  'createTaskLedgerStore',
  'createTelemetryRepo',
] as const;

test('retired structured file writers are absent from production storage entrypoints', () => {
  for (const name of retiredRootWriters) {
    assert.equal(name in publicStorage, false, `${name} must not be a production root export`);
  }
  assert.equal('openInteractiveInteractionStoreForRead' in publicInteractionStore, false);
  assert.equal('openInteractiveInteractionStoreForWrite' in publicInteractionStore, false);

  assert.equal(typeof publicStorage.createSqliteDeepResearchStore, 'function');
  assert.equal(typeof publicStorage.createSqlitePlanReminderStore, 'function');
  assert.equal(typeof publicStorage.createSqlitePlanStore, 'function');
  assert.equal(typeof publicStorage.createSqliteTaskLedgerStore, 'function');
  assert.equal(typeof publicStorage.createSqliteTelemetryRepo, 'function');
  assert.equal(typeof publicStorage.createSessionStore, 'function');
  assert.equal(
    typeof publicInteractionStore.openSqliteInteractiveInteractionStoreForWrite,
    'function',
  );
});

test('remaining legacy writers are isolated behind explicit test support names', () => {
  assert.deepEqual(Object.keys(legacyTestSupport).sort(), [
    'createLegacyDeepResearchStoreForTest',
    'createLegacyPlanReminderStoreForTest',
    'createLegacyPlanStoreForTest',
    'createLegacySessionStoreForTest',
    'createLegacyTaskLedgerStoreForTest',
    'createLegacyTelemetryRepoForTest',
    'openLegacyInteractiveInteractionStoreForReadForTest',
    'openLegacyInteractiveInteractionStoreForWriteForTest',
  ]);
});
