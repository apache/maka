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
import test from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { SteeringMessageSnapshot } from '../protocol/message.js';
import {
  createRuntimeHostSessionProjectionSeed,
  projectRuntimeHostInteractionRequest,
  RuntimeHostSessionProjector,
} from '../adapter/session-projector.js';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
} from '../protocol/index.js';

test('projects Client Capability approvals without exposing provider identities', () => {
  assert.deepEqual(
    projectRuntimeHostInteractionRequest(
      {
        schemaVersion: 1,
        interactionId: 'approval-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        revision: 1,
        request: {
          kind: 'client_capability',
          toolUseId: 'tool-1',
          target: {
            providerId: 'provider-secret',
            contractId: 'contract-secret',
            serverId: 'desktop_browser',
            toolName: 'browser_snapshot',
            capability: 'browser',
            scope: { kind: 'browser_origin', origin: 'https://example.com' },
          },
        },
        status: 'pending',
        outcome: null,
      },
      10,
    ),
    [
      {
        type: 'client_capability_request',
        id: 'host-interaction:approval-1:1',
        turnId: 'turn-1',
        ts: 10,
        requestId: 'approval-1',
        toolUseId: 'tool-1',
        capability: 'browser',
        scope: { kind: 'browser_origin', origin: 'https://example.com' },
      },
    ],
  );
});

test('applies authoritative replacement once and does not complete it again at Turn terminal', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed([assistant('message-1', 'draft')], snapshot()),
    () => 10,
    [{ kind: 'text', turnId: 'turn-1', messageId: 'message-1' }],
  );

  assert.deepEqual(
    projector.seedActive(true).map((event) => event.type),
    ['text_delta'],
  );
  assert.deepEqual(projector.accept(deltaFrame(1, 0, 'final', { reset: true })).events, []);
  const completed = projector.accept(deltaFrame(2, 5, '', { complete: true })).events;
  assert.deepEqual(
    completed.map((event) => [event.type, 'text' in event ? event.text : '']),
    [['text_complete', 'final']],
  );
  assert.deepEqual(projector.seedActive(true), []);

  const terminal = projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 3,
    snapshot: snapshot({
      projectionRevision: 2,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'completed',
        terminalEventId: 'terminal-1',
      },
    }),
  }).events;
  assert.deepEqual(
    terminal.map((event) => event.type),
    ['complete'],
  );
});

test('keeps a revocable in-flight lease pending', () => {
  const previous = snapshot({
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 1,
      steering: [
        {
          entryId: 'entry-1',
          messageId: 'ticket-1',
          content: { text: 'continue here' },
          placement: 'current_turn',
          state: 'queued',
        },
      ],
      followup: [],
    },
  });
  const projector = new RuntimeHostSessionProjector(
    previous,
    createRuntimeHostSessionProjectionSeed([], previous),
    () => 10,
    [],
    true,
  );

  const events = projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: snapshot({
      projectionRevision: 2,
      queue: {
        hostEpoch: 'host-1',
        queueRevision: 2,
        steering: [
          {
            entryId: 'entry-1',
            messageId: 'ticket-1',
            content: { text: 'continue here' },
            placement: 'current_turn',
            state: 'in_flight',
          },
        ],
        followup: [],
      },
    }),
  }).events;

  assert.deepEqual(
    events.filter((event) => event.type === 'message_admission'),
    [],
  );
});

test('does not reseed a revocable in-flight lease as an admission', () => {
  const current = snapshot({
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 2,
      steering: [
        {
          entryId: 'entry-1',
          messageId: 'ticket-1',
          content: { text: 'continue here' },
          placement: 'current_turn',
          state: 'in_flight',
        },
      ],
      followup: [],
    },
  });
  const projector = new RuntimeHostSessionProjector(
    current,
    createRuntimeHostSessionProjectionSeed([], current),
    () => 10,
    [],
    true,
  );

  assert.deepEqual(
    projector.seedActive(false).filter((event) => event.type === 'message_admission'),
    [],
  );
});

test('reseeds the Host admission fact after an active Turn message leaves the queue', () => {
  const current = snapshot();
  const projector = new RuntimeHostSessionProjector(
    current,
    createRuntimeHostSessionProjectionSeed(
      [
        {
          type: 'user',
          id: 'ticket-1',
          turnId: 'turn-1',
          ts: 1,
          text: 'continue here',
          steeringEventId: 'steering-event-1',
        },
      ],
      current,
    ),
    () => 10,
    [],
    true,
  );

  assert.deepEqual(
    projector
      .seedActive(false)
      .filter(
        (event): event is Extract<SessionEvent, { type: 'message_admission' }> =>
          event.type === 'message_admission',
      )
      .map((event) => ({
        outcome: event.outcome,
        turnId: event.turnId,
        messageId: event.messageId,
      })),
    [{ outcome: 'admitted', turnId: 'turn-1', messageId: 'ticket-1' }],
  );
});

