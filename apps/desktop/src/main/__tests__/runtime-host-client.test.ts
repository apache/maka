import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  RuntimeHostConnection,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';

test('starts transcript loading at attach and closes every Session before the connection', async () => {
  const lifecycle: string[] = [];
  const first = subscription('session-1', lifecycle);
  const second = subscription('session-2', lifecycle);
  const subscriptions = [first, second];
  const connection = {
    openSessionSubscription: async () => {
      const next = subscriptions.shift();
      if (!next) throw new Error('Unexpected Session open');
      return next;
    },
    close: async () => {
      lifecycle.push('connection:close');
    },
  } as unknown as RuntimeHostConnection;
  const client = new DesktopRuntimeHostClient(connection);

  const sessionOne = await client.openSession('session-1');
  const sessionTwo = await client.openSession('session-2');
  assert.deepEqual(lifecycle, ['session-1:transcript', 'session-2:transcript']);
  assert.deepEqual(await sessionOne.transcript, []);
  assert.deepEqual(await sessionTwo.transcript, []);

  await client.close();
  assert.deepEqual(lifecycle, [
    'session-1:transcript',
    'session-2:transcript',
    'session-1:close',
    'session-2:close',
    'connection:close',
  ]);
  await assert.rejects(() => client.openSession('session-3'), /Client is closed/);
});

function subscription(
  sessionId: string,
  lifecycle: string[],
): RuntimeHostSessionSubscription {
  return {
    hostEpoch: 'host-1',
    subscriptionId: `subscription-${sessionId}`,
    activeAssistantStreams: [],
    transcriptBootstrap: null,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: {
        sessionId,
        metadataRevision: 1,
        status: 'active',
        createdAt: 1,
        lastUsedAt: 1,
        isArchived: false,
      },
      projectionRevision: 1,
      rootTurn: null,
      goal: null,
      queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    },
    loadTranscript: async <T>(_decodeMessage: (value: unknown) => T) => {
      lifecycle.push(`${sessionId}:transcript`);
      return [] as T[];
    },
    loadTranscriptPage: async () => {
      throw new Error('Fake subscription does not expose transcript pages');
    },
    close: async () => {
      lifecycle.push(`${sessionId}:close`);
    },
    [Symbol.asyncIterator]: async function* (): AsyncIterator<SubscriptionFrame> {},
  };
}
