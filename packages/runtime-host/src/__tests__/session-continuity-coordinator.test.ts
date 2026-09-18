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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { setImmediate as delayImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { SessionEvent, ShellRunUpdate } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  decodeHostFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  type SubscriptionFrame,
} from '../protocol/index.js';
import {
  decodeSubscriptionFrame,
  SESSION_LIVE_DELTA_MAX_BYTES,
} from '../protocol/session-continuity.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  type CanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { SessionContinuityFrameSink } from '../server/session-continuity-service.js';
import type { SessionTranscriptReader } from '../server/session-transcript-reader.js';
import { clientSubscription } from './fixtures/client-session-subscription.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';

const HOST_EPOCH = 'host-epoch';
const SESSION_ID = 'session-1';
const TEST_OWNER_IDENTITY = {
  principalId: 'local_owner',
  principalKind: 'local_owner',
} as const;
type TestIdentity =
  | typeof TEST_OWNER_IDENTITY
  | {
      readonly principalId: string;
      readonly principalKind: 'session_guest';
    };

test('open is an inactive publication barrier and live sequence starts at nextSequence', async () => {
  const read = deferred<CanonicalSessionProjection | null>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    () => read.promise,
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);

  const opening = coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID, transcript: { kind: 'none' } },
    connectionContext('connection-1'),
  );
  await delayImmediate();
  const publishing = coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  read.resolve(canonical());

  const outcome = await opening;
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  await publishing;
  assert.equal(outcome.result.nextSequence, 1);
  assert.equal(Object.isFrozen(outcome.result.snapshot), true);
  assert.equal(sink.frames.length, 0);

  connection.activate(outcome.result.subscriptionId);
  await delayImmediate();
  assert.deepEqual(
    sink.frames.map((frame) => ('sequence' in frame ? frame.sequence : undefined)),
    [1],
  );
  assert.equal(sink.frames[0]?.kind, 'subscription.session_delta');

  connection.abort(outcome.result.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  assert.equal(sink.frames.length, 1);
  coordinator.close();
});

test('Guest revocation wins a concurrent subscription open', async () => {
  const read = deferred<CanonicalSessionProjection | null>();
  const grant = {
    kind: 'session_observation' as const,
    grantId: 'grant-1',
    principalId: 'guest-1',
    sessionId: SESSION_ID,
    createdAt: '2026-08-30T00:00:00.000Z',
  };
  let active = true;
  let publishRevocation: ((revoked: typeof grant) => void) | undefined;
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    () => read.promise,
    new SessionAdmissionGate(),
    undefined,
    undefined,
    undefined,
    {
      activeSessionGrant: () => (active ? grant : undefined),
      subscribeGrantRevocations: (listener) => {
        publishRevocation = listener;
        return () => undefined;
      },
    },
  );
  attachTestConnection(coordinator, 'guest-connection', new RecordingSink());

  const opening = coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID, transcript: { kind: 'none' } },
    connectionContext('guest-connection', {
      principalId: 'guest-1',
      principalKind: 'session_guest',
    }),
  );
  await delayImmediate();
  active = false;
  publishRevocation?.(grant);
  read.resolve(canonical());

  assert.deepEqual(await opening, {
    ok: false,
    error: { code: 'not_found', message: 'Session was not found' },
  });
  coordinator.close();
});

test('forwards the durable steering echo to subscribers as a session event', async () => {
  const sink = new RecordingSink();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);
  await delayImmediate();
  sink.frames.length = 0;

  const steering = {
    type: 'steering_message' as const,
    id: 'steering-event-1',
    turnId: 'turn-1',
    ts: 7,
    messageId: 'steering-message-1',
    content: { text: 'steer the turn' },
  };
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', steering);

  assert.equal(sink.frames.length, 1);
  const frame = sink.frames[0];
  assert.equal(frame?.kind, 'subscription.session_event');
  if (frame?.kind !== 'subscription.session_event') return;
  assert.deepEqual(frame.event, steering);

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('projects model-only user content out of Guest queue and steering frames', async () => {
  const grant = {
    kind: 'session_observation' as const,
    grantId: 'grant-1',
    principalId: 'guest-1',
    sessionId: SESSION_ID,
    createdAt: '2026-08-30T00:00:00.000Z',
  };
  const sink = new RecordingSink();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () =>
      canonical({
        queue: {
          hostEpoch: HOST_EPOCH,
          queueRevision: 1,
          steering: [],
          followup: [
            {
              entryId: 'entry-1',
              messageId: 'message-1',
              content: { text: 'private skill body', displayText: 'visible prompt' },
              placement: 'next_turn',
              state: 'queued',
            },
          ],
        },
      }),
    new SessionAdmissionGate(),
    undefined,
    undefined,
    undefined,
    {
      activeSessionGrant: () => grant,
      subscribeGrantRevocations: () => () => undefined,
    },
  );
  const connection = attachTestConnection(coordinator, 'guest-connection', sink);
  const opened = await open(
    coordinator,
    'guest-connection',
    { kind: 'none' },
    {
      principalId: grant.principalId,
      principalKind: 'session_guest',
    },
  );
  assert.deepEqual(opened.snapshot.queue.followup[0]?.content, { text: 'visible prompt' });
  connection.activate(opened.subscriptionId);
  coordinator.enqueueAgentGraphChanged({
    rootSessionId: SESSION_ID,
    graphId: 'private-graph',
    reason: 'observation',
  });
  await delayImmediate();
  assert.equal(sink.frames.length, 0);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'steering_message',
    id: 'steering-event-1',
    turnId: 'turn-1',
    ts: 7,
    messageId: 'steering-message-1',
    content: { text: 'private skill body', displayText: 'visible steer' },
  });

  const frame = sink.frames.find((candidate) => candidate.kind === 'subscription.session_event');
  assert.equal(frame?.kind, 'subscription.session_event');
  if (frame?.kind === 'subscription.session_event') {
    assert.deepEqual(frame.event, {
      type: 'steering_message',
      id: 'steering-event-1',
      turnId: 'turn-1',
      ts: 7,
      messageId: 'steering-message-1',
      content: { text: 'visible steer' },
    });
  }
  coordinator.close();
});

