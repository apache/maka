/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

test('renderer reload can enumerate every orphaned Side Chat copy owner', async () => {
  const storage = memoryStorage();
  const firstModule = await loadFreshModule('side-chat-first');
  const first = firstModule.acquireSessionCopyAttempt(
    {
      scope: 'quote-companion:panel-a',
      kind: 'branch',
      sourceSessionId: 'source-side-chat',
    },
    'turn-a',
    storage,
    () => 'copy-a',
  );
  const second = firstModule.acquireSessionCopyAttempt(
    {
      scope: 'quote-companion:panel-b',
      kind: 'branch',
      sourceSessionId: 'source-side-chat',
    },
    'turn-b',
    storage,
    () => 'copy-b',
  );
  firstModule.startSessionCopyAttempt(
    {
      scope: 'quote-companion:panel-a',
      kind: 'branch',
      sourceSessionId: 'source-side-chat',
    },
    first.copyId,
    storage,
  );
  firstModule.startSessionCopyAttempt(
    {
      scope: 'quote-companion:panel-b',
      kind: 'branch',
      sourceSessionId: 'source-side-chat',
    },
    second.copyId,
    storage,
  );

  const reloadedModule = await loadFreshModule('side-chat-reloaded');
  assert.deepEqual(
    reloadedModule
      .listSessionCopyAttempts('quote-companion:', storage)
      .map(({ key, attempt }) => ({ scope: key.scope, copyId: attempt.copyId }))
      .sort((left, right) => left.scope.localeCompare(right.scope)),
    [
      { scope: 'quote-companion:panel-a', copyId: 'copy-a' },
      { scope: 'quote-companion:panel-b', copyId: 'copy-b' },
    ],
  );
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
