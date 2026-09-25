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
import { deferred } from '@maka/core/test-only/async-primitives';
import { describe, test } from 'node:test';
import { McpCredentialCoordinator } from '../credential-coordinator.js';
import type { McpOAuthRecord, McpOAuthStorage } from '../oauth.js';

describe('McpCredentialCoordinator', () => {
  test('sparing successor credentials preserves the active flow without entering the erase commit', async () => {
    let stored: McpOAuthRecord = {
      version: 1,
      generation: 0,
      tokens: { access_token: 'successor-token', token_type: 'Bearer' },
    };
    const coordinator = new McpCredentialCoordinator({
      get: async () => structuredClone(stored),
      set: async (_id, record) => {
        stored = structuredClone(record);
      },
      delete: async () => {},
    });
    const flow = coordinator.flowStorage('remote');
    await flow.get('remote');
    let commitStarted = false;
    await coordinator.erase('remote', {
      signal: new AbortController().signal,
      spare: (record) => record.tokens?.access_token === 'successor-token',
      onCommitStarted: () => {
        commitStarted = true;
      },
    });
    assert.equal(commitStarted, false);
    assert.equal(stored.tokens?.access_token, 'successor-token');
    await flow.set('remote', { tokens: { access_token: 'refreshed-token', token_type: 'Bearer' } });
    assert.equal(stored.tokens?.access_token, 'refreshed-token');
    assert.equal(stored.generation, 0);
  });

  test('an abort landing during the storage read blocks the commit', async () => {
    // The guard is checked before the read; without the re-check after it,
    // an abort arriving while the read waits would still commit the stale
    // record — a timed-out OAuth flow persisting its verifier late.
    let releaseGet!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const writes: McpOAuthRecord[] = [];
    const storage: McpOAuthStorage = {
      get: async () => {
        await gate;
        return undefined;
      },
      set: async (_id, record) => {
        writes.push(record);
      },
      delete: async () => {},
    };
    const coordinator = new McpCredentialCoordinator(storage);
    const round = new AbortController();
    const flow = coordinator.flowStorage('remote', { signal: round.signal });

    const write = flow.set('remote', { codeVerifier: 'late-verifier' });
    round.abort();
    releaseGet();

    await assert.rejects(write, (error) => error === round.signal.reason);
    assert.deepEqual(writes, []);
  });

  test('a stale flow cannot delete or overwrite another writer’s rotation', async () => {
    // Process A's flow reads the record, process B rotates it (its own
    // coordinator, same backing store), then A's failing flow tries to
    // invalidate. Generations match — only the version fence can tell A
    // that the material it wants to delete is not the material it read.
    const backing = new Map<string, McpOAuthRecord>();
    const storage: McpOAuthStorage = {
      get: async (id) => backing.get(id) && structuredClone(backing.get(id)),
      set: async (id, record) => {
        backing.set(id, structuredClone(record));
      },
      delete: async (id) => {
        backing.delete(id);
      },
    };
    await storage.set('remote', { version: 1, tokens: { access_token: 'r1', token_type: 'B' } });

    const coordinatorA = new McpCredentialCoordinator(storage);
    const coordinatorB = new McpCredentialCoordinator(storage);
    const flowA = coordinatorA.flowStorage('remote', {});
    await flowA.get('remote'); // A captures version 1

    const flowB = coordinatorB.flowStorage('remote', {});
    await flowB.get('remote');
    await flowB.set('remote', { tokens: { access_token: 'r2-rotated', token_type: 'B' } });

    await assert.rejects(flowA.delete('remote'), /rotated by another writer/u);
    await assert.rejects(
      flowA.set('remote', { tokens: { access_token: 'r1-stale', token_type: 'B' } }),
      /rotated by another writer/u,
    );
    assert.equal(backing.get('remote')?.tokens?.access_token, 'r2-rotated');
  });

  test('logout follows an earlier write and fences every subsequent write from that flow', async () => {
    let releaseGet!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let held = true;
    const writes: McpOAuthRecord[] = [];
    const storage: McpOAuthStorage = {
      get: async () => {
        if (held) {
          held = false;
          await gate;
        }
        return undefined;
      },
      set: async (_id, record) => {
        writes.push(record);
      },
      delete: async () => {},
    };
    const coordinator = new McpCredentialCoordinator(storage);
    const flow = coordinator.flowStorage('remote', {});

    const write = flow.set('remote', { codeVerifier: 'late-verifier' });
    const erasing = coordinator.erase('remote');
    releaseGet();
    await erasing.catch(() => {});

    await write;
    // The preceding write settles before the erase takes effect. Once the
    // tombstone lands, this flow can no longer resurrect any credentials.
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.codeVerifier, undefined);
    assert.equal(writes[1]?.generation, 1);
    await assert.rejects(flow.set('remote', { codeVerifier: 'stale' }), /cleared/u);
  });

  test('an abandoned erase cannot tombstone the record a newer login stored', async () => {
    // A timed-out logout abandons its caller, but the stalled erase keeps
    // running. When it resumes it would read the CURRENT record — the fresh
    // tokens a newer login just stored — as its basis and tombstone them.
    // The abandonment signal fences the commit on both sides of the read.
    let releaseGet!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let stored: McpOAuthRecord = { version: 1, generation: 0 };
    const writes: McpOAuthRecord[] = [];
    const storage: McpOAuthStorage = {
      get: async () => {
        await gate;
        return stored;
      },
      set: async (_id, record) => {
        writes.push(record);
        stored = record;
      },
      delete: async () => {},
    };
    const coordinator = new McpCredentialCoordinator(storage);
    const round = new AbortController();

    const erasing = coordinator.erase('remote', { signal: round.signal });
    // The logout round times out while the storage read is still parked;
    // a fresh login then completes and rotates the record.
    round.abort();
    stored = { version: 7, generation: 0 };
    releaseGet();

    await assert.rejects(erasing, (error) => error === round.signal.reason);
    assert.equal(writes.length, 0);
    assert.equal(stored.version, 7);

    // An already-abandoned erase never reaches storage at all.
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      coordinator.erase('remote', { signal: aborted.signal }),
      (error) => error === aborted.signal.reason,
    );
    assert.equal(writes.length, 0);
  });

  for (const phase of ['queued', 'reading'] as const) {
    test(`erase cancellation releases precommit ${phase} waiting without a late write`, async () => {
      const entered = deferred<void>();
      const release = deferred<void>();
      let writes = 0;
      const coordinator = new McpCredentialCoordinator({
        get: async () => {
          if (phase === 'reading') {
            entered.resolve();
            await release.promise;
          }
          return undefined;
        },
        set: async () => {
          writes += 1;
        },
        delete: async () => {
          writes += 1;
        },
      });
      const blocker =
        phase === 'queued'
          ? coordinator.run('remote', async () => {
              entered.resolve();
              await release.promise;
            })
          : undefined;
      const abort = new AbortController();
      let commitStarted = false;
      const erasing = coordinator.erase('remote', {
        signal: abort.signal,
        onCommitStarted: () => {
          commitStarted = true;
        },
      });
      const outcome = erasing.then(
        () => 'resolved',
        () => 'rejected',
      );
      await entered.promise;
      abort.abort(new Error('stop precommit erase'));
      const settled = await Promise.race([
        outcome,
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
      ]);
      release.resolve();
      await blocker;
      await outcome;
      await coordinator.run('remote', async () => undefined);
      assert.equal(settled, 'rejected');
      assert.equal(commitStarted, false);
      assert.equal(writes, 0);
    });
  }

  test('an erase ignores cancellation after its irreversible commit boundary', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let stored: McpOAuthRecord | undefined = {
      version: 1,
      generation: 0,
      tokens: { access_token: 'old-token', token_type: 'Bearer' },
    };
    const storage: McpOAuthStorage = {
      get: async () => stored,
      set: async (_id, record) => {
        writeStarted();
        await writeGate;
        stored = record;
      },
      delete: async () => {},
    };
    const coordinator = new McpCredentialCoordinator(storage);
    const round = new AbortController();
    let boundaryCalls = 0;

    const erasing = coordinator.erase('remote', {
      signal: round.signal,
      onCommitStarted: () => {
        boundaryCalls += 1;
        round.abort(new Error('too late to cancel erase'));
      },
    });
    await started;
    assert.equal(round.signal.aborted, true);
    assert.equal(boundaryCalls, 1);

    releaseWrite();
    await erasing;
    assert.deepEqual(stored, { version: 2, generation: 1 });
  });

  test('cancelling a queued erase preserves the preceding login flow and its abort reason', async () => {
    const reading = deferred<void>();
    const release = deferred<void>();
    const writes: McpOAuthRecord[] = [];
    const coordinator = new McpCredentialCoordinator({
      get: async () => {
        reading.resolve();
        await release.promise;
        return undefined;
      },
      set: async (_id, record) => {
        writes.push(record);
      },
      delete: async () => undefined,
    });
    const flow = coordinator.flowStorage('remote');
    const writing = flow.set('remote', { codeVerifier: 'active-login' });
    const observedWrite = writing.then(
      () => undefined,
      (error: unknown) => error,
    );
    await reading.promise;
    const abort = new AbortController();
    const erasing = coordinator.erase('remote', { signal: abort.signal });
    const observedErase = erasing.catch((error: unknown) => error);
    const reason = new Error('cancel queued logout');
    abort.abort(reason);
    const error = await observedErase;
    release.resolve();
    const writeError = await observedWrite;
    assert.equal(error, reason);
    assert.equal(writeError, undefined);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.codeVerifier, 'active-login');
  });
});
