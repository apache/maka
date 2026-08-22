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
import type {
  RuntimeHostConnection,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';

test('loads a full transcript only on explicit request and closes Sessions before the connection', async () => {
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
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(await sessionOne.loadTranscript(), []);
  assert.deepEqual(await sessionTwo.loadTranscript(), []);

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

test('derives turn records from bounded contribution pages', async () => {
  const positions: number[] = [];
  const connection = {
    request: async (operation: string, input: { position: number }) => {
      assert.equal(operation, 'session.turns.query');
      positions.push(input.position);
      if (input.position === 0) {
        return {
          sessionId: 'session-1',
          throughSequence: 3,
          contributions: [{
            turnId: 'turn-1',
            firstSequence: 0,
            latestState: null,
            userPromptPreview: 'hello',
            hasAssistantMessage: true,
            hasAssistantOutput: true,
            hasToolResult: false,
            hasFailedToolResult: false,
            hasAbortNote: false,
          }],
          nextPosition: 2,
        };
      }
      return {
        sessionId: 'session-1',
        throughSequence: 3,
        contributions: [{
          turnId: 'turn-1',
          firstSequence: 2,
          latestState: {
            sequence: 2,
            message: {
              type: 'turn_state',
              id: 'state-1',
              turnId: 'turn-1',
              ts: 3,
              status: 'completed',
              partialOutputRetained: false,
            },
          },
          userPromptPreview: null,
          hasAssistantMessage: false,
          hasAssistantOutput: false,
          hasToolResult: true,
          hasFailedToolResult: false,
          hasAbortNote: false,
        }],
        nextPosition: null,
      };
    },
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
  const client = new DesktopRuntimeHostClient(connection);

  assert.deepEqual(await client.listSessionTurns('session-1'), [{
    turnId: 'turn-1',
    firstSequence: 0,
    userPromptPreview: 'hello',
    status: 'completed',
    statusSource: 'recorded',
    partialOutputRetained: true,
  }]);
  assert.deepEqual(positions, [0, 2]);
  await client.close();
});

test('reads the bounded prompt rail index without paging every turn', async () => {
  const connection = {
    request: async (operation: string, input: unknown) => {
      assert.equal(operation, 'session.turn_landmarks.query');
      assert.deepEqual(input, { sessionId: 'session-1', maxLandmarks: 64 });
      return {
        sessionId: 'session-1',
        throughSequence: 100,
        landmarks: [{ turnId: 'turn-50', sequence: 50, label: 'middle' }],
      };
    },
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
  const client = new DesktopRuntimeHostClient(connection);

  assert.deepEqual(await client.listSessionTurnLandmarks('session-1'), {
    sessionId: 'session-1',
    throughSequence: 100,
    landmarks: [{ turnId: 'turn-50', sequence: 50, label: 'middle' }],
  });
  await client.close();
});

function subscription(
  sessionId: string,
  lifecycle: string[],
): RuntimeHostSessionSubscription {
  return {
    hostEpoch: 'host-1',
    subscriptionId: `subscription-${sessionId}`,
    activeAssistantStreams: [],
    transcriptBootstrap: {
      throughSequence: null,
      overlayMessageCount: 0,
      durable: emptyTranscriptPage(sessionId, 'durable'),
      overlay: emptyTranscriptPage(sessionId, 'overlay'),
    },
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
    loadTranscriptOverlay: async <T>(_decodeMessage: (value: unknown) => T) => [] as T[],
    decodeTranscriptPage: async () => {
      throw new Error('Fake subscription does not expose transcript pages');
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

function emptyTranscriptPage(sessionId: string, source: 'durable' | 'overlay') {
  return {
    kind: 'page' as const,
    sessionId,
    source,
    direction: 'older' as const,
    throughSequence: null,
    rawBytes: 0,
    fragments: [],
    nextCursor: null,
  };
}
