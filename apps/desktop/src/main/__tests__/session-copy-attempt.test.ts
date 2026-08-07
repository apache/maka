import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as SessionCopyAttemptModule from '../../renderer/session-copy-attempt.js';

test('one logical Session copy preserves its target and source boundary across renderer reload', async () => {
  const storage = memoryStorage();
  const key: SessionCopyAttemptModule.SessionCopyAttemptKey = {
    scope: 'turn-footer:turn-reload',
    kind: 'branch',
    sourceSessionId: 'source-reload',
  };
  let sequence = 0;
  const firstModule = await loadFreshModule('first');
  const first = firstModule.acquireSessionCopyAttempt(
    key,
    'turn-before-reload',
    storage,
    () => `copy-${++sequence}`,
  );

  const reloadedModule = await loadFreshModule('reloaded');
  assert.equal(first.phase, 'reserved');
  assert.equal(firstModule.startSessionCopyAttempt(key, first.copyId, storage), true);
  const retry = reloadedModule.acquireSessionCopyAttempt(
    key,
    'newer-settled-turn',
    storage,
    () => `copy-${++sequence}`,
  );
  assert.deepEqual(
    { copyId: retry.copyId, sourceTurnId: retry.sourceTurnId, phase: retry.phase },
    { copyId: first.copyId, sourceTurnId: 'turn-before-reload', phase: 'started' },
  );
  assert.equal(sequence, 1);

  assert.equal(reloadedModule.abandonSessionCopyAttempt(key, retry.copyId, storage), true);
  const abandoningModule = await loadFreshModule('abandoning');
  const abandoning = abandoningModule.acquireSessionCopyAttempt(
    key,
    'newer-settled-turn',
    storage,
    () => `copy-${++sequence}`,
  );
  assert.equal(abandoning.phase, 'abandoning');
  assert.equal(abandoningModule.startSessionCopyAttempt(key, abandoning.copyId, storage), false);

  abandoning.complete();
  const nextAction = abandoningModule.acquireSessionCopyAttempt(
    key,
    'newer-settled-turn',
    storage,
    () => `copy-${++sequence}`,
  );
  assert.notEqual(nextAction.copyId, first.copyId);
  assert.equal(nextAction.sourceTurnId, 'newer-settled-turn');
  assert.equal(sequence, 2);
  nextAction.complete();
});

test('independent Branch and Revision actions never share a copy identity', async () => {
  const storage = memoryStorage();
  const module = await loadFreshModule('independent');
  let sequence = 0;
  const base = {
    scope: 'conversation-actions:test-independent',
    sourceSessionId: 'source-independent',
  } as const;
  const branch = module.acquireSessionCopyAttempt(
    { ...base, kind: 'branch' },
    'turn-independent',
    storage,
    () => `copy-${++sequence}`,
  );
  const revision = module.acquireSessionCopyAttempt(
    { ...base, kind: 'revision' },
    'turn-independent',
    storage,
    () => `copy-${++sequence}`,
  );

  assert.notEqual(branch.copyId, revision.copyId);
  branch.complete();
  revision.complete();
});

async function loadFreshModule(name: string): Promise<typeof SessionCopyAttemptModule> {
  const url = new URL('../../renderer/session-copy-attempt.js', import.meta.url);
  url.searchParams.set('instance', name);
  return import(url.href) as Promise<typeof SessionCopyAttemptModule>;
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