test('open snapshot includes pending Interactions from the canonical projection', async () => {
  const pending = pendingInteraction();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical({ interactions: { pending: [pending] } }),
    new SessionAdmissionGate(),
  );
  const connection = attachTestConnection(coordinator, 'connection-1', new RecordingSink());

  const opened = await open(coordinator, 'connection-1');
  assert.deepEqual(opened.snapshot.interactions, { pending: [pending] });

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('open identifies every assistant stream that is still active and round-trips its result', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  attachTestConnection(coordinator, 'connection-1', new RecordingSink());
  await open(coordinator, 'connection-1');
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'message-2', 'reasoning'),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(2),
    messageId: 'message-3',
  });

  attachTestConnection(coordinator, 'connection-2', new RecordingSink());
  const active = await open(coordinator, 'connection-2');
  assert.deepEqual(active.activeAssistantStreams, [
    { kind: 'text', turnId: 'turn-1', messageId: 'message-1' },
    { kind: 'thinking', turnId: 'turn-1', messageId: 'message-2' },
    { kind: 'text', turnId: 'turn-1', messageId: 'message-3' },
  ]);

  const decoded = decodeHostFrame(
    JSON.parse(
      encodeProtocolMessage({
        requestId: 'open-round-trip',
        operation: 'subscription.open',
        ok: true,
        result: active,
      }).toString('utf8'),
    ),
  );
  assert.ok('ok' in decoded && decoded.ok);
  if (!('ok' in decoded) || !decoded.ok || decoded.operation !== 'subscription.open') return;
  assert.deepEqual(decoded.result.activeAssistantStreams, active.activeAssistantStreams);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', 'chunk-1'),
  );
  attachTestConnection(coordinator, 'connection-3', new RecordingSink());
  const remaining = await open(coordinator, 'connection-3');
  assert.deepEqual(remaining.activeAssistantStreams, [
    { kind: 'thinking', turnId: 'turn-1', messageId: 'message-2' },
    { kind: 'text', turnId: 'turn-1', messageId: 'message-3' },
  ]);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'message-2', 'reasoning'),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textCompleteEvent('message-2', ''));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-3', 'chunk-2'),
  );
  attachTestConnection(coordinator, 'connection-4', new RecordingSink());
  const completed = await open(coordinator, 'connection-4');
  assert.deepEqual(completed.activeAssistantStreams, []);
  coordinator.close();
});

test('publishes a non-prefix final value as an authoritative replacement', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(1),
    text: 'draft',
  });
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textCompleteEvent('message-1', 'final'),
    interrupted: true,
  });
  await waitFor(() => sink.frames.length === 3);
  const interrupted = decodeSubscriptionFrame(
    JSON.parse(encodeProtocolMessage(sink.frames[2]!).toString('utf8')),
  );
  assert.ok(
    interrupted.kind === 'subscription.session_delta' && interrupted.delta.interrupted === true,
  );

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? {
            startOffset: frame.delta.startOffset,
            text: frame.delta.text,
            reset: frame.delta.reset === true,
            complete: frame.delta.complete === true,
          }
        : frame.kind,
    ),
    [
      { startOffset: 0, text: 'draft', reset: false, complete: false },
      { startOffset: 0, text: 'final', reset: true, complete: false },
      { startOffset: 5, text: '', reset: false, complete: true },
    ],
  );
  coordinator.close();
});

test('coalesces reasoning parts and completes the step before later steps continue', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-1', 'first'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-1', 'second'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'step-1', 'first'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'step-1', 'second'),
  );
  assert.equal(sink.frames.length, 2);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textCompleteEvent('step-1', ''));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-2', 'second'),
  );
  await waitFor(() => sink.frames.length === 4);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? {
            messageId: frame.delta.messageId,
            text: frame.delta.text,
            complete: frame.delta.complete === true,
          }
        : frame.kind,
    ),
    [
      { messageId: 'step-1', text: 'first', complete: false },
      { messageId: 'step-1', text: 'second', complete: false },
      { messageId: 'step-1', text: '', complete: true },
      { messageId: 'step-2', text: 'second', complete: false },
    ],
  );
  coordinator.close();
});

test('terminal fence suppresses ordinary refresh until the exact terminal cut publishes', async () => {
  let projection = canonical({
    rootTurn: { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' },
  });
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.holdTerminalPublication(SESSION_ID, 'turn-1', 'run-1');
  projection = canonical({
    rootTurn: {
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      terminalEventId: 'event-terminal',
    },
  });
  await coordinator.refreshCanonical(SESSION_ID);
  assert.equal(sink.frames.length, 0);

  await coordinator.publishTerminalProjection(SESSION_ID, 'turn-1', 'run-1');
  await delayImmediate();
  assert.equal(sink.frames.length, 1);
  const frame = sink.frames[0];
  assert.equal(frame?.kind, 'subscription.session_projection');
  if (frame?.kind === 'subscription.session_projection') {
    assert.equal(frame.sequence, 1);
    assert.equal(frame.snapshot.projectionRevision, 2);
    assert.equal(frame.snapshot.rootTurn?.status, 'completed');
  }
  coordinator.close();
});

test('detached canonical refreshes coalesce before Store I/O', async () => {
  let projection = canonical();
  let reads = 0;
  const refreshRead = deferred<void>();
  const refreshEntered = deferred<void>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 2) {
        refreshEntered.resolve();
        await refreshRead.promise;
      }
      return projection;
    },
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  projection = canonical({ metadataRevision: 2 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await refreshEntered.promise;
  assert.equal(reads, 2);
  refreshRead.resolve();
  await waitFor(() => sink.frames.length === 1);
  assert.equal(reads, 2);
  coordinator.close();
});

test('in-flight canonical refresh observes an invalidation after its first read', async () => {
  let projection = canonical();
  let reads = 0;
  const firstRefreshRead = deferred<CanonicalSessionProjection | null>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 2) return firstRefreshRead.promise;
      return projection;
    },
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await waitFor(() => reads === 2);
  firstRefreshRead.resolve(canonical({ metadataRevision: 2 }));
  projection = canonical({ metadataRevision: 3 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);

  await waitFor(() => reads === 3 && sink.frames.length === 2);
  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_projection'
        ? frame.snapshot.session.metadataRevision
        : undefined,
    ),
    [2, 3],
  );
  coordinator.close();
});

test('reports a detached canonical publication failure to the Host lifecycle', async () => {
  let reads = 0;
  const observed = deferred<unknown>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 1) return canonical();
      throw new Error('canonical Store read failed');
    },
    new SessionAdmissionGate(),
    (error) => observed.resolve(error),
  );
  const connection = attachTestConnection(coordinator, 'connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  const failure = await observed.promise;
  assert.match(String(failure), /canonical Store read failed/);
  coordinator.close();
});

test('rejects a live event that is not owned by the canonical root', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const connection = attachTestConnection(coordinator, 'connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await assert.rejects(
    coordinator.acceptRuntimeEvent(SESSION_ID, 'different-run', textEvent(1)),
    /canonical active root Turn/,
  );
  coordinator.close();
});

test('coalesces Agent graph invalidations onto the Session subscription sequence', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueAgentGraphChanged({
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'observation',
  });
  coordinator.enqueueAgentGraphChanged({
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'stopped',
  });
  await waitFor(() => sink.frames.length === 1);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await waitFor(() => sink.frames.length === 2);

  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.agent_graph_changed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'stopped',
  });
  assert.equal(sink.frames[1]?.kind, 'subscription.session_delta');
  assert.equal(sink.frames[1]?.sequence, 2);
  coordinator.close();
});

test('coalesces typed domain invalidations without publishing continuity projections', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'todo');
  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'todo');
  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'plan');
  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'usage');
  await waitFor(() => sink.frames.length === 3);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_domain_changed'
        ? { kind: frame.kind, sequence: frame.sequence, domain: frame.domain }
        : frame.kind,
    ),
    [
      { kind: 'subscription.session_domain_changed', sequence: 1, domain: 'todo' },
      { kind: 'subscription.session_domain_changed', sequence: 2, domain: 'plan' },
      { kind: 'subscription.session_domain_changed', sequence: 3, domain: 'usage' },
    ],
  );
  coordinator.close();
});

