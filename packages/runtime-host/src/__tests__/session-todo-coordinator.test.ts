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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tryAcquireInteractiveRootOwner, resolveStorageRoot } from '@maka/storage/root-authority';
import { openInteractiveSessionTodoStoreForWrite } from '@maka/storage/session-todo-authority';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostSessionTodoCoordinator } from '../server/session-todo-coordinator.js';

test('read/bootstrap is silent and each committed replace publishes once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-host-session-todo-'));
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const writer = await openInteractiveSessionTodoStoreForWrite(owner.lease);
    const changed: string[] = [];
    const coordinator = new HostSessionTodoCoordinator(
      writer,
      new SessionAdmissionGate(),
      { probeSessionRemoval: async () => ({ kind: 'present' }) },
      (sessionId) => changed.push(sessionId),
      () => assert.fail('publication should not drain'),
    );
    assert.deepEqual(await coordinator.read('session-1'), { items: [] });
    assert.deepEqual(changed, []);
    await assert.rejects(
      () => coordinator.replace('session-1', [{ content: '', status: 'pending' }]),
      /cannot be empty/,
    );
    assert.deepEqual(changed, []);
    await coordinator.replace('session-1', [{ content: 'one', status: 'pending' }]);
    assert.deepEqual(changed, ['session-1']);
    await coordinator.read('session-1');
    assert.deepEqual(changed, ['session-1']);
    writer.close();
    await owner.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('committed replacement survives a synchronous publication failure and requests drain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-host-session-todo-publication-'));
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const writer = await openInteractiveSessionTodoStoreForWrite(owner.lease);
    let drains = 0;
    const coordinator = new HostSessionTodoCoordinator(
      writer,
      new SessionAdmissionGate(),
      { probeSessionRemoval: async () => ({ kind: 'present' }) },
      () => {
        throw new Error('projection failed');
      },
      () => {
        drains += 1;
      },
    );
    const committed = await coordinator.replace('session-1', [
      { content: 'committed before publication', status: 'completed' },
    ]);
    assert.deepEqual(committed, {
      items: [{ content: 'committed before publication', status: 'completed' }],
    });
    assert.equal(drains, 1);
    assert.deepEqual(await coordinator.read('session-1'), committed);
    writer.close();
    await owner.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