test('admits an in-flight message only after its durable Turn ownership is recorded', () => {
  const current = snapshot({
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 2,
      steering: [
        {
          entryId: 'entry-1',
          messageId: 'ticket-1',
          content: { text: 'continue here' },
          placement: 'current_turn',
          state: 'in_flight',
        },
      ],
      followup: [],
    },
  });
  const projector = new RuntimeHostSessionProjector(
    current,
    createRuntimeHostSessionProjectionSeed([], current),
    () => 10,
    [],
    true,
  );
  const durableMessage: StoredMessage = {
    type: 'user',
    id: 'ticket-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'continue here',
    steeringEventId: 'steering-event-1',
  };

  assert.deepEqual(
    projector.noteDurableTranscriptMessages([durableMessage]).map((event) => ({
      type: event.type,
      turnId: event.turnId,
      messageId: 'messageId' in event ? event.messageId : undefined,
    })),
    [{ type: 'message_admission', turnId: 'turn-1', messageId: 'ticket-1' }],
  );
  assert.deepEqual(projector.noteDurableTranscriptMessages([durableMessage]), []);
});

test('reseeds the latest provider retry when the active Turn still carries one', () => {
  const retry = {
    phase: 'scheduled' as const,
    attempt: 8,
    maxAttempts: 10,
    delayMs: 40_000,
    reason: 'rate_limit' as const,
  };
  const projector = new RuntimeHostSessionProjector(
    snapshot({
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running',
        providerRetry: retry,
      },
    }),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );

  const seeded = projector.seedActive(true);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]?.type, 'provider_retry');
  assert.equal(seeded[0] && 'phase' in seeded[0] ? seeded[0].phase : undefined, 'scheduled');
});

test('projects structured context-budget failure detail to the Desktop event', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );

  const events = projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: snapshot({
      projectionRevision: 2,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'failed',
        terminalEventId: 'terminal-1',
        failureClass: 'context_budget_exhausted',
        contextBudgetExhaustedDetail: 'malformed_summary_missing_section',
      },
    }),
  }).events;

  assert.deepEqual(events, [
    {
      type: 'error',
      id: 'terminal-1',
      turnId: 'turn-1',
      ts: 10,
      recoverable: false,
      reason: 'context_budget_exhausted',
      message: 'Turn failed: context_budget_exhausted',
      details: { contextBudgetExhaustedDetail: 'malformed_summary_missing_section' },
    },
  ]);
});

test('reseeds a scheduled retry with remainingMs recomputed from the stored schedule time', () => {
  // #3393: a reconnect mid-wait must not restart the countdown. The snapshot
  // keeps the host-clock schedule time; the projector re-derives the skew-free
  // remaining duration at projection time.
  const projector = new RuntimeHostSessionProjector(
    snapshot({
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running',
        providerRetry: {
          phase: 'scheduled' as const,
          attempt: 8,
          maxAttempts: 10,
          delayMs: 40_000,
          ts: 5, // scheduled 5ms before the projector clock's `now`
          reason: 'rate_limit' as const,
        },
      },
    }),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );

  const seeded = projector.seedActive(true);
  const retry = seeded[0];
  assert.ok(retry && retry.type === 'provider_retry' && retry.phase === 'scheduled');
  assert.equal(retry.delayMs, 40_000);
  assert.equal(retry.remainingMs, 39_995);
});

test('emits a live provider retry when the snapshot overlay appears, then drops it after content', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );
  const retrying = snapshot({
    projectionRevision: 2,
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
      providerRetry: {
        phase: 'scheduled',
        attempt: 8,
        maxAttempts: 10,
        delayMs: 40_000,
        reason: 'rate_limit',
      },
    },
  });
  const appeared = projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: retrying,
  }).events;
  assert.equal(appeared.length, 1);
  assert.equal(appeared[0]?.type, 'provider_retry');

  const recovered = snapshot({
    projectionRevision: 3,
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    },
  });
  projector.accept({
    kind: 'subscription.session_delta',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 2,
    sessionId: 'session-1',
    delta: {
      kind: 'text',
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      startOffset: 0,
      text: 'ok',
    },
  });
  projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 3,
    snapshot: recovered,
  });
  assert.deepEqual(
    projector.seedActive(true).map((event) => event.type),
    ['text_delta'],
  );
});