test('fans one bounded Runtime Resource burst out to an inherited Session view', async () => {
  const childSessionId = 'child-session';
  const grant = {
    kind: 'session_observation' as const,
    grantId: 'grant-1',
    principalId: 'guest-1',
    sessionId: childSessionId,
    createdAt: '2026-08-30T00:00:00.000Z',
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    undefined,
    undefined,
    {
      activeSessionGrant: () => grant,
      subscribeGrantRevocations: () => () => undefined,
    },
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const outcome = await coordinator.handlers['subscription.open'](
    { sessionId: childSessionId, transcript: { kind: 'none' } },
    connectionContext('connection-1'),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  connection.activate(outcome.result.subscriptionId);
  const guestSink = new RecordingSink();
  const guestConnection = attachTestConnection(coordinator, 'guest-connection', guestSink);
  const guestOutcome = await coordinator.handlers['subscription.open'](
    { sessionId: childSessionId, transcript: { kind: 'none' } },
    connectionContext('guest-connection', {
      principalId: grant.principalId,
      principalKind: 'session_guest',
    }),
  );
  assert.equal(guestOutcome.ok, true);
  if (!guestOutcome.ok) return;
  guestConnection.activate(guestOutcome.result.subscriptionId);
  const updates = Array.from({ length: 64 }, (_, index) => {
    const update = shellRunUpdate({
      sessionId: 'parent-session',
      sourceToolCallId: `tool-${index}`,
    });
    update.result.ref = `shell:run-${index}`;
    return update;
  });
  updates[updates.length - 1]!.sessionId = childSessionId;

  for (const update of updates) coordinator.enqueueRuntimeResourceChanged(update);
  await waitFor(() => sink.frames.length === 1);

  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.session_domain_changed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: outcome.result.subscriptionId,
    sequence: 1,
    sessionId: childSessionId,
    domain: 'runtime_resource',
    resources: updates.map((update) => ({
      sourceSessionId: update.sessionId,
      ref: update.result.ref,
    })),
  });
  assert.deepEqual(guestSink.frames[0], {
    kind: 'subscription.session_domain_changed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: guestOutcome.result.subscriptionId,
    sequence: 1,
    sessionId: childSessionId,
    domain: 'runtime_resource',
    resources: [
      {
        sourceSessionId: childSessionId,
        ref: updates[updates.length - 1]!.result.ref,
      },
    ],
  });
  coordinator.close();
});

test('publishes live PTY bytes independently of the Session continuity sequence', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.enqueueRuntimeResourcePtyData({
    sessionId: SESSION_ID,
    ref: 'maka://runtime/background-tasks/shell-1',
    sequence: 4,
    data: 'hidden',
  });
  assert.equal(sink.frames.length, 0, 'hidden terminal must not consume network output');
  const interest = {
    subscriptionId: opened.subscriptionId,
    refs: ['maka://runtime/background-tasks/shell-1'],
  };
  assert.equal(
    (
      await coordinator.handlers['subscription.pty_interest.set'](
        interest,
        connectionContext('other-connection'),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await coordinator.handlers['subscription.pty_interest.set'](
        interest,
        connectionContext('connection-1'),
      )
    ).ok,
    true,
  );

  await coordinator.enqueueRuntimeResourcePtyData({
    sessionId: SESSION_ID,
    ref: 'maka://runtime/background-tasks/shell-1',
    sequence: 5,
    data: 'ready',
  });
  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.runtime_resource_pty_data',
    hostEpoch: HOST_EPOCH,
    subscriptionId: opened.subscriptionId,
    sessionId: SESSION_ID,
    ref: 'maka://runtime/background-tasks/shell-1',
    ptySequence: 5,
    data: 'ready',
  });
  await coordinator.handlers['subscription.pty_interest.set'](
    { ...interest, refs: [] },
    connectionContext('connection-1'),
  );
  await coordinator.enqueueRuntimeResourcePtyData({
    sessionId: SESSION_ID,
    ref: interest.refs[0]!,
    sequence: 6,
    data: 'hidden again',
  });
  assert.equal(sink.frames.length, 1);
  coordinator.close();
});

test('PTY overflow is bounded and requests terminal-only recovery while Session state progresses', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const blocked = deferred<void>();
  const frames: SubscriptionFrame[] = [];
  const connection = attachTestConnection(coordinator, 'connection-1', {
    async send(frame) {
      frames.push(frame);
      if (frame.kind === 'subscription.runtime_resource_pty_data' && frames.length === 1)
        await blocked.promise;
    },
  });
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);
  await coordinator.handlers['subscription.pty_interest.set'](
    { subscriptionId: opened.subscriptionId, refs: ['maka://runtime/background-tasks/shell-1'] },
    connectionContext('connection-1'),
  );
  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    await coordinator.enqueueRuntimeResourcePtyData({
      sessionId: SESSION_ID,
      ref: 'maka://runtime/background-tasks/shell-1',
      sequence,
      data: 'x'.repeat(4096),
    });
  }
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.kind, 'subscription.session_delta');
  if (frames[1]?.kind === 'subscription.session_delta') assert.equal(frames[1].sequence, 1);
  blocked.resolve();
  await delayImmediate();
  assert.ok(
    frames.some((frame) => frame.kind === 'subscription.runtime_resource_pty_data' && frame.reset),
  );
  assert.ok(frames.length <= 10, 'retained PTY backlog exceeded its frame budget');
  assert.ok(frames.every((frame) => frame.kind !== 'subscription.closed'));
  coordinator.close();
});

test('slow subscriber receives a terminal eviction without delaying another subscriber', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const slowSink = new RecordingSink();
  const fastSink = new RecordingSink();
  const slowConnection = attachTestConnection(coordinator, 'connection-slow', slowSink);
  const fastConnection = attachTestConnection(coordinator, 'connection-fast', fastSink);
  const slow = await open(coordinator, 'connection-slow');
  const fast = await open(coordinator, 'connection-fast');
  fastConnection.activate(fast.subscriptionId);

  // Alternate streams so queued deltas cannot coalesce: this exercises the
  // eviction path for a genuinely undrainable backlog.
  for (let index = 1; index <= 32; index += 1) {
    await coordinator.acceptRuntimeEvent(
      SESSION_ID,
      'run-1',
      textEvent(index, `message-${index % 2}`),
    );
  }
  slowConnection.activate(slow.subscriptionId);
  await waitFor(() => slowSink.frames.length === 1 && fastSink.frames.length === 32);

  assert.deepEqual(slowSink.frames[0], {
    kind: 'subscription.closed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: slow.subscriptionId,
    sequence: 1,
    reason: 'slow_consumer',
  });
  assert.deepEqual(
    fastSink.frames.map((frame) => ('sequence' in frame ? frame.sequence : undefined)),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  coordinator.close();
});

