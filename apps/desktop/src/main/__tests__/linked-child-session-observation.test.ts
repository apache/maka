import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionChangedReason, SessionEvent } from '@maka/core';
import { createLinkedChildEventProjection } from '../session-stream.js';

describe('linked child session observation', () => {
  test('projects nested child events onto normal renderer and gateway channels', async () => {
    const rendererEvents: Array<{ channel: string; event: SessionEvent }> = [];
    const gatewayEvents: Array<{ sessionId: string; event: SessionEvent }> = [];
    const changes: Array<{ reason: SessionChangedReason; sessionId?: string }> = [];
    const presentationEvents: SessionEvent[] = [];
    const projection = createLinkedChildEventProjection({
      lifecycle: 'created',
      safeSendToRenderer: (channel, event) => {
        rendererEvents.push({ channel, event: event as SessionEvent });
      },
      openGateway: {
        publishSessionEvent: (sessionId, event) => gatewayEvents.push({ sessionId, event }),
      },
      emitSessionsChanged: (reason, sessionId) => changes.push({ reason, sessionId }),
      onEvent: (event) => presentationEvents.push(event),
    });
    await projection.onReady({
      childSessionId: 'child-session',
      turnId: 'child-turn',
      runId: 'child-run',
      agentId: 'local-read',
      agentName: 'Local Read',
    });
    const delta: SessionEvent = {
      type: 'text_delta',
      id: 'delta',
      turnId: 'child-turn',
      ts: 1,
      messageId: 'message',
      text: 'observed',
    };
    const complete: SessionEvent = {
      type: 'complete',
      id: 'complete',
      turnId: 'child-turn',
      ts: 2,
      stopReason: 'end_turn',
    };

    projection.onEvent(delta);
    projection.onEvent(complete);

    assert.deepEqual(
      rendererEvents.map(({ channel, event }) => [channel, event.id]),
      [
        ['sessions:event:child-session', 'delta'],
        ['sessions:event:child-session', 'complete'],
      ],
    );
    assert.deepEqual(
      gatewayEvents.map(({ sessionId, event }) => [sessionId, event.id]),
      [
        ['child-session', 'delta'],
        ['child-session', 'complete'],
      ],
    );
    assert.deepEqual(presentationEvents.map((event) => event.id), ['delta', 'complete']);
    assert.deepEqual(changes, [
      { reason: 'created', sessionId: 'child-session' },
      { reason: 'turn-status-change', sessionId: 'child-session' },
      { reason: 'message-appended', sessionId: 'child-session' },
      { reason: 'status-change', sessionId: 'child-session' },
      { reason: 'turn-status-change', sessionId: 'child-session' },
    ]);
  });

  test('does not project a legacy child run that has no child Session identity', async () => {
    const rendererEvents: unknown[] = [];
    const projection = createLinkedChildEventProjection({
      lifecycle: 'continued',
      safeSendToRenderer: (...args) => rendererEvents.push(args),
      openGateway: { publishSessionEvent: () => assert.fail('must not publish') },
      emitSessionsChanged: () => assert.fail('must not announce a child Session'),
    });

    await projection.onReady({
      turnId: 'legacy-turn',
      agentId: 'local-read',
      agentName: 'Local Read',
    });
    projection.onEvent({
      type: 'complete',
      id: 'complete',
      turnId: 'legacy-turn',
      ts: 1,
      stopReason: 'end_turn',
    });

    assert.deepEqual(rendererEvents, []);
  });
});