test('seeds only streams identified as active by the Host catch-up state', () => {
  const transcript: StoredMessage[] = [
    assistant('completed-step', 'done'),
    {
      ...assistant('active-step', ''),
      thinking: { text: 'still working' },
    },
  ];
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed(transcript, snapshot()),
    () => 10,
    [{ kind: 'thinking', turnId: 'turn-1', messageId: 'active-step' }],
  );

  assert.deepEqual(
    projector
      .seedActive(true)
      .map((event) => [event.type, 'messageId' in event && event.messageId]),
    [['thinking_delta', 'active-step']],
  );
});

test('does not replay settled transcript steps when the active step reaches terminal', () => {
  const transcript: StoredMessage[] = [
    {
      ...assistant('settled-step-1', 'first answer'),
      thinking: { text: 'first thought' },
    },
    {
      ...assistant('settled-step-2', 'second answer'),
      thinking: { text: 'second thought' },
    },
    {
      ...assistant('active-step', 'partial answer'),
      thinking: { text: 'active thought' },
    },
  ];
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed(transcript, snapshot()),
    () => 10,
    [
      { kind: 'text', turnId: 'turn-1', messageId: 'active-step' },
      { kind: 'thinking', turnId: 'turn-1', messageId: 'active-step' },
    ],
  );

  assert.deepEqual(
    projector
      .seedActive(true)
      .map((event) => [
        event.type,
        'messageId' in event && event.messageId,
        'text' in event && event.text,
      ]),
    [
      ['thinking_delta', 'active-step', 'active thought'],
      ['text_delta', 'active-step', 'partial answer'],
    ],
  );

  const terminal = projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: snapshot({
      projectionRevision: 2,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'completed',
        terminalEventId: 'terminal-1',
      },
    }),
  }).events;

  assert.deepEqual(
    terminal.map((event) => [
      event.type,
      'messageId' in event ? event.messageId : undefined,
      'text' in event ? event.text : undefined,
    ]),
    [
      ['thinking_complete', 'active-step', 'active thought'],
      ['text_complete', 'active-step', 'partial answer'],
      ['complete', undefined, undefined],
    ],
  );
});

test('marks Runtime Host tool results whose durable content is omitted', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );

  const projected = projector.accept({
    kind: 'subscription.session_event',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    event: {
      type: 'tool_result',
      id: 'result-1',
      turnId: 'turn-1',
      ts: 10,
      toolUseId: 'tool-1',
      status: 'completed',
    },
  }).events[0];

  assert.equal(projected?.type, 'tool_result');
  assert.equal(
    projected?.type === 'tool_result' && 'contentOmitted' in projected
      ? projected.contentOmitted
      : undefined,
    true,
  );
});

test('preserves the bounded shell-run correlation on a tool start', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );
  const ref = 'maka://runtime/background-tasks/bg-1';

  const projected = projector.accept({
    kind: 'subscription.session_event',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    event: {
      type: 'tool_start',
      id: 'start-1',
      turnId: 'turn-1',
      ts: 10,
      toolUseId: 'tool-1',
      toolName: 'Read',
      shellRunRef: ref,
    },
  } as SubscriptionFrame).events[0];

  assert.equal(projected?.type, 'tool_start');
  assert.equal(
    projected?.type === 'tool_start' && 'shellRunRef' in projected
      ? projected.shellRunRef
      : undefined,
    ref,
  );
});

test('projects the durable steering echo even when the in-flight queue state was never observed', () => {
  // Regression for apache/maka#3304: the coalesced canonical refresh can jump
  // the queue straight from queued to consumed, so the in-flight synthesis
  // never fires. The forwarded steering_message event must render the message.
  const projector = new RuntimeHostSessionProjector(
    snapshot({ queue: queue(2, [steeringEntry('queued')]) }),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );

  const skipped = projector.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: snapshot({ queue: queue(4, []) }),
  });
  assert.deepEqual(
    skipped.events.map((event) => event.type),
    ['queue_update'],
  );

  const echoed = projector.accept(steeringFrame(2)).events;
  assert.equal(echoed.length, 1);
  assert.deepEqual(echoed[0], {
    type: 'steering_message',
    id: 'steering-event-1',
    turnId: 'turn-1',
    ts: 10,
    messageId: 'steering-message-1',
    content: { text: 'steer the turn' },
  });
});