test('coalesces queued assistant deltas instead of evicting a slow subscriber', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const slowSink = new RecordingSink();
  const fastSink = new RecordingSink();
  const slowConnection = attachTestConnection(coordinator, 'connection-slow', slowSink);
  const fastConnection = attachTestConnection(coordinator, 'connection-fast', fastSink);
  const slow = await open(coordinator, 'connection-slow');
  const fast = await open(coordinator, 'connection-fast');
  fastConnection.activate(fast.subscriptionId);

  // A same-stream delta flood that used to overflow the 32-frame budget and
  // evict the subscriber before it ever activated.
  for (let index = 1; index <= 64; index += 1) {
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(index));
  }
  slowConnection.activate(slow.subscriptionId);
  await waitFor(() => slowSink.frames.length === 1 && fastSink.frames.length === 64);

  // The lagging subscriber receives one merged, content-identical delta: no
  // eviction, absolute offsets preserved, no sequence spent on absorbed
  // frames.
  const merged = slowSink.frames[0];
  assert.equal(merged?.kind, 'subscription.session_delta');
  if (merged?.kind !== 'subscription.session_delta') return;
  assert.equal(merged.sequence, 1);
  assert.equal(merged.delta.startOffset, 0);
  assert.equal(
    merged.delta.text,
    Array.from({ length: 64 }, (_, index) => `chunk-${index + 1}`).join(''),
  );

  // The next enqueue continues the sequence exactly where the merged frame
  // left it, and the absolute offset continues the stream.
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(65));
  await waitFor(() => slowSink.frames.length === 2);
  const next = slowSink.frames[1];
  assert.equal(next?.kind, 'subscription.session_delta');
  if (next?.kind !== 'subscription.session_delta') return;
  assert.equal(next.sequence, 2);
  assert.equal(next.delta.startOffset, merged.delta.text.length);
  assert.equal(next.delta.text, 'chunk-65');
  coordinator.close();
});

test('keeps stream, kind, and completion boundaries when coalescing deltas', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1, 'message-1'));
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2, 'message-1'));
  // A thinking delta on the same message is a different delta kind: no merge.
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'thinking-1', 'think'),
  );
  // A different message stream: no merge.
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(3, 'message-2'));
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(4, 'message-2'));
  // Completion closes the stream and must land as its own frame.
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', 'chunk-1chunk-2'),
  );

  connection.activate(opened.subscriptionId);
  await waitFor(() => sink.frames.length === 4);
  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? {
            sequence: frame.sequence,
            kind: frame.delta.kind,
            messageId: frame.delta.messageId,
            text: frame.delta.text,
            complete: frame.delta.complete === true,
          }
        : frame.kind,
    ),
    [
      {
        sequence: 1,
        kind: 'text',
        messageId: 'message-1',
        text: 'chunk-1chunk-2',
        complete: false,
      },
      { sequence: 2, kind: 'thinking', messageId: 'thinking-1', text: 'think', complete: false },
      {
        sequence: 3,
        kind: 'text',
        messageId: 'message-2',
        text: 'chunk-3chunk-4',
        complete: false,
      },
      { sequence: 4, kind: 'text', messageId: 'message-1', text: '', complete: true },
    ],
  );
  coordinator.close();
});

test('keeps coalesced deltas within the protocol text and frame limits', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');

  // Each delta is individually protocol-valid, but merging the two would
  // push the text past SESSION_LIVE_DELTA_MAX_BYTES: the second must stay
  // its own frame so the receiver-side decoder does not reject it.
  const firstText = 'a'.repeat(SESSION_LIVE_DELTA_MAX_BYTES - 1024);
  const secondText = 'b'.repeat(SESSION_LIVE_DELTA_MAX_BYTES - 1024);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(1), text: firstText });
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(2), text: secondText });
  // A small continuation still merges into the new tail.
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(3));

  connection.activate(opened.subscriptionId);
  await waitFor(() => sink.frames.length === 2);

  const first = sink.frames[0];
  assert.equal(first?.kind, 'subscription.session_delta');
  if (first?.kind !== 'subscription.session_delta') return;
  assert.equal(first.sequence, 1);
  assert.equal(first.delta.startOffset, 0);
  assert.equal(first.delta.text, firstText);

  const second = sink.frames[1];
  assert.equal(second?.kind, 'subscription.session_delta');
  if (second?.kind !== 'subscription.session_delta') return;
  assert.equal(second.sequence, 2);
  assert.equal(second.delta.startOffset, firstText.length);
  assert.equal(second.delta.text, secondText + 'chunk-3');

  // Every emitted frame passes the receiver-side decoder, including its
  // 16 KiB delta-text and 64 KiB frame limits.
  for (const frame of sink.frames) decodeSubscriptionFrame(frame);
  coordinator.close();
});

test('removal closes every Session subscriber at the admitted sequence boundary', async () => {
  const admission = new SessionAdmissionGate();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    admission,
  );
  const desktopSink = new RecordingSink();
  const tuiSink = new RecordingSink();
  const desktop = attachTestConnection(coordinator, 'connection-desktop', desktopSink);
  const tui = attachTestConnection(coordinator, 'connection-tui', tuiSink);
  const desktopSubscription = await open(coordinator, 'connection-desktop');
  const tuiSubscription = await open(coordinator, 'connection-tui');
  desktop.activate(desktopSubscription.subscriptionId);
  tui.activate(tuiSubscription.subscriptionId);

  await admission.run(SESSION_ID, (lease) => coordinator.retireSessions([SESSION_ID], lease));
  await waitFor(() => desktopSink.frames.length === 1 && tuiSink.frames.length === 1);

  assert.deepEqual(desktopSink.frames, [
    {
      kind: 'subscription.closed',
      hostEpoch: HOST_EPOCH,
      subscriptionId: desktopSubscription.subscriptionId,
      sequence: 1,
      reason: 'session_removed',
    },
  ]);
  assert.deepEqual(tuiSink.frames, [
    {
      kind: 'subscription.closed',
      hostEpoch: HOST_EPOCH,
      subscriptionId: tuiSubscription.subscriptionId,
      sequence: 1,
      reason: 'session_removed',
    },
  ]);
  coordinator.close();
});

test('open returns a bounded immutable durable tail', async () => {
  const durable: StoredMessage[] = [assistantMessage('durable')];
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader(durable),
  );
  const connection = attachTestConnection(coordinator, 'connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  connection.activate(opened.subscriptionId);
  assert.ok(opened.transcript);
  if (!opened.transcript) return;
  const client = clientSubscription(
    opened,
    async () => undefined,
    async () => {
      throw new Error('bounded bootstrap unexpectedly required continuation');
    },
  );
  durable[0] = assistantMessage('mutated after open');
  assert.deepEqual(await client.loadTranscript((value) => value), [assistantMessage('durable')]);
  coordinator.close();
});

