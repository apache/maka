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

/**
 * Unit test for the shared optimistic last-write-wins draft controller that
 * backs `useOptimisticSettingsDraft`. The React shell is covered by the
 * per-page Settings contract tests + manual UI testing; here we pin the pure
 * async-correctness contract that used to be hand-copied on every page.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createOptimisticDraftController,
  type OptimisticDraftController,
} from '../../renderer/settings/optimistic-settings-draft-controller.js';

interface Draft {
  v: number;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(initial: Draft) {
  const drafts: Draft[] = [];
  const errors: unknown[] = [];
  const savingChanges: boolean[] = [];
  const pending: Array<{ patch: Partial<Draft>; deferred: ReturnType<typeof deferred<Draft>> }> = [];
  const controller: OptimisticDraftController<Draft> = createOptimisticDraftController<Draft>({
    initial,
    onUpdate: (patch) => {
      const d = deferred<Draft>();
      pending.push({ patch, deferred: d });
      return d.promise;
    },
    onDraftChange: (draft) => drafts.push(draft),
    onError: (error) => errors.push(error),
    onSavingChange: (saving) => savingChanges.push(saving),
    isMounted: () => true,
  });
  return {
    controller,
    drafts,
    errors,
    savingChanges,
    pending,
  };
}

describe('createOptimisticDraftController last-write-wins', () => {
  it('edits the local draft without persisting', () => {
    const h = harness({ v: 0 });

    h.controller.edit({ v: 4 });

    assert.deepEqual(h.controller.draftRef.current, { v: 4 });
    assert.deepEqual(h.drafts, [{ v: 4 }]);
    assert.equal(h.pending.length, 0, 'editing alone must not start a save');
    assert.deepEqual(h.savingChanges, [], 'editing alone must not enter the saving state');
  });

  it('drops a stale save response so it cannot clobber a newer draft', async () => {
    const h = harness({ v: 0 });

    const first = h.controller.update({ v: 1 });
    const second = h.controller.update({ v: 2 });

    // Both applied their optimistic drafts immediately, newest last.
    assert.deepEqual(h.drafts, [{ v: 1 }, { v: 2 }]);

    // Resolve the NEWER save first with its authoritative value.
    h.pending[1].deferred.resolve({ v: 20 });
    assert.equal(await second, true, 'the current save reports success');
    assert.deepEqual(h.controller.draftRef.current, { v: 20 });

    // Now the STALE earlier save resolves — it must not commit over the newer draft.
    h.pending[0].deferred.resolve({ v: 10 });
    assert.equal(await first, false, 'a superseded save reports failure to its caller');
    assert.deepEqual(
      h.controller.draftRef.current,
      { v: 20 },
      'stale save response must not overwrite the newer committed draft',
    );
    assert.equal(
      h.drafts.some((draft) => draft.v === 10),
      false,
      'the stale server value must never reach the rendered draft',
    );
  });

  it('rolls the draft back to persisted on failure and reports failure', async () => {
    const h = harness({ v: 0 });

    const save = h.controller.update({ v: 5 });
    assert.deepEqual(h.controller.draftRef.current, { v: 5 }, 'optimistic value shows immediately');

    h.pending[0].deferred.reject(new Error('boom'));
    assert.equal(await save, false);
    assert.deepEqual(h.controller.draftRef.current, { v: 0 }, 'draft rolls back to the persisted value');
    assert.equal(h.errors.length, 1, 'the failure is surfaced to the caller');
  });

  it('rolls a newer failed save back to an earlier confirmed success', async () => {
    const h = harness({ v: 0 });

    const first = h.controller.update({ v: 1 });
    const second = h.controller.update({ v: 2 });

    h.pending[0].deferred.resolve({ v: 10 });
    await first;
    assert.deepEqual(h.controller.draftRef.current, { v: 2 }, 'the newer optimistic draft stays visible');

    h.pending[1].deferred.reject(new Error('newer save failed'));
    await second;

    assert.deepEqual(
      h.controller.draftRef.current,
      { v: 10 },
      'failure restores the newest value already confirmed by persistence',
    );
  });

  it('applies an earlier confirmed success that settles after a newer failure', async () => {
    const h = harness({ v: 0 });

    const first = h.controller.update({ v: 1 });
    const second = h.controller.update({ v: 2 });

    h.pending[1].deferred.reject(new Error('newer save failed'));
    await second;
    assert.deepEqual(h.controller.draftRef.current, { v: 0 }, 'the current failure uses the baseline known so far');

    h.pending[0].deferred.resolve({ v: 10 });
    await first;

    assert.deepEqual(
      h.controller.draftRef.current,
      { v: 10 },
      'the final settle reveals the newest value confirmed by persistence',
    );
  });

  it('does not resync the draft from persisted while a save is in flight', async () => {
    const h = harness({ v: 0 });

    const save = h.controller.update({ v: 7 });
    // A background settings change arrives mid-save: it must not reset the
    // optimistic edit out from under the user.
    h.controller.syncPersisted({ v: 99 });
    assert.deepEqual(h.controller.draftRef.current, { v: 7 }, 'in-flight edit is preserved');

    h.pending[0].deferred.resolve({ v: 7 });
    await save;

    // Once nothing is in flight, a later persisted change syncs through.
    h.controller.syncPersisted({ v: 42 });
    assert.deepEqual(h.controller.draftRef.current, { v: 42 });
  });

  it('applies the latest persisted snapshot when the final pending save settles', async () => {
    const h = harness({ v: 0 });

    const first = h.controller.update({ v: 1 });
    const second = h.controller.update({ v: 2 });
    h.pending[1].deferred.resolve({ v: 20 });
    await second;

    h.controller.syncPersisted({ v: 99 });
    assert.deepEqual(h.controller.draftRef.current, { v: 20 }, 'pending work defers the external snapshot');

    h.pending[0].deferred.resolve({ v: 10 });
    await first;

    assert.deepEqual(
      h.controller.draftRef.current,
      { v: 99 },
      'the deferred snapshot lands automatically when pending reaches zero',
    );
  });

  it('reports saving for the full pending batch instead of each individual settle', async () => {
    const h = harness({ v: 0 });

    const first = h.controller.update({ v: 1 });
    const second = h.controller.update({ v: 2 });
    assert.deepEqual(h.savingChanges, [true], 'the first pending save enters saving state once');

    h.pending[0].deferred.resolve({ v: 10 });
    await first;
    assert.deepEqual(h.savingChanges, [true], 'a partial settle keeps the batch pending');

    h.pending[1].deferred.resolve({ v: 20 });
    await second;
    assert.deepEqual(h.savingChanges, [true, false], 'the final settle clears saving state once');
  });

  it('invalidates an in-flight save after dispose even while the owner still reports mounted', async () => {
    const h = harness({ v: 0 });

    const save = h.controller.update({ v: 3 });
    h.controller.dispose();
    h.pending[0].deferred.resolve({ v: 30 });

    assert.equal(await save, false, 'a save resolving after dispose reports failure');
    assert.equal(
      h.drafts.some((draft) => draft.v === 30),
      false,
      'a save resolving after dispose must not write the draft',
    );
  });

  it('accepts updates again after a StrictMode cleanup replay reactivates it', async () => {
    const h = harness({ v: 0 });

    h.controller.dispose();
    h.controller.activate();

    const save = h.controller.update({ v: 2 });
    assert.equal(h.pending.length, 1, 'reactivation must restore persistence calls');
    h.pending[0].deferred.resolve({ v: 20 });

    assert.equal(await save, true);
    assert.deepEqual(h.controller.draftRef.current, { v: 20 });
  });

  it('keeps pre-dispose responses invalid after reactivation', async () => {
    const h = harness({ v: 0 });

    const staleSave = h.controller.update({ v: 1 });
    h.controller.dispose();
    h.controller.activate();
    h.pending[0].deferred.resolve({ v: 10 });

    assert.equal(await staleSave, false);
    assert.equal(
      h.drafts.some((draft) => draft.v === 10),
      false,
      'reactivation must not revive responses owned by the previous lifecycle',
    );
  });
});
