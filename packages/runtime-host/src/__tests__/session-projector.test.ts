import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  createRuntimeHostSessionProjectionSeed,
  RuntimeHostSessionProjector,
} from '../adapter/session-projector.js';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
} from '../protocol/index.js';

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

function snapshot(overrides: Partial<SessionContinuitySnapshot> = {}): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      lastUsedAt: 1,
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