test('reports a durable bootstrap read failure as unavailable persistence', async () => {
  const reader: SessionTranscriptReader = {
    ...transcriptReader([]),
    readDurableHighWater: async () => 0,
    readDurablePage: async () => {
      throw new Error('injected durable bootstrap failure');
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  attachTestConnection(coordinator, 'connection-failed-bootstrap', new RecordingSink());
  const outcome = await coordinator.handlers['subscription.open'](
    {
      sessionId: SESSION_ID,
      transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
    },
    connectionContext('connection-failed-bootstrap'),
  );
  assert.deepEqual(outcome, {
    ok: false,
    error: { code: 'persistence_failed', message: 'Session transcript is unavailable' },
  });
  coordinator.close();
});

test('rejects a subscription open whose connection closes during transcript bootstrap', async () => {
  const durable = [assistantMessage('durable')];
  const baseReader = transcriptReader(durable);
  const pageStarted = deferred<void>();
  const continuePage = deferred<void>();
  let delayFirstPage = true;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurablePage: async (...args) => {
      if (delayFirstPage) {
        delayFirstPage = false;
        pageStarted.resolve();
        await continuePage.promise;
      }
      return baseReader.readDurablePage(...args);
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  const interrupted = attachTestConnection(
    coordinator,
    'connection-interrupted',
    new RecordingSink(),
  );
  const opening = coordinator.handlers['subscription.open'](
    {
      sessionId: 'session-interrupted',
      transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
    },
    connectionContext('connection-interrupted'),
  );
  await pageStarted.promise;
  interrupted.close();
  continuePage.resolve();
  await assert.rejects(opening, /connection closed during subscription open/);
  coordinator.close();
});

test('fits a transcript bootstrap inside a near-limit subscription open response', async () => {
  const durable = Array.from({ length: 300 }, (_, index) => ({
    type: 'system_note' as const,
    id: `message-${index}`,
    ts: index + 1,
    kind: 'session_start' as const,
  }));
  const projection = canonical({
    queue: {
      hostEpoch: HOST_EPOCH,
      queueRevision: 1,
      steering: [],
      followup: [
        {
          entryId: 'entry-1',
          messageId: 'queued-message-1',
          content: {
            text: 'q'.repeat(48 * 1024),
            quotes: [{ text: 'r'.repeat(2 * 1024), label: 'Assistant' }],
          },
          placement: 'next_turn',
          state: 'queued',
        },
      ],
    },
  });
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    new SessionAdmissionGate(),
    undefined,
    transcriptReader(durable),
  );
  attachTestConnection(coordinator, 'connection-open-budget', new RecordingSink());
  const opened = await open(coordinator, 'connection-open-budget', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.ok(opened.transcript);
  const encoded = encodeProtocolMessage({
    requestId: 'request-1',
    operation: 'subscription.open',
    ok: true,
    result: opened,
  });
  assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES);
  coordinator.close();
});

test('a running Turn row committed after open reaches the subscriber as transcript progress', async () => {
  const prompt: StoredMessage = {
    type: 'user',
    id: 'user-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'hello',
  };
  const durable: StoredMessage[] = [prompt];
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader(durable),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-running-row', sink);
  const opened = await open(coordinator, 'connection-running-row', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  connection.activate(opened.subscriptionId);
  assert.equal(opened.snapshot.rootTurn?.status, 'running');
  assert.equal(opened.transcript?.durable.throughSequence, 0);

  durable.push(assistantMessage('first step'));
  coordinator.enqueueTranscriptAdvanced(SESSION_ID);
  await waitFor(() => sink.frames.length === 1);

  const frame = sink.frames[0];
  assert.equal(frame?.kind, 'subscription.transcript_advanced');
  if (frame?.kind !== 'subscription.transcript_advanced') return;
  assert.equal(frame.throughSequence, 1);
  const page = await coordinator.handlers['session.transcript.page'](
    {
      subscriptionId: opened.subscriptionId,
      direction: 'newer',
      throughSequence: frame.throughSequence,
      cursor: null,
      anchorSequence: 0,
      maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
    },
    connectionContext('connection-running-row'),
  );
  assert.ok(page.ok);
  if (!page.ok) return;
  assert.deepEqual(
    page.result.fragments.map((fragment) =>
      JSON.parse(Buffer.from(fragment.data, 'base64').toString('utf8')),
    ),
    [assistantMessage('first step')],
  );
  coordinator.close();
});

test('opening mid-stream pays out the streamed prefix before live deltas without a gap', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  let streamed = '';
  for (let index = 0; index < 24; index += 1) {
    const text = `${index}:${'x'.repeat(8 * 1024)}`;
    streamed += text;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(index), text });
  }
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-mid-stream', sink);
  const opened = await open(coordinator, 'connection-mid-stream');
  assert.deepEqual(opened.activeAssistantStreams, [
    { kind: 'text', turnId: 'turn-1', messageId: 'message-1' },
  ]);
  connection.activate(opened.subscriptionId);
  for (const text of ['live-1', 'live-2']) {
    streamed += text;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(99), text });
  }
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', streamed),
  );
  await waitFor(() =>
    sink.frames.some(
      (frame) => frame.kind === 'subscription.session_delta' && frame.delta.complete,
    ),
  );

  let received = '';
  for (const [index, frame] of sink.frames.entries()) {
    assert.equal(frame.kind, 'subscription.session_delta');
    if (frame.kind !== 'subscription.session_delta') return;
    assert.equal(frame.sequence, opened.nextSequence + index);
    decodeSubscriptionFrame(JSON.parse(encodeProtocolMessage(frame).toString('utf8')));
    assert.equal(frame.delta.reset, undefined);
    assert.equal(frame.delta.startOffset, received.length);
    received += frame.delta.text;
    if (frame.delta.complete) assert.equal(frame, sink.frames.at(-1));
  }
  assert.equal(received, streamed);
  coordinator.close();
});

// #5365: the in-flight answer a mid-stream subscriber has not seen is as large
// as the answer. Delivering it as soon as the open result flushed handed it to
// a Client that was still assembling the state those frames apply to, whose
// preparation buffer is sized for live traffic, not for a whole answer.
test('holds every frame, including the in-flight answer, until the subscriber declares readiness', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  let streamed = '';
  for (let index = 0; index < 24; index += 1) {
    const text = `${index}:${'x'.repeat(8 * 1024)}`;
    streamed += text;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(index), text });
  }
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-unready', sink);
  const opened = await open(coordinator, 'connection-unready');
  streamed += 'live-1';
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(99), text: 'live-1' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sink.frames.length, 0);

  connection.activate(opened.subscriptionId);
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', streamed),
  );
  await waitFor(() =>
    sink.frames.some(
      (frame) => frame.kind === 'subscription.session_delta' && frame.delta.complete,
    ),
  );
  let received = '';
  for (const frame of sink.frames) {
    assert.equal(frame.kind, 'subscription.session_delta');
    if (frame.kind !== 'subscription.session_delta') return;
    received += frame.delta.text;
  }
  assert.equal(received, streamed);
  coordinator.close();
});

// #5365: a subscriber has one delivery order. A message that needs no catch-up
// used to be delivered and completed while an earlier message was still being
// paid out, so the answers arrived in the opposite order to the one the Host
// produced and a reader picking "the last answer" picked the earlier one.
test('a later message cannot complete ahead of the prefix a subscriber is still being paid', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  let first = '';
  for (let index = 0; index < 24; index += 1) {
    const text = `${index}:${'x'.repeat(8 * 1024)}`;
    first += text;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(index), text });
  }
  const sink = new GatedSink();
  const connection = attachTestConnection(coordinator, 'connection-order', sink);
  const opened = await open(coordinator, 'connection-order');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textCompleteEvent('message-1', first));
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(0, 'message-2'),
    text: 'FINAL ANSWER',
  });
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textCompleteEvent('message-2', 'FINAL ANSWER'),
    messageId: 'message-2',
  });
  sink.release();
  await waitFor(() => completionOrder(sink).length === 2);

  assert.deepEqual(completionOrder(sink), ['message-1', 'message-2']);
  coordinator.close();
});

