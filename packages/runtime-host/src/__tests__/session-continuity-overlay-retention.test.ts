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
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  type CanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';

test('released transcript overlays are collectible while their connection stays open', () => {
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { SessionContinuityCoordinator } from ${moduleUrl('../server/session-continuity-coordinator.js')};
    import { SessionAdmissionGate } from ${moduleUrl('../server/session-admission-gate.js')};
    import { transcriptReader } from ${moduleUrl('./fixtures/session-transcript-reader.js')};

    // Observe only the serialized overlay buffers; no snapshot or test sink
    // owns them. Isolate Buffer instrumentation and explicit GC in this process.
    const buffers = [];
    const originalFrom = Buffer.from;
    Buffer.from = function (...args) {
      const buffer = Reflect.apply(originalFrom, Buffer, args);
      if (buffer.byteLength >= 1024 * 1024) buffers.push(new WeakRef(buffer));
      return buffer;
    };
    const reader = transcriptReader([]);
    let generation = 0;
    reader.readActiveOverlay = async () => [{
      type: 'assistant', id: 'message-1', turnId: 'turn-1', ts: 1, modelId: 'model',
      text: String(generation++).padEnd(1024 * 1024, 'x'),
    }];
    const canonical = {
      session: { sessionId: 'session-1', metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false },
      rootTurn: { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1', status: 'running' },
      goal: null, interactions: { pending: [] },
      queue: { hostEpoch: 'epoch', queueRevision: 0, steering: [], followup: [] },
    };
    const coordinator = new SessionContinuityCoordinator(
      'epoch', async () => canonical, new SessionAdmissionGate(), undefined, reader,
    );
    const connection = coordinator.attachConnection('connection-1', { async send() {} });
    const context = {
      hostEpoch: 'epoch', connectionId: 'connection-1', principal: 'local_owner',
      principalKind: 'local_owner', acquireResidency: () => ({ release() {} }),
    };
    async function cycle(release) {
      const opened = await coordinator.handlers['subscription.open'](
        { sessionId: 'session-1', transcript: { kind: 'tail', maxBytes: 16 * 1024 } }, context,
      );
      assert.equal(opened.ok, true, JSON.stringify(opened));
      if (release) {
        const outcome = await coordinator.handlers['session.transcript.overlay.release'](
          { subscriptionId: opened.result.subscriptionId }, context,
        );
        assert.equal(outcome.ok, true);
      }
      connection.abort(opened.result.subscriptionId);
      await setImmediate();
    }
    try {
      for (let index = 0; index < 16; index++) await cycle(index % 2 === 0);
      for (let index = 0; index < 5; index++) { await setImmediate(); global.gc(); }
      assert.equal(generation, 16);
      assert.equal(buffers.length, 16, 'every open prepared an observed overlay');
      assert.equal(buffers.filter(ref => ref.deref()).length, 0,
        'closed subscriptions must not keep overlays until connection close');
    } finally {
      connection.close();
      coordinator.close();
    }
  `,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('closing a connection interrupts an active preparation and releases its capacity when it settles', async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let reads = 0;
  const coordinator = fixture(async () => {
    if (++reads === 1) {
      started.resolve();
      await finish.promise;
    }
    return [];
  });
  const connection = coordinator.attachConnection('interrupted', { async send() {} });
  try {
    const opening = open(coordinator, 'interrupted', 'first');
    await started.promise;
    connection.close();
    const interrupted = await opening;
    assert.equal(interrupted.ok, false);
    finish.resolve();
    coordinator.attachConnection('replacement', { async send() {} });
    assert.equal((await open(coordinator, 'replacement', 'second')).ok, true);
    assert.equal(reads, 2);
  } finally {
    finish.resolve();
    coordinator.close();
  }
});

test('failed overlay preparation allows another open on the same connection', async () => {
  let reads = 0;
  const coordinator = fixture(async () => {
    if (++reads === 1) throw new Error('injected preparation failure');
    return [];
  });
  coordinator.attachConnection('connection', { async send() {} });
  try {
    assert.equal((await open(coordinator, 'connection', 'session')).ok, false);
    assert.equal((await open(coordinator, 'connection', 'session')).ok, true);
    assert.equal(reads, 2);
  } finally {
    coordinator.close();
  }
});

test('one connection can wait for all 16 admitted transcript opens', async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let reads = 0;
  const coordinator = fixture(async () => {
    if (++reads === 1) {
      started.resolve();
      await finish.promise;
    }
    return [];
  });
  coordinator.attachConnection('connection', { async send() {} });
  try {
    const first = open(coordinator, 'connection', 'session-0');
    await started.promise;
    const remaining = Array.from({ length: 15 }, (_, index) =>
      open(coordinator, 'connection', `session-${index + 1}`),
    );
    await setImmediate();
    finish.resolve();
    const outcomes = await Promise.all([first, ...remaining]);
    assert.ok(outcomes.every((outcome) => outcome.ok));
    assert.equal(reads, 16);
  } finally {
    finish.resolve();
    coordinator.close();
  }
});

function fixture(readActiveOverlay: ReturnType<typeof transcriptReader>['readActiveOverlay']) {
  return new SessionContinuityCoordinator(
    'epoch',
    async (sessionId): Promise<CanonicalSessionProjection> => ({
      session: {
        sessionId,
        metadataRevision: 1,
        status: 'active',
        createdAt: 1,
        isArchived: false,
      },
      rootTurn: { sessionId, turnId: 'turn', runId: 'run', status: 'running' },
      goal: null,
      interactions: { pending: [] },
      queue: { hostEpoch: 'epoch', queueRevision: 0, steering: [], followup: [] },
    }),
    new SessionAdmissionGate(),
    undefined,
    { ...transcriptReader([]), readActiveOverlay },
  );
}

function open(coordinator: SessionContinuityCoordinator, connectionId: string, sessionId: string) {
  return coordinator.handlers['subscription.open'](
    { sessionId, transcript: { kind: 'tail', maxBytes: 16 * 1024 } },
    {
      hostEpoch: 'epoch',
      connectionId,
      principal: 'local_owner',
      principalKind: 'local_owner',
      acquireResidency: () => ({ release() {} }),
    },
  );
}
