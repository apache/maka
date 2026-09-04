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
import {
  createFilesystemLeaseCoordinator,
  filesystemLeaseRequestsConflict,
  normalizeFilesystemLeaseRequests,
  type FilesystemLeaseMode,
  type FilesystemLeaseRequest,
  type FilesystemLeaseScope,
} from '../filesystem-lease-coordinator.js';

function request(
  key: string,
  mode: FilesystemLeaseMode,
  scope: FilesystemLeaseScope = 'exact',
): FilesystemLeaseRequest {
  return { key, mode, scope };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('FilesystemLeaseCoordinator', () => {
  it('implements exact/tree read-write conflict semantics', () => {
    assert.equal(
      filesystemLeaseRequestsConflict(request('src/a', 'read'), request('src/a', 'read')),
      false,
    );
    assert.equal(
      filesystemLeaseRequestsConflict(request('src', 'read', 'tree'), request('src/a', 'write')),
      true,
    );
    assert.equal(
      filesystemLeaseRequestsConflict(request('src', 'read', 'tree'), request('src2/a', 'write')),
      false,
    );
    assert.equal(
      filesystemLeaseRequestsConflict(
        request('src', 'write', 'tree'),
        request('src/sub', 'read', 'tree'),
      ),
      true,
    );
  });

  it('runs same-key writes in submission order and releases after rejection', async () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const gate = deferred();
    const events: string[] = [];
    const first = coordinator.withLease(request('a', 'write'), undefined, async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      throw new Error('expected');
    });
    const second = coordinator.withLease(request('a', 'write'), undefined, async () => {
      events.push('second:start');
      return 2;
    });
    await flushEffects();
    assert.deepEqual(events, ['first:start']);
    gate.resolve();
    await assert.rejects(first, /expected/);
    assert.deepEqual(
      events,
      ['first:start', 'first:end', 'second:start'],
      'drain starts the successor before the first rejection is observable',
    );
    assert.equal(await second, 2);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  });

  it('allows reads and independent paths to fan out', async () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const gate = deferred();
    const started: string[] = [];
    const work = [
      coordinator.withLease(request('a', 'read'), undefined, async () => {
        started.push('read-1');
        await gate.promise;
      }),
      coordinator.withLease(request('a', 'read'), undefined, async () => {
        started.push('read-2');
        await gate.promise;
      }),
      coordinator.withLease(request('b', 'write'), undefined, async () => {
        started.push('write-b');
        await gate.promise;
      }),
    ];
    await flushEffects();
    assert.deepEqual(started, ['read-1', 'read-2', 'write-b']);
    gate.resolve();
    await Promise.all(work);
  });

  it('enforces tree boundaries and writer fairness', async () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const readerGate = deferred();
    const writerGate = deferred();
    const started: string[] = [];
    const reader = coordinator.withLease(request('src', 'read', 'tree'), undefined, async () => {
      started.push('tree-reader');
      await readerGate.promise;
    });
    const writer = coordinator.withLease(request('src/a', 'write'), undefined, async () => {
      started.push('writer');
      await writerGate.promise;
    });
    const laterReader = coordinator.withLease(request('src/a', 'read'), undefined, async () => {
      started.push('later-reader');
    });
    const src2Writer = coordinator.withLease(request('src2/a', 'write'), undefined, async () => {
      started.push('src2-writer');
    });
    await flushEffects();
    assert.deepEqual(started, ['tree-reader', 'src2-writer']);
    readerGate.resolve();
    await reader;
    await flushEffects();
    assert.deepEqual(started, ['tree-reader', 'src2-writer', 'writer']);
    writerGate.resolve();
    await Promise.all([writer, laterReader, src2Writer]);
    assert.deepEqual(started, ['tree-reader', 'src2-writer', 'writer', 'later-reader']);
  });

  it('removes an aborted queued waiter without running its effect', async () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const gate = deferred();
    const controller = new AbortController();
    let canceledRan = false;
    let afterRan = false;
    const active = coordinator.withLease(request('a', 'read'), undefined, async () => {
      await gate.promise;
    });
    const canceled = coordinator.withLease(request('a', 'write'), controller.signal, async () => {
      canceledRan = true;
    });
    const after = coordinator.withLease(request('a', 'read'), undefined, async () => {
      afterRan = true;
    });
    controller.abort(new Error('stop'));
    await assert.rejects(canceled, /stop/);
    await flushEffects();
    assert.equal(canceledRan, false);
    assert.equal(afterRan, true);
    gate.resolve();
    await Promise.all([active, after]);
  });

  it('does not enqueue or run a pre-aborted request', () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);
    let ran = false;
    assert.throws(
      () =>
        coordinator.withLease(request('a', 'write'), controller.signal, async () => {
          ran = true;
        }),
      (error: unknown) => error === reason,
    );
    assert.equal(ran, false);
  });

  it('does not release an active lease merely because its signal aborts', async () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const controller = new AbortController();
    const gate = deferred();
    let secondRan = false;
    const first = coordinator.withLease(
      request('a', 'write'),
      controller.signal,
      async () => await gate.promise,
    );
    const second = coordinator.withLease(request('a', 'read'), undefined, async () => {
      secondRan = true;
    });
    await flushEffects();
    controller.abort();
    await flushEffects();
    assert.equal(secondRan, false);
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(secondRan, true);
  });

  it('admits reversed multi-key requests atomically and deduplicates exact duplicates', async () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const normalized = normalizeFilesystemLeaseRequests([
      request('b', 'write'),
      request('a', 'write'),
      request('a', 'write'),
    ]);
    assert.deepEqual(
      normalized.map(({ key }) => key),
      ['a', 'b'],
    );
    const gate = deferred();
    const started: string[] = [];
    const first = coordinator.withLeases(normalized, undefined, async () => {
      started.push('first');
      await gate.promise;
    });
    const second = coordinator.withLeases(
      [request('b', 'write'), request('a', 'write')],
      undefined,
      async () => {
        started.push('second');
      },
    );
    await flushEffects();
    assert.deepEqual(started, ['first']);
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(started, ['first', 'second']);
  });

  it('never partially admits a multi-key waiter', async () => {
    const coordinator = createFilesystemLeaseCoordinator();
    const gate = deferred();
    const started: string[] = [];
    const activeA = coordinator.withLease(request('a', 'read'), undefined, async () => {
      started.push('active-a');
      await gate.promise;
    });
    const multi = coordinator.withLeases(
      [request('a', 'write'), request('b', 'write')],
      undefined,
      async () => {
        started.push('multi');
      },
    );
    const laterB = coordinator.withLease(request('b', 'read'), undefined, async () => {
      started.push('later-b');
    });
    const independentC = coordinator.withLease(request('c', 'write'), undefined, async () => {
      started.push('independent-c');
    });
    await flushEffects();
    assert.deepEqual(started, ['active-a', 'independent-c']);
    gate.resolve();
    await Promise.all([activeA, multi, laterB, independentC]);
    assert.deepEqual(started, ['active-a', 'independent-c', 'multi', 'later-b']);
  });
});