// #5365: the Turn ending does not unsay what the Host already streamed. The
// terminal publication used to drop every unpaid backlog, so a subscriber was
// left holding a truncated answer that the client then reported as complete.
test('a terminal publication finishes the prefix it found unpaid instead of dropping it', async () => {
  let projection = canonical({
    rootTurn: { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' },
  });
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    new SessionAdmissionGate(),
  );
  let streamed = '';
  for (let index = 0; index < 24; index += 1) {
    const text = `${index}:${'x'.repeat(8 * 1024)}`;
    streamed += text;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(index), text });
  }
  const sink = new GatedSink();
  const connection = attachTestConnection(coordinator, 'connection-terminal', sink);
  const opened = await open(coordinator, 'connection-terminal');
  connection.activate(opened.subscriptionId);
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', streamed),
  );

  await coordinator.holdTerminalPublication(SESSION_ID, 'turn-1', 'run-1');
  projection = canonical({
    rootTurn: {
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      terminalEventId: 'event-terminal',
    },
  });
  await coordinator.publishTerminalProjection(SESSION_ID, 'turn-1', 'run-1');
  sink.release();
  await waitFor(() => completionOrder(sink).length === 1);

  let received = '';
  for (const frame of sink.frames) {
    if (frame.kind !== 'subscription.session_delta') continue;
    assert.equal(frame.delta.startOffset, received.length);
    received += frame.delta.text;
  }
  assert.equal(received, streamed);
  coordinator.close();
});

test('a stream completing before a mid-stream subscriber catches up is still paid out in full', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  let streamed = '';
  for (let index = 0; index < 48; index += 1) {
    const text = `${index}:${'x'.repeat(8 * 1024)}`;
    streamed += text;
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', { ...textEvent(index), text });
  }
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-late-complete', sink);
  const opened = await open(coordinator, 'connection-late-complete');
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', streamed),
  );
  connection.activate(opened.subscriptionId);
  await waitFor(() =>
    sink.frames.some(
      (frame) =>
        frame.kind === 'subscription.closed' ||
        (frame.kind === 'subscription.session_delta' && frame.delta.complete),
    ),
  );

  let received = '';
  for (const frame of sink.frames) {
    assert.equal(frame.kind, 'subscription.session_delta');
    if (frame.kind !== 'subscription.session_delta') return;
    assert.equal(frame.delta.startOffset, received.length);
    received += frame.delta.text;
  }
  assert.equal(received, streamed);
  coordinator.close();
});

test('commit-driven transcript progress waits for a fenced terminal publication', async () => {
  let projection = canonical();
  const durable: StoredMessage[] = [assistantMessage('first')];
  const reader = transcriptReader(durable);
  let highWaterReads = 0;
  const admission = new SessionAdmissionGate();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    admission,
    undefined,
    {
      ...reader,
      readDurableHighWater: async (sessionId) => {
        highWaterReads += 1;
        return reader.readDurableHighWater(sessionId);
      },
    },
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-fenced', sink);
  const opened = await open(coordinator, 'connection-fenced', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  connection.activate(opened.subscriptionId);
  await coordinator.holdTerminalPublication(SESSION_ID, 'turn-1', 'run-1');
  const readsBeforeCommit = highWaterReads;

  durable.push({
    type: 'turn_state',
    id: 'state-1',
    turnId: 'turn-1',
    ts: 2,
    status: 'completed',
  });
  coordinator.enqueueTranscriptAdvanced(SESSION_ID);
  await admission.run(SESSION_ID, async () => undefined);
  await delayImmediate();
  assert.equal(highWaterReads, readsBeforeCommit);
  assert.equal(sink.frames.length, 0);

  projection = canonical({
    rootTurn: {
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      terminalEventId: 'event-terminal',
    },
  });
  await coordinator.publishTerminalProjection(SESSION_ID, 'turn-1', 'run-1');
  await waitFor(() => sink.frames.length === 2);
  assert.deepEqual(
    sink.frames.map((frame) => frame.kind),
    ['subscription.transcript_advanced', 'subscription.session_projection'],
  );
  coordinator.close();
});

test('large transcript messages are paged and cursors remain subscription-owned', async () => {
  const message = assistantMessage('界'.repeat(20_000));
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    transcriptReader([message]),
  );
  const owner = attachTestConnection(coordinator, 'connection-owner', new RecordingSink());
  const sibling = attachTestConnection(coordinator, 'connection-sibling', new RecordingSink());
  const opened = await open(coordinator, 'connection-owner', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  assert.ok(opened.transcript?.durable.nextCursor);
  if (!opened.transcript?.durable.nextCursor) return;
  const firstCursor = opened.transcript.durable.nextCursor;
  const client = clientSubscription(
    opened,
    async () => undefined,
    async (input) => {
      const next = await coordinator.handlers['session.transcript.page'](
        input,
        connectionContext('connection-owner'),
      );
      if (!next.ok) throw new Error(next.error.message);
      return next.result;
    },
  );
  assert.deepEqual(await client.loadTranscript((value) => value), [message]);

  const foreign = await coordinator.handlers['session.transcript.page'](
    {
      subscriptionId: opened.subscriptionId,
      direction: 'older',
      throughSequence: opened.transcript.durable.throughSequence,
      cursor: firstCursor,
      anchorSequence: null,
      maxBytes: 1024,
    },
    connectionContext('connection-sibling'),
  );
  assert.deepEqual(foreign, {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  });
  owner.close();
  sibling.close();
  coordinator.close();
});

test('an in-flight transcript page cannot outlive its owning connection', async () => {
  const message = assistantMessage('界'.repeat(20_000));
  const continued = deferred<void>();
  const baseReader = transcriptReader([message]);
  let reads = 0;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurablePage: async (sessionId, request) => {
      reads += 1;
      if (reads > 1) await continued.promise;
      return baseReader.readDurablePage(sessionId, request);
    },
  };
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  const connection = attachTestConnection(coordinator, 'connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  const cursor = opened.transcript?.durable.nextCursor;
  assert.ok(cursor);
  if (!opened.transcript || !cursor) return;
  const reading = coordinator.handlers['session.transcript.page'](
    {
      subscriptionId: opened.subscriptionId,
      direction: 'older',
      throughSequence: opened.transcript.durable.throughSequence,
      cursor,
      anchorSequence: null,
      maxBytes: 1024,
    },
    connectionContext('connection-1'),
  );
  await delayImmediate();
  connection.close();
  continued.resolve();
  assert.deepEqual(await reading, {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  });
  coordinator.close();
});

test('an in-flight transcript page cannot outlive its Guest observation grant', async () => {
  const message = assistantMessage('界'.repeat(20_000));
  const continued = deferred<void>();
  const baseReader = transcriptReader([message]);
  let blockPage = false;
  const reader: SessionTranscriptReader = {
    ...baseReader,
    readDurablePage: async (sessionId, request, project) => {
      if (blockPage) await continued.promise;
      return baseReader.readDurablePage(sessionId, request, project);
    },
  };
  const grant = {
    kind: 'session_observation' as const,
    grantId: 'grant-1',
    principalId: 'guest-1',
    sessionId: SESSION_ID,
    createdAt: '2026-08-30T00:00:00.000Z',
  };
  let active = true;
  let publishRevocation: ((revoked: typeof grant) => void) | undefined;
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
    undefined,
    {
      activeSessionGrant: () => (active ? grant : undefined),
      subscribeGrantRevocations: (listener) => {
        publishRevocation = listener;
        return () => undefined;
      },
    },
  );
  attachTestConnection(coordinator, 'guest-connection', new RecordingSink());
  const opened = await open(
    coordinator,
    'guest-connection',
    {
      kind: 'tail',
      maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
    },
    {
      principalId: grant.principalId,
      principalKind: 'session_guest',
    },
  );
  const cursor = opened.transcript?.durable.nextCursor;
  assert.ok(cursor);
  if (!opened.transcript || !cursor) return;

  blockPage = true;
  const reading = coordinator.handlers['session.transcript.page'](
    {
      subscriptionId: opened.subscriptionId,
      direction: 'older',
      throughSequence: opened.transcript.durable.throughSequence,
      cursor,
      anchorSequence: null,
      maxBytes: 1024,
    },
    connectionContext('guest-connection', {
      principalId: grant.principalId,
      principalKind: 'session_guest',
    }),
  );
  await delayImmediate();
  active = false;
  publishRevocation?.(grant);
  continued.resolve();

  assert.deepEqual(await reading, {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  });
  coordinator.close();
});

