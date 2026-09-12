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
import { describe, it } from 'node:test';
import { createBootstrapSelectionLease } from '../../renderer/bootstrap-selection-lease.js';
import {
  clearNewTaskReloadIntent,
  hasNewTaskReloadIntent,
  markNewTaskReloadIntent,
  readNewTaskReloadDraft,
  readNewTaskReloadIntent,
  UNRESOLVED_NEW_TASK_DRAFT_KEY,
  writeNewTaskReloadDraft,
} from '../../renderer/new-task-reload-intent.js';

type Summary = { id: string; lastMessageAt?: number; isArchived: boolean };

function session(id: string, lastMessageAt?: number, isArchived = false): Summary {
  return { id, lastMessageAt, isArchived };
}

function harness(activeId?: string) {
  let active = activeId;
  let revision = 0;
  const lease = createBootstrapSelectionLease<Summary>({
    readActiveId: () => active,
    readSelectionRevision: () => revision,
    select: (next) => {
      revision += 1;
      active = next;
    },
  });
  return {
    lease,
    activeId: () => active,
    select(next: string | undefined) {
      revision += 1;
      active = next;
    },
  };
}

describe('bootstrap selection lease', () => {
  it('leaves the new-task surface selected when all history is archived', () => {
    const state = harness();
    state.lease.reconcile([session('archived', 2, true), session('older', 1, true)]);
    assert.equal(state.activeId(), undefined);
  });

  it('skips archived rows when choosing the first unarchived conversation', () => {
    const state = harness();
    state.lease.reconcile([
      session('archived', 3, true),
      session('recent', 2),
      session('older', 1),
    ]);
    assert.equal(state.activeId(), 'recent');
  });

  it('revalidates archive eligibility across bootstrap snapshots', () => {
    const state = harness();
    state.lease.reconcile([session('recent', 2), session('older', 1)]);
    assert.equal(state.activeId(), 'recent');
    state.lease.reconcile([session('recent', 2, true), session('older', 1)]);
    assert.equal(state.activeId(), 'older');
    state.lease.reconcile([session('recent', 2, true), session('older', 1, true)]);
    assert.equal(state.activeId(), undefined);
  });

  it('does not reopen older history behind an empty unarchived task', () => {
    const state = harness();
    state.lease.reconcile([
      session('archived', 2, true),
      session('empty'),
      session('history', 1),
    ]);
    assert.equal(state.activeId(), undefined);
  });

  it('preserves an eligible bootstrap selection when newer history arrives', () => {
    const state = harness();
    state.lease.reconcile([session('selected', 1)]);
    state.lease.reconcile([session('newer', 2), session('selected', 1)]);
    assert.equal(state.activeId(), 'selected');
  });

  it('does not override explicitly opened archived history', () => {
    const state = harness();
    state.lease.reconcile([session('active', 1)]);
    state.select('archived');
    assert.equal(
      state.lease.reconcile([session('archived', 2, true), session('active', 1)]),
      false,
    );
    assert.equal(state.activeId(), 'archived');
  });

  it('lets snapshot A and mounted pull B reconcile while bootstrap still owns selection', () => {
    const state = harness();
    assert.equal(state.lease.reconcile([session('a', 1)]), true);
    assert.equal(state.activeId(), 'a');
    assert.equal(state.lease.reconcile([session('b', 2)]), true);
    assert.equal(state.activeId(), 'b');
  });

  it('cannot select history when the user starts a new task before the first snapshot', () => {
    const state = harness();
    state.select(undefined);
    assert.equal(state.lease.reconcile([session('history', 1)]), false);
    assert.equal(state.activeId(), undefined);
  });

  it('cannot replace a user selection made between snapshot A and B', () => {
    const state = harness();
    state.lease.reconcile([session('a', 1)]);
    state.select('user-choice');
    assert.equal(state.lease.reconcile([session('b', 2)]), false);
    assert.equal(state.activeId(), 'user-choice');
  });

  it('clears a bootstrap-owned selection when the latest snapshot is empty', () => {
    const state = harness();
    state.lease.reconcile([session('a', 1)]);
    assert.equal(state.lease.reconcile([]), true);
    assert.equal(state.activeId(), undefined);
  });

  it('does not reconcile after release', () => {
    const state = harness();
    state.lease.release();
    assert.equal(state.lease.reconcile([session('history', 1)]), false);
    assert.equal(state.activeId(), undefined);
  });

  it('keeps an explicit new-task surface across a renderer reload only', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    markNewTaskReloadIntent(storage);
    assert.equal(hasNewTaskReloadIntent(storage), true);

    const reloaded = harness();
    if (hasNewTaskReloadIntent(storage)) reloaded.lease.release();
    assert.equal(
      reloaded.lease.reconcile([session('unrelated-new-session'), session('history', 1)]),
      false,
    );
    assert.equal(reloaded.activeId(), undefined);

    clearNewTaskReloadIntent(storage);
    assert.equal(hasNewTaskReloadIntent(storage), false);
    const coldStart = harness();
    assert.equal(coldStart.lease.reconcile([session('history', 1)]), true);
    assert.equal(coldStart.activeId(), 'history');
  });

  it('keeps a scoped draft with the reload intent', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    markNewTaskReloadIntent(storage);
    const draftKey = '["new-task","office","host-office","project-docs"]';
    writeNewTaskReloadDraft(draftKey, 'unfinished prompt', storage);
    assert.deepEqual(readNewTaskReloadIntent(storage), {
      draft: 'unfinished prompt',
      draftKey,
    });
    assert.equal(readNewTaskReloadDraft(UNRESOLVED_NEW_TASK_DRAFT_KEY, storage), 'unfinished prompt');

    writeNewTaskReloadDraft(UNRESOLVED_NEW_TASK_DRAFT_KEY, 'edited during reload', storage);
    assert.deepEqual(readNewTaskReloadIntent(storage), {
      draft: 'edited during reload',
      draftKey,
    });
    assert.equal(readNewTaskReloadDraft('different-target', storage), undefined);
  });
});
