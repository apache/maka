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
import { describe, test } from 'node:test';
import {
  createProcessResourceAdmissionCoordinator,
  ProcessResourceAdmissionUpgradeError,
  type ProcessResourceAdmissionTransition,
} from '../process-resource-admission.js';

describe('ProcessResourceAdmissionCoordinator', () => {
  test('admits shared holders together', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const release = deferred<void>();
    const starts: string[] = [];
    const first = coordinator.withShared(undefined, async () => {
      starts.push('first');
      await release.promise;
    });
    const second = coordinator.withShared(undefined, async () => {
      starts.push('second');
      await release.promise;
    });

    assert.deepEqual(starts, ['first', 'second']);
    assert.deepEqual(coordinator.inspect(), {
      queued: [],
      activeShared: 2,
      activeExclusive: false,
    });
    release.resolve();
    await Promise.all([first, second]);
    assertIdle(coordinator.inspect());
  });

  test('serializes shared/exclusive and exclusive/exclusive in both directions', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const releaseShared = deferred<void>();
    const releaseExclusive = deferred<void>();
    const events: string[] = [];
    const shared = coordinator.withShared(undefined, async () => {
      events.push('shared');
      await releaseShared.promise;
    });
    const firstExclusive = coordinator.withExclusive(undefined, async () => {
      events.push('exclusive-1');
      await releaseExclusive.promise;
    });
    const secondExclusive = coordinator.withExclusive(undefined, async () => {
      events.push('exclusive-2');
    });
    const laterShared = coordinator.withShared(undefined, async () => {
      events.push('shared-2');
    });

    assert.deepEqual(events, ['shared']);
    releaseShared.resolve();
    await shared;
    assert.deepEqual(events, ['shared', 'exclusive-1']);
    releaseExclusive.resolve();
    await firstExclusive;
    assert.deepEqual(events, ['shared', 'exclusive-1', 'exclusive-2']);
    await secondExclusive;
    assert.deepEqual(events, ['shared', 'exclusive-1', 'exclusive-2', 'shared-2']);
    await laterShared;
    assertIdle(coordinator.inspect());
  });

  test('does not let a later shared holder overtake a queued writer', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const releaseFirst = deferred<void>();
    const releaseWriter = deferred<void>();
    const events: string[] = [];
    const first = coordinator.withShared(undefined, async () => {
      events.push('shared-1');
      await releaseFirst.promise;
    });
    const writer = coordinator.withExclusive(undefined, async () => {
      events.push('exclusive');
      await releaseWriter.promise;
    });
    const later = coordinator.withShared(undefined, async () => {
      events.push('shared-2');
    });

    assert.deepEqual(events, ['shared-1']);
    releaseFirst.resolve();
    await first;
    assert.deepEqual(events, ['shared-1', 'exclusive']);
    releaseWriter.resolve();
    await writer;
    assert.deepEqual(events, ['shared-1', 'exclusive', 'shared-2']);
    await later;
  });

  test('removes an aborted queued writer and immediately drains later shared work', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const release = deferred<void>();
    const controller = new AbortController();
    const events: string[] = [];
    const first = coordinator.withShared(undefined, async () => {
      events.push('shared-1');
      await release.promise;
    });
    const writer = coordinator.withExclusive(controller.signal, async () => {
      events.push('must-not-run');
    });
    const writerRejected = assert.rejects(writer, /cancelled/);
    const later = coordinator.withShared(undefined, async () => {
      events.push('shared-2');
    });

    assert.deepEqual(events, ['shared-1']);
    controller.abort(new Error('cancelled'));
    assert.deepEqual(events, ['shared-1', 'shared-2']);
    await writerRejected;
    await later;
    release.resolve();
    await first;
    assertIdle(coordinator.inspect());
  });

  test('rejects pre-aborted work without running its effect', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    let ran = false;

    await assert.rejects(
      coordinator.withExclusive(controller.signal, async () => {
        ran = true;
      }),
      (error) => error === reason,
    );
    assert.equal(ran, false);
    assertIdle(coordinator.inspect());
  });

  test('rejects a pre-aborted compatible reentrant call without running it', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const controller = new AbortController();
    controller.abort(new Error('nested cancelled'));
    let nestedRan = false;

    await coordinator.withExclusive(undefined, async () => {
      await assert.rejects(
        coordinator.withShared(controller.signal, async () => {
          nestedRan = true;
        }),
        /nested cancelled/,
      );
    });
    assert.equal(nestedRan, false);
    assertIdle(coordinator.inspect());
  });

  test('does not release an active holder merely because its signal aborts', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const controller = new AbortController();
    const release = deferred<void>();
    let laterStarted = false;
    const active = coordinator.withShared(controller.signal, async () => {
      await release.promise;
    });
    const later = coordinator.withExclusive(undefined, async () => {
      laterStarted = true;
    });

    controller.abort(new Error('active cancellation'));
    assert.equal(laterStarted, false);
    release.resolve();
    await active;
    assert.equal(laterStarted, true);
    await later;
  });

  test('releases and drains before an effect rejection is observable', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const release = deferred<void>();
    const events: string[] = [];
    const first = coordinator.withExclusive(undefined, async () => {
      events.push('first:start');
      await release.promise;
      events.push('first:end');
      throw new Error('expected failure');
    });
    const second = coordinator.withShared(undefined, async () => {
      events.push('second:start');
    });

    release.resolve();
    await assert.rejects(first, /expected failure/);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
    await second;
    assertIdle(coordinator.inspect());
  });

  test('reuses compatible owners and rejects shared-to-exclusive upgrades', async () => {
    const transitions: ProcessResourceAdmissionTransition[] = [];
    const coordinator = createProcessResourceAdmissionCoordinator({
      onTransition: (transition) => transitions.push(transition),
    });
    const events: string[] = [];

    await coordinator.withExclusive(undefined, async () => {
      events.push('outer-exclusive');
      await coordinator.withShared(undefined, async () => {
        events.push('nested-shared');
      });
      await coordinator.withExclusive(undefined, async () => {
        events.push('nested-exclusive');
      });
    });
    await coordinator.withShared(undefined, async () => {
      await assert.rejects(
        coordinator.withExclusive(undefined, async () => undefined),
        (error) =>
          error instanceof ProcessResourceAdmissionUpgradeError &&
          error.code === 'process_admission_upgrade_not_allowed',
      );
    });

    assert.deepEqual(events, ['outer-exclusive', 'nested-shared', 'nested-exclusive']);
    assert.equal(transitions.filter((transition) => transition.reused_owner === true).length, 2);
    assertIdle(coordinator.inspect());
  });

  test('holds the root admission until fire-and-forget nested references settle', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const nestedRelease = deferred<void>();
    const nestedStarted = deferred<void>();
    let nested!: Promise<void>;
    let outerSettled = false;
    let laterStarted = false;
    const outer = coordinator.withExclusive(undefined, async () => {
      nested = coordinator.withShared(undefined, async () => {
        nestedStarted.resolve();
        await nestedRelease.promise;
      });
      return 'outer-result';
    });
    void outer.then(() => {
      outerSettled = true;
    });
    await nestedStarted.promise;
    const later = coordinator.withShared(undefined, async () => {
      laterStarted = true;
    });
    await flushMicrotasks();

    assert.equal(outerSettled, false);
    assert.equal(laterStarted, false);
    nestedRelease.resolve();
    await nested;
    assert.equal(await outer, 'outer-result');
    assert.equal(laterStarted, true);
    await later;
    assertIdle(coordinator.inspect());
  });

  test('does not reuse an inactive owner from a stale async context', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const trigger = deferred<void>();
    const lateStarted = deferred<void>();
    let late!: Promise<void>;
    await coordinator.withExclusive(undefined, async () => {
      void trigger.promise.then(() => {
        late = coordinator.withShared(undefined, async () => {
          lateStarted.resolve();
        });
      });
    });

    trigger.resolve();
    await lateStarted.promise;
    await late;
    assertIdle(coordinator.inspect());
  });

  test('treats transition observer failures as diagnostic-only', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator({
      onTransition: () => {
        throw new Error('trace unavailable');
      },
    });

    assert.equal(await coordinator.withExclusive(undefined, async () => 'ok'), 'ok');
    assertIdle(coordinator.inspect());
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function assertIdle(snapshot: {
  readonly queued: readonly unknown[];
  readonly activeShared: number;
  readonly activeExclusive: boolean;
}): void {
  assert.deepEqual(snapshot, { queued: [], activeShared: 0, activeExclusive: false });
}