test('a durable append refresh advances transcript before its completion event', async () => {
  const durable = [assistantMessage('first')];
  const reader = transcriptReader(durable);
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    reader,
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1', {
    kind: 'tail',
    maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  });
  connection.activate(opened.subscriptionId);
  durable.push({ ...assistantMessage('second'), id: 'message-2' });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-2', 'second'),
  );
  await waitFor(() => sink.frames.length >= 2);
  assert.equal(sink.frames[0]?.kind, 'subscription.transcript_advanced');
  assert.ok(sink.frames.slice(1).every((frame) => frame.kind === 'subscription.session_delta'));
  coordinator.close();
});

test('absolute live offsets survive a gap with no connected subscribers', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const firstConnection = attachTestConnection(
    coordinator,
    'connection-first',
    new RecordingSink(),
  );
  const first = await open(coordinator, 'connection-first');
  firstConnection.activate(first.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  firstConnection.close();
  await delayImmediate();

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  const sink = new RecordingSink();
  const secondConnection = attachTestConnection(coordinator, 'connection-second', sink);
  const second = await open(coordinator, 'connection-second');
  secondConnection.activate(second.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(3));
  await waitFor(() => sink.frames.length === 2);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? { startOffset: frame.delta.startOffset, text: frame.delta.text }
        : frame.kind,
    ),
    [
      { startOffset: 0, text: 'chunk-1chunk-2' },
      { startOffset: 'chunk-1chunk-2'.length, text: 'chunk-3' },
    ],
  );
  coordinator.close();
});

test('keeps the current provider retry on the live Turn until the next content event', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const liveSink = new RecordingSink();
  const live = attachTestConnection(coordinator, 'connection-live', liveSink);
  const opened = await open(coordinator, 'connection-live');
  assert.equal(opened.snapshot.rootTurn && 'providerRetry' in opened.snapshot.rootTurn, false);
  live.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'provider_retry',
    id: 'retry-1',
    turnId: 'turn-1',
    ts: 1,
    phase: 'scheduled',
    attempt: 8,
    maxAttempts: 10,
    delayMs: 40_000,
    reason: 'rate_limit',
  });

  const retry = {
    phase: 'scheduled' as const,
    attempt: 8,
    maxAttempts: 10,
    delayMs: 40_000,
    // The host-clock schedule time is kept so a re-projection mid-wait can
    // recompute the authoritative remaining duration (#3393).
    ts: 1,
    reason: 'rate_limit' as const,
  };
  attachTestConnection(coordinator, 'connection-remount', new RecordingSink());
  const remounted = await open(coordinator, 'connection-remount');
  assert.deepEqual(
    remounted.snapshot.rootTurn && 'providerRetry' in remounted.snapshot.rootTurn
      ? remounted.snapshot.rootTurn.providerRetry
      : undefined,
    retry,
  );
  assert.ok(
    liveSink.frames.some(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn &&
        'providerRetry' in frame.snapshot.rootTurn &&
        frame.snapshot.rootTurn.providerRetry?.phase === 'scheduled',
    ),
  );

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  attachTestConnection(coordinator, 'connection-after-text', new RecordingSink());
  const afterText = await open(coordinator, 'connection-after-text');
  assert.equal(
    afterText.snapshot.rootTurn && 'providerRetry' in afterText.snapshot.rootTurn,
    false,
  );

  live.abort(opened.subscriptionId);
  coordinator.close();
});

test('rejoin seeds tool_result_preview at the open nextSequence without sequence_gap', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', previewEvent());

  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-rejoin', sink);
  const opened = await open(coordinator, 'connection-rejoin');
  assert.equal(opened.nextSequence, 1);

  connection.activate(opened.subscriptionId);
  await delayImmediate();
  assert.equal(sink.frames.length, 1);
  assert.equal(sink.frames[0]?.kind, 'subscription.session_event');
  if (sink.frames[0]?.kind !== 'subscription.session_event') return;
  assert.equal(sink.frames[0].sequence, 1);
  assert.equal(sink.frames[0].event.type, 'tool_result_preview');

  const client = clientSubscription(
    opened,
    async () => {},
    async () => {
      throw new Error('transcript unused');
    },
  );
  assert.doesNotThrow(() => client.accept(sink.frames[0]!));

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('live tool_start projects intent and a bounded args preview, never full args', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-tool-start', sink);
  const opened = await open(coordinator, 'connection-tool-start');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'tool_start',
    id: 'start-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    toolName: 'Bash',
    intent: '只读探索:检查渲染入口',
    args: { command: 'git status --porcelain', content: 'x'.repeat(100 * 1024) },
  });
  await delayImmediate();

  const frame = sink.frames.find((candidate) => candidate.kind === 'subscription.session_event');
  assert.ok(frame && frame.kind === 'subscription.session_event');
  const event = frame.event;
  assert.equal(event.type, 'tool_start');
  if (event.type !== 'tool_start') return;
  assert.equal(event.intent, '只读探索:检查渲染入口');
  assert.deepEqual(event.argsPreview, { command: 'git status --porcelain' });
  assert.equal('args' in event, false);

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('live tool_start never forwards a generic input payload as argsPreview', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-tool-input', sink);
  const opened = await open(coordinator, 'connection-tool-input');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'tool_start',
    id: 'start-input',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-input',
    toolName: 'third_party_tool',
    args: {
      input: 'short private body',
      inputPreview: { text: 'forged private body', bytes: 19, truncated: false },
      size: { cols: 80, rows: 24 },
      questions: [{ question: 'forged private question' }],
    },
  });
  await delayImmediate();

  const frame = sink.frames.find((candidate) => candidate.kind === 'subscription.session_event');
  assert.ok(frame && frame.kind === 'subscription.session_event');
  const event = frame.event;
  assert.equal(event.type, 'tool_start');
  if (event.type !== 'tool_start') return;
  assert.equal(event.argsPreview, undefined);
  assert.doesNotMatch(JSON.stringify(event), /private body/);
  assert.doesNotMatch(JSON.stringify(event), /private question/);

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('tool_result clears retained tool_result_preview so a later open does not seed it', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', previewEvent());
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'tool_result',
    id: 'result-1',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-1',
    isError: false,
    content: { kind: 'text', text: '' },
  });

  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-after-settle', sink);
  const opened = await open(coordinator, 'connection-after-settle');
  assert.equal(opened.nextSequence, 1);
  connection.activate(opened.subscriptionId);
  await delayImmediate();
  assert.equal(
    sink.frames.some(
      (frame) =>
        frame.kind === 'subscription.session_event' && frame.event.type === 'tool_result_preview',
    ),
    false,
  );

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('publishes only the minimal sandbox failure reason from a tool result', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'tool_result',
    id: 'result-1',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-1',
    isError: true,
    content: {
      kind: 'text',
      text: 'sensitive tool output',
      sandboxFailure: { reason: 'sandbox_boundary_required' },
    },
  });
  await waitFor(() => sink.frames.length === 1);

  const [frame] = sink.frames;
  assert.equal(frame?.kind, 'subscription.session_event');
  if (frame?.kind !== 'subscription.session_event') return;
  assert.deepEqual(frame.event, {
    type: 'tool_result',
    id: 'result-1',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-1',
    status: 'errored',
    sandboxFailureReason: 'sandbox_boundary_required',
  });

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('publishes only the bounded shell-run correlation from poll args', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = attachTestConnection(coordinator, 'connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);
  const ref = 'maka://runtime/background-tasks/bg-1';

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'tool_start',
    id: 'start-1',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-1',
    toolName: 'Read',
    args: { path: ref, unrelated: 'not published' },
  });
  await waitFor(() => sink.frames.length === 1);

  const [frame] = sink.frames;
  assert.equal(frame?.kind, 'subscription.session_event');
  if (frame?.kind !== 'subscription.session_event') return;
  assert.deepEqual(frame.event, {
    type: 'tool_start',
    id: 'start-1',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-1',
    toolName: 'Read',
    shellRunRef: ref,
  });

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

