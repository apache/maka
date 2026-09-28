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

import nodeAssert from 'node:assert/strict';
import { test as scenario } from 'node:test';
import type { RuntimeEvent as EventRecord } from '@maka/core/runtime-event';
import type { SessionHeader as HeaderRecord } from '@maka/core/session';
import type { HistoryCompactCheckpoint as Checkpoint } from '@maka/runtime/history-compact-checkpoint';
import type { BackendFactoryContext as FactoryContext } from '@maka/runtime/session-manager';
import { createDesktopE2eCheckpoint as checkpointFor } from '../test-only/desktop-e2e-checkpoint.js';
import { DesktopE2eBackend as DeterministicBackend } from '../test-only/desktop-e2e-backend.js';
const IDS = Object.freeze({ session: 'session-1', turn: 'turn-1', run: 'run-1' });
const eventFor = (text: string, id: string): EventRecord =>
  Object.freeze({
    id,
    invocationId: 'invocation-1',
    runId: IDS.run,
    sessionId: IDS.session,
    turnId: IDS.turn,
    ...Object.fromEntries([
      ['ts', 1],
      ['partial', false],
      ['role', 'user'],
      ['author', 'user'],
    ]),
    content: Object.freeze({ kind: 'text', text }),
  } as EventRecord);

const contextWith = (
  recorder?: (checkpoint: Checkpoint, turnId: string) => Promise<void>,
): FactoryContext =>
  ({
    ...Object.fromEntries([
      ['sessionId', IDS.session],
      ['workspaceRoot', '/tmp/workspace'],
      ['header', { model: 'fake-model' } as HeaderRecord],
      ['store', {} as FactoryContext['store']],
    ]),
    ...(recorder === undefined ? {} : { recordHistoryCompactCheckpoint: recorder }),
  }) as FactoryContext;

const compact = (backend: DeterministicBackend, events: EventRecord[]) =>
  backend.compactHistory({ turnId: IDS.turn, runId: IDS.run, runtimeContext: events });
const checkpointEnvelope = (checkpoint: Checkpoint) => {
  if (checkpoint.version !== 2) nodeAssert.fail('Desktop E2E checkpoints must be textual');
  return Object.freeze([
    checkpoint.version,
    checkpoint.summaryFormat,
    /^## Goal\nDeterministic Desktop E2E context checkpoint\./u.test(checkpoint.summary),
  ]);
};
const verifyMissingPersistencePort = async () => {
  const operation = compact(new DeterministicBackend(contextWith()), [
    eventFor('hello', 'event-1'),
  ]);
  await nodeAssert.rejects(operation, /requires a checkpoint recorder/);
};
scenario('compaction is unavailable without a persistence port', verifyMissingPersistencePort);
const persistsCheckpoint = async () => {
  const writes: Array<Readonly<{ checkpoint: Checkpoint; turnId: string }>> = [];
  const recorder = async (checkpoint: Checkpoint, turnId: string) => {
    writes.push(Object.freeze({ checkpoint, turnId }));
  };
  const backend = new DeterministicBackend(contextWith(recorder));
  const events = [eventFor('hello', 'event-1')];
  const result = await compact(backend, events);
  const persisted = writes.at(0);
  nodeAssert.ok(persisted);
  nodeAssert.equal(writes.length, 1);
  nodeAssert.equal(persisted.turnId, IDS.turn);
  nodeAssert.deepEqual(persisted.checkpoint, checkpointFor(IDS.session, events));
  nodeAssert.equal(result.outcome.kind, 'compacted');
  const returnedCheckpointId =
    result.outcome.kind === 'compacted' ? result.outcome.checkpointId : undefined;
  nodeAssert.equal(returnedCheckpointId, persisted.checkpoint.checkpointId);
};
scenario('the backend persists the checkpoint returned by the pure factory', persistsCheckpoint);
const preservesMetadataButChangesIdentity = () => {
  const checkpoints = [
    checkpointFor(IDS.session, [eventFor('first', 'event-1')]),
    checkpointFor(IDS.session, [eventFor('second', 'event-2')]),
  ];
  const envelopes = checkpoints.map(checkpointEnvelope);
  const observedMetadata = new Set(envelopes.map((envelope) => JSON.stringify(envelope)));
  const expectedMetadata = new Set([JSON.stringify([2, 'sections_v1', true])]);
  nodeAssert.deepEqual(observedMetadata, expectedMetadata);
  nodeAssert.equal(new Set(checkpoints.map(({ checkpointId }) => checkpointId)).size, 2);
};
const identityScenario =
  'checkpoint metadata is content-invariant while identity is content-sensitive';
scenario(identityScenario, preservesMetadataButChangesIdentity);