test('projects a steering message exactly once across both authoritative paths', () => {
  // The queue in-flight synthesis and the durable session-event echo race;
  // whichever projects the message first suppresses the other.
  const inFlightFirst = new RuntimeHostSessionProjector(
    snapshot({ queue: queue(2, [steeringEntry('queued')]) }),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );
  const synthesized = inFlightFirst.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: snapshot({ queue: queue(3, [steeringEntry('in_flight')]) }),
  });
  assert.deepEqual(
    synthesized.events.map((event) => event.type),
    ['steering_message', 'queue_update'],
  );
  assert.deepEqual(inFlightFirst.accept(steeringFrame(2)).events, []);

  const echoFirst = new RuntimeHostSessionProjector(
    snapshot({ queue: queue(2, [steeringEntry('queued')]) }),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );
  assert.equal(echoFirst.accept(steeringFrame(1)).events.length, 1);
  const suppressed = echoFirst.accept({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 2,
    snapshot: snapshot({ queue: queue(3, [steeringEntry('in_flight')]) }),
  });
  assert.deepEqual(
    suppressed.events.map((event) => event.type),
    ['queue_update'],
  );
});

test('seeds an unrendered in-flight steering message once on rejoin', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot({ queue: queue(3, [steeringEntry('in_flight')]) }),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
  );
  assert.deepEqual(
    projector.seedActive(false).map((event) => event.type),
    ['steering_message', 'queue_update'],
  );
  // A live echo of the same message arriving after the seed is the duplicate.
  assert.deepEqual(projector.accept(steeringFrame(1)).events, []);
});

test('suppresses the live echo for a steering message already durable in the bootstrap', () => {
  // subscription.open can bootstrap the durable steering message and install
  // the subscriber while the Host's forwarded echo for it is still pending:
  // the bootstrapped render must stay the only one (apache/maka#3316 review).
  const inFlight = snapshot({ queue: queue(3, [steeringEntry('in_flight')]) });
  const projector = new RuntimeHostSessionProjector(
    inFlight,
    createRuntimeHostSessionProjectionSeed(
      [userSteering('steering-message-1', 'steering-event-1')],
      inFlight,
    ),
    () => 10,
  );

  // Durable and in-flight: no synthesis seed…
  assert.deepEqual(
    projector.seedActive(false).map((event) => event.type),
    ['queue_update'],
  );
  // …and the late echo of the same message is the duplicate.
  assert.deepEqual(projector.accept(steeringFrame(1)).events, []);
  // A different steering message still renders normally.
  assert.equal(projector.accept(steeringFrame(2, 'steering-message-2')).events.length, 1);
});

function steeringEntry(state: 'queued' | 'in_flight'): SteeringMessageSnapshot {
  return {
    entryId: 'entry-1',
    messageId: 'steering-message-1',
    content: { text: 'steer the turn' },
    placement: 'current_turn',
    state,
  };
}

function steeringFrame(sequence: number, messageId = 'steering-message-1'): SubscriptionFrame {
  return {
    kind: 'subscription.session_event',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence,
    sessionId: 'session-1',
    runId: 'run-1',
    event: {
      type: 'steering_message',
      id: 'steering-event-1',
      turnId: 'turn-1',
      ts: 10,
      messageId,
      content: { text: 'steer the turn' },
    },
  };
}

function userSteering(
  id: string,
  steeringEventId: string,
): Extract<StoredMessage, { type: 'user' }> {
  return {
    type: 'user',
    id,
    turnId: 'turn-1',
    ts: 1,
    text: 'steer the turn',
    steeringEventId,
  };
}

function deltaFrame(
  sequence: number,
  startOffset: number,
  text: string,
  flags: { reset?: true; complete?: true } = {},
): SubscriptionFrame {
  return {
    kind: 'subscription.session_delta',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence,
    sessionId: 'session-1',
    delta: {
      kind: 'text',
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      startOffset,
      text,
      ...flags,
    },
  };
}

function queue(
  queueRevision: number,
  steering: readonly SteeringMessageSnapshot[],
): SessionContinuitySnapshot['queue'] {
  return { hostEpoch: 'host-1', queueRevision, steering, followup: [] };
}

function snapshot(overrides: Partial<SessionContinuitySnapshot> = {}): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    },
    goal: null,
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
    ...overrides,
  };
}

function assistant(id: string, text: string): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id,
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'gpt-5',
  };
}

test('live tool_start keeps intent and argsPreview, and never fabricates args', () => {
  const projector = new RuntimeHostSessionProjector(
    snapshot(),
    createRuntimeHostSessionProjectionSeed([], snapshot()),
    () => 10,
    [],
  );

  const update = projector.accept({
    kind: 'subscription.session_event',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    event: {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      toolName: 'Bash',
      intent: '只读探索:检查渲染入口',
      argsPreview: { command: 'git status --porcelain' },
    },
  });

  assert.equal(update.events.length, 1);
  const event = update.events[0]!;
  assert.equal(event.type, 'tool_start');
  if (event.type !== 'tool_start') return;
  assert.equal(event.intent, '只读探索:检查渲染入口');
  assert.deepEqual(event.argsPreview, { command: 'git status --porcelain' });
  assert.equal(event.args, undefined);
});