/**
 * A connection whose `activate` is the Client's own `subscription.ready`.
 *
 * Frames start where a subscriber says it can take them, so a test that starts
 * them any other way is not exercising the path a Client uses.
 */
function attachTestConnection(
  coordinator: SessionContinuityCoordinator,
  connectionId: string,
  sink: SessionContinuityFrameSink,
  identity?: TestIdentity,
) {
  const connection = coordinator.attachConnection(connectionId, sink);
  return {
    ...connection,
    activate: (subscriptionId: string) =>
      coordinator.handlers['subscription.ready'](
        { subscriptionId },
        connectionContext(connectionId, identity),
      ),
  };
}

class RecordingSink implements SessionContinuityFrameSink {
  readonly frames: SubscriptionFrame[] = [];

  async send(frame: SubscriptionFrame): Promise<void> {
    this.frames.push(frame);
  }
}

/** Records frames but holds each send until released, so a backlog stays unpaid. */
class GatedSink implements SessionContinuityFrameSink {
  readonly frames: SubscriptionFrame[] = [];
  #held: Array<() => void> = [];
  #open = false;

  async send(frame: SubscriptionFrame): Promise<void> {
    this.frames.push(frame);
    if (this.#open) return;
    await new Promise<void>((resolve) => this.#held.push(resolve));
  }

  release(): void {
    this.#open = true;
    const held = this.#held;
    this.#held = [];
    for (const resume of held) resume();
  }
}

function completionOrder(sink: { frames: SubscriptionFrame[] }): string[] {
  return sink.frames.flatMap((frame) =>
    frame.kind === 'subscription.session_delta' && frame.delta.complete
      ? [frame.delta.messageId]
      : [],
  );
}

function textCompleteEvent(messageId: string, text: string) {
  return {
    type: 'text_complete' as const,
    id: `text_complete-${messageId}`,
    turnId: 'turn-1',
    ts: 1,
    messageId,
    text,
  };
}

async function open(
  coordinator: SessionContinuityCoordinator,
  connectionId: string,
  transcript: { readonly kind: 'none' } | { readonly kind: 'tail'; readonly maxBytes: number } = {
    kind: 'none',
  },
  identity: TestIdentity = TEST_OWNER_IDENTITY,
) {
  const outcome = await coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID, transcript },
    connectionContext(connectionId, identity),
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  assert.equal(outcome.ok, true);
  return outcome.result;
}

function connectionContext(
  connectionId: string,
  identity: TestIdentity = TEST_OWNER_IDENTITY,
): ConnectionContext {
  return {
    hostEpoch: HOST_EPOCH,
    connectionId,
    principal: identity.principalId,
    principalKind: identity.principalKind,
    acquireResidency: () => ({ release() {} }),
  };
}

function canonical(
  overrides: {
    metadataRevision?: number;
    rootTurn?: CanonicalSessionProjection['rootTurn'];
    interactions?: CanonicalSessionProjection['interactions'];
    queue?: CanonicalSessionProjection['queue'];
  } = {},
): CanonicalSessionProjection {
  return {
    session: {
      sessionId: SESSION_ID,
      metadataRevision: overrides.metadataRevision ?? 1,
      status: 'active',
      createdAt: 1,
      isArchived: false,
    },
    rootTurn:
      overrides.rootTurn === undefined
        ? { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' }
        : overrides.rootTurn,
    goal: null,
    queue: overrides.queue ?? {
      hostEpoch: HOST_EPOCH,
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: overrides.interactions ?? { pending: [] },
  };
}

function canonicalFor(
  sessionId: string,
  overrides: Parameters<typeof canonical>[0] = {},
): CanonicalSessionProjection {
  const projection = canonical(overrides);
  return {
    ...projection,
    session: { ...projection.session, sessionId },
    rootTurn: projection.rootTurn ? { ...projection.rootTurn, sessionId } : null,
  };
}

function shellRunUpdate(overrides: Partial<ShellRunUpdate> = {}): ShellRunUpdate {
  return {
    sessionId: SESSION_ID,
    ownership: { kind: 'local' },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    result: {
      kind: 'shell_run',
      ref: 'shell:run-1',
      mode: 'pipes',
      status: 'running',
      cwd: '/workspace',
      cmd: 'sleep 60',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pipes',
        stdout: 'ready',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
    ...overrides,
  };
}

function pendingInteraction() {
  return {
    schemaVersion: 1 as const,
    interactionId: 'interaction-1',
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    request: {
      kind: 'question' as const,
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Continue?',
          options: [
            { label: 'Yes', description: 'Continue execution' },
            { label: 'No', description: 'Stop execution' },
          ],
        },
      ],
    },
    status: 'pending' as const,
    outcome: null,
  };
}

function textEvent(index: number, messageId = 'message-1') {
  return {
    type: 'text_delta' as const,
    id: `event-${index}`,
    turnId: 'turn-1',
    ts: index,
    messageId,
    text: `chunk-${index}`,
  };
}

function thinkingEvent(
  type: 'thinking_delta' | 'thinking_complete',
  messageId: string,
  text: string,
) {
  return {
    type,
    id: `${type}-${messageId}`,
    turnId: 'turn-1',
    ts: 1,
    messageId,
    text,
  };
}

function previewEvent() {
  return {
    type: 'tool_result_preview' as const,
    id: 'preview-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'subagent' as const,
      childSessionId: 'child-1',
      agentName: 'Local Read',
      turnId: 'child-turn',
      status: 'running' as const,
      permissionMode: 'explore' as const,
    },
  };
}

function assistantMessage(text: string): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'test-model',
  };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  await pollFor(predicate, {
    attempts: 100,
    message: 'Timed out waiting for continuity state',
  });
}
