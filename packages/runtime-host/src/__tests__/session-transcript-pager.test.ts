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
import {
  decodeStoredMessage as decodePersistedStoredMessage,
  type StoredMessage,
} from '@maka/core/session';
import { markPersisted } from '@maka/core/persisted-value';
import { ClientSessionSubscription } from '../client/session-subscription.js';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '../protocol/index.js';
import {
  createSessionTranscriptBootstrap,
  prepareSessionTranscriptOverlay,
  readSessionTranscriptPage,
  TranscriptPageRequestError,
  updateSubscriberTranscriptHighWater,
} from '../server/session-transcript-pager.js';
import type { SessionTranscriptReader } from '../server/session-transcript-reader.js';
import { projectSharedSessionTranscriptMessage } from '../server/shared-session-transcript.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';

test('reads newly durable messages forward from an announced watermark', async () => {
  const durable = [userMessage(0), userMessage(1)];
  const reader = transcriptReader(durable);
  const { bootstrap, state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 1024,
    projection: 'owner',
  });
  assert.equal(bootstrap.throughSequence, 1);

  durable.push(userMessage(2), userMessage(3));
  assert.equal(updateSubscriberTranscriptHighWater(state, 3), true);
  const page = await readSessionTranscriptPage({
    reader,
    state,
    request: {
      subscriptionId: 'subscription-1',
      source: 'durable',
      direction: 'newer',
      throughSequence: 3,
      cursor: null,
      anchorSequence: 1,
      maxBytes: 1024,
    },
  });
  assert.deepEqual(
    page.fragments.map((fragment) =>
      fragment.kind === 'durable' ? fragment.sequence : fragment.messageIndex,
    ),
    [2, 3],
  );
  assert.equal(page.rangeBoundarySequence, 3);
  assert.equal(page.protectedTurnSequence, 3);
  assert.equal(page.nextCursor, null);
});

test('projects durable and active transcript records before sharing them', async () => {
  const durable: StoredMessage[] = [
    {
      ...assistantMessage(0),
      providerOptions: { replay: 'private' },
      thinking: {
        text: 'visible thought',
        signature: 'private-signature',
        providerOptions: { replay: 'private' },
      },
    },
    {
      type: 'tool_result',
      id: 'result-1',
      turnId: 'turn-0',
      ts: 2,
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: 'visible result' },
      modelVisibility: 'hidden',
      providerOutput: { replay: 'private' },
    },
    {
      type: 'system_note',
      id: 'audit-1',
      ts: 3,
      kind: 'mode_change',
      data: { previousSessionId: 'private-session' },
    },
    {
      type: 'user',
      id: 'user-1',
      turnId: 'turn-0',
      ts: 4,
      text: 'private composed skill instructions',
      displayText: 'visible attachment',
      steeringEventId: 'steering-event-1',
      attachments: [
        {
          kind: 'code',
          name: 'visible.ts',
          mimeType: 'text/typescript',
          bytes: 7,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'visible.ts' },
        },
        {
          kind: 'code',
          name: 'private.ts',
          mimeType: 'text/typescript',
          bytes: 8,
          ref: { kind: 'external_file', absolutePath: '/private/private.ts' },
        },
      ],
    },
  ];
  const overlay: StoredMessage[] = [
    {
      ...assistantMessage(1),
      providerOptions: { replay: 'private' },
    },
  ];
  const reader = transcriptReader(durable, overlay);
  const owner = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'owner',
    throughSequence: 2,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    projection: 'owner',
  });
  const shared = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'shared',
    throughSequence: 3,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    projection: 'shared',
  });

  assert.equal(
    (decodeBootstrap(owner.bootstrap.durable)[0] as { data?: unknown }).data !== undefined,
    true,
  );
  assert.equal(
    (decodeBootstrap(owner.bootstrap.overlay)[0] as { providerOptions?: unknown })
      .providerOptions !== undefined,
    true,
  );
  const sharedDurable = decodeBootstrap(shared.bootstrap.durable);
  assert.deepEqual(
    sharedDurable.map((message) => message.type),
    ['user', 'tool_result', 'assistant'],
  );
  const sharedAttachments = sharedDurable[0]?.attachments;
  assert.deepEqual(
    Array.isArray(sharedAttachments)
      ? sharedAttachments.map((item) => (item as { name: string }).name)
      : [],
    ['visible.ts'],
  );
  assert.equal(sharedDurable[0]?.text, 'visible attachment');
  assert.equal('displayText' in sharedDurable[0]!, false);
  assert.equal(sharedDurable[0]?.steeringEventId, 'steering-event-1');
  assert.equal('providerOutput' in sharedDurable[1]!, false);
  assert.equal('providerOptions' in sharedDurable[2]!, false);
  assert.deepEqual(sharedDurable[2]!.thinking, { text: 'visible thought' });
  assert.equal('providerOptions' in decodeBootstrap(shared.bootstrap.overlay)[0]!, false);
  const projectedState = projectSharedSessionTranscriptMessage(
    {
      type: 'turn_state',
      id: 'state-1',
      turnId: 'turn-0',
      ts: 5,
      status: 'aborted',
      abortedAt: 5,
      abortSource: 'stop_button',
      partialOutputRetained: true,
    },
    'session-1',
  );
  assert.equal(projectedState?.type, 'turn_state');
  if (projectedState?.type === 'turn_state') {
    assert.equal(projectedState.abortSource, 'stop_button');
  }
  const projectedInput = projectSharedSessionTranscriptMessage(
    {
      type: 'tool_call',
      id: 'tool-1',
      turnId: 'turn-0',
      ts: 6,
      toolName: 'WriteStdin',
      args: { ref: 'shell-1', input: 'secret=sk-example-value' },
    },
    'session-1',
  );
  assert.equal(projectedInput?.type, 'tool_call');
  if (projectedInput?.type === 'tool_call') {
    assert.equal(JSON.stringify(projectedInput.args).includes('sk-example-value'), false);
  }
});

test('rejects cursor tampering and cross-subscription replay', async () => {
  const reader = transcriptReader([userMessage(0, 'x'.repeat(2_000))]);
  const first = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 0,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 128,
    projection: 'owner',
  });
  const second = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-2',
    throughSequence: 0,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 128,
    projection: 'owner',
  });
  const cursor = first.bootstrap.durable.nextCursor;
  assert.ok(cursor);
  if (!cursor) return;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  const request = {
    subscriptionId: 'subscription-1',
    source: 'durable' as const,
    direction: 'older' as const,
    throughSequence: 0,
    cursor,
    anchorSequence: null,
    maxBytes: 128,
  };

  await assert.rejects(
    readSessionTranscriptPage({
      reader,
      state: first.state,
      request: { ...request, cursor: tampered },
    }),
    TranscriptPageRequestError,
  );
  await assert.rejects(
    readSessionTranscriptPage({ reader, state: second.state, request }),
    TranscriptPageRequestError,
  );
});

test('keeps a durable continuation when overlay bytes reduce the bootstrap budget', async () => {
  const durable = [userMessage(0, 'a'.repeat(240)), userMessage(1, 'b'.repeat(240))];
  const reader = transcriptReader(durable, [userMessage(0, 'overlay'.repeat(40))]);
  const { bootstrap } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: Buffer.byteLength(JSON.stringify(durable[0]), 'utf8') * 2,
    projection: 'owner',
  });
  assert.ok(bootstrap.overlay.rawBytes > 0);
  assert.ok(bootstrap.durable.nextCursor);
});

test('opens the complete latest Turn when bootstrap starts inside its assistant', async () => {
  const prompt = { ...userMessage(0, 'hello'), turnId: 'turn-1' };
  const assistant = {
    ...assistantMessage(1),
    turnId: 'turn-1',
    text: 'x'.repeat(20 * 1024),
  };
  const reader = transcriptReader([prompt, assistant]);
  const { bootstrap, state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 1,
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    },
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    projection: 'owner',
  });

  assert.equal(bootstrap.durable.rangeBoundarySequence, 0);
  assert.equal(bootstrap.durable.protectedTurnSequence, 1);
  assert.ok(bootstrap.durable.nextCursor);
  const subscription = new ClientSessionSubscription(
    {
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      nextSequence: 1,
      activeAssistantStreams: [],
      transcript: bootstrap,
      snapshot: {
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
        queue: { hostEpoch: 'host-1', queueRevision: 1, steering: [], followup: [] },
        interactions: { pending: [] },
      },
    },
    async () => undefined,
    (request) => readSessionTranscriptPage({ reader, state, request }),
  );
  const decodeStoredMessage = (value: unknown): StoredMessage =>
    decodePersistedStoredMessage(markPersisted<StoredMessage>(value));

  const decoded = await subscription.decodeTranscriptPage(bootstrap.durable, decodeStoredMessage);

  assert.deepEqual(decoded.messages, [
    { identity: 0, message: prompt },
    { identity: 1, message: assistant },
  ]);
  assert.equal(decoded.nextCursor, null);
});

test('rejects a latest Turn that exceeds the Host range message bound', async () => {
  const durable = Array.from({ length: 257 }, (_, index) => ({
    ...assistantMessage(index),
    turnId: 'turn-1',
  }));

  await assert.rejects(
    createSessionTranscriptBootstrap({
      reader: transcriptReader(durable),
      sessionId: 'session-1',
      subscriptionId: 'subscription-1',
      throughSequence: durable.length - 1,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running',
      },
      activeAssistantStreams: [],
      maxBytes: 16 * 1024,
      projection: 'owner',
    }),
    /Turn range exceeds its capacity limit/,
  );
});

test('admits a latest Turn exactly at the Host range message bound', async () => {
  const durable: StoredMessage[] = [
    { ...assistantMessage(0), turnId: 'turn-before' },
    ...Array.from({ length: 256 }, (_, index) => ({
      ...assistantMessage(index + 1),
      turnId: 'turn-latest',
    })),
  ];

  for (const projection of ['owner', 'shared'] as const) {
    const { bootstrap } = await createSessionTranscriptBootstrap({
      reader: transcriptReader(durable),
      sessionId: 'session-1',
      subscriptionId: `subscription-${projection}`,
      throughSequence: durable.length - 1,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-before',
        runId: 'run-1',
        status: 'running',
      },
      activeAssistantStreams: [],
      maxBytes: 16 * 1024,
      projection,
    });

    assert.equal(bootstrap.durable.rangeBoundarySequence, 1);
    assert.equal(bootstrap.durable.protectedTurnSequence, durable.length - 1);
  }
});

test('excludes a partial far-edge Turn when the complete range would exceed its bound', async () => {
  const durable: StoredMessage[] = [
    ...Array.from({ length: 3 }, (_, index) => ({
      ...assistantMessage(index),
      turnId: 'turn-far-edge',
    })),
    ...Array.from({ length: 254 }, (_, index) => assistantMessage(index + 3)),
  ];
  const reader = transcriptReader(durable);
  const { bootstrap, state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: durable.length - 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 512 * 1024,
    projection: 'owner',
  });

  assert.deepEqual(
    bootstrap.durable.fragments.map((fragment) => fragment.kind === 'durable' && fragment.sequence),
    Array.from({ length: 254 }, (_, index) => 256 - index),
  );
  assert.equal(bootstrap.durable.rangeBoundarySequence, 3);
  assert.equal(bootstrap.durable.protectedTurnSequence, 256);
  assert.ok(bootstrap.durable.nextCursor);

  const page = await readSessionTranscriptPage({
    reader,
    state,
    request: {
      subscriptionId: 'subscription-1',
      source: 'durable',
      direction: 'older',
      throughSequence: durable.length - 1,
      cursor: bootstrap.durable.nextCursor,
      anchorSequence: null,
      maxBytes: 512 * 1024,
    },
  });
  assert.deepEqual(
    page.fragments.map((fragment) => fragment.kind === 'durable' && fragment.sequence),
    [2, 1, 0],
  );
  assert.equal(page.rangeBoundarySequence, 0);
  assert.equal(page.protectedTurnSequence, 2);
});

test('admits a forward Turn exactly at the Host range message bound', async () => {
  for (const projection of ['owner', 'shared'] as const) {
    const durable: StoredMessage[] = [{ ...assistantMessage(0), turnId: 'turn-before' }];
    const reader = transcriptReader(durable);
    const subscriptionId = `subscription-${projection}`;
    const { state } = await createSessionTranscriptBootstrap({
      reader,
      sessionId: 'session-1',
      subscriptionId,
      throughSequence: 0,
      rootTurn: null,
      activeAssistantStreams: [],
      maxBytes: 16 * 1024,
      projection,
    });
    durable.push(
      ...Array.from({ length: 256 }, (_, index) => ({
        ...assistantMessage(index + 1),
        turnId: 'turn-page',
      })),
      { ...assistantMessage(257), turnId: 'turn-after' },
    );
    assert.equal(updateSubscriberTranscriptHighWater(state, durable.length - 1), true);

    const page = await readSessionTranscriptPage({
      reader,
      state,
      request: {
        subscriptionId,
        source: 'durable',
        direction: 'newer',
        throughSequence: durable.length - 1,
        cursor: null,
        anchorSequence: 0,
        maxBytes: 512 * 1024,
      },
    });

    assert.equal(page.rangeBoundarySequence, 256);
    assert.equal(page.protectedTurnSequence, 256);
    assert.ok(page.nextCursor);
  }
});

test('defers a partial forward edge Turn to the next complete range', async () => {
  for (const projection of ['owner', 'shared'] as const) {
    const durable: StoredMessage[] = [{ ...assistantMessage(0), turnId: 'turn-before' }];
    const reader = transcriptReader(durable);
    const subscriptionId = `subscription-${projection}`;
    const { state } = await createSessionTranscriptBootstrap({
      reader,
      sessionId: 'session-1',
      subscriptionId,
      throughSequence: 0,
      rootTurn: null,
      activeAssistantStreams: [],
      maxBytes: 16 * 1024,
      projection,
    });
    durable.push(
      ...Array.from({ length: 254 }, (_, index) => assistantMessage(index + 1)),
      ...Array.from({ length: 3 }, (_, index) => ({
        ...assistantMessage(index + 255),
        turnId: 'turn-far-edge',
      })),
    );
    assert.equal(updateSubscriberTranscriptHighWater(state, durable.length - 1), true);

    const first = await readSessionTranscriptPage({
      reader,
      state,
      request: {
        subscriptionId,
        source: 'durable',
        direction: 'newer',
        throughSequence: durable.length - 1,
        cursor: null,
        anchorSequence: 0,
        maxBytes: 512 * 1024,
      },
    });
    assert.deepEqual(
      first.fragments.map((fragment) => fragment.kind === 'durable' && fragment.sequence),
      Array.from({ length: 254 }, (_, index) => index + 1),
    );
    assert.equal(first.rangeBoundarySequence, 254);
    assert.equal(first.protectedTurnSequence, 254);
    assert.ok(first.nextCursor);

    const second = await readSessionTranscriptPage({
      reader,
      state,
      request: {
        subscriptionId,
        source: 'durable',
        direction: 'newer',
        throughSequence: durable.length - 1,
        cursor: first.nextCursor,
        anchorSequence: null,
        maxBytes: 512 * 1024,
      },
    });
    assert.deepEqual(
      second.fragments.map((fragment) => fragment.kind === 'durable' && fragment.sequence),
      [255, 256, 257],
    );
    assert.equal(second.rangeBoundarySequence, 257);
    assert.equal(second.protectedTurnSequence, 257);
  }
});

test('protects the latest Turn when a forward page ends in a session note', async () => {
  const durable: StoredMessage[] = [{ ...assistantMessage(0), turnId: 'turn-before' }];
  const reader = transcriptReader(durable);
  const { state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 0,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    projection: 'owner',
  });
  durable.push(
    { ...assistantMessage(1), turnId: 'turn-latest' },
    { type: 'system_note', id: 'mode-change-2', ts: 3, kind: 'mode_change' },
  );
  assert.equal(updateSubscriberTranscriptHighWater(state, 2), true);

  const page = await readSessionTranscriptPage({
    reader,
    state,
    request: {
      subscriptionId: 'subscription-1',
      source: 'durable',
      direction: 'newer',
      throughSequence: 2,
      cursor: null,
      anchorSequence: 0,
      maxBytes: 512 * 1024,
    },
  });

  assert.equal(page.rangeBoundarySequence, 2);
  assert.equal(page.protectedTurnSequence, 1);
});

test('shared paging skips a full hidden storage batch before a visible message', async () => {
  const hidden = Array.from(
    { length: 257 },
    (_, index): StoredMessage => ({
      type: 'permission_decision',
      id: `permission-${index}`,
      turnId: `turn-${index}`,
      ts: index + 1,
      toolUseId: `tool-${index}`,
      toolName: 'write_file',
      decision: 'allow',
    }),
  );
  const visible = userMessage(hidden.length, 'visible');
  const { bootstrap } = await createSessionTranscriptBootstrap({
    reader: transcriptReader([...hidden, visible]),
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: hidden.length,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    projection: 'shared',
  });

  assert.deepEqual(
    decodeBootstrap(bootstrap.durable).map(({ id }) => id),
    [visible.id],
  );
  assert.equal(bootstrap.durable.nextCursor, null);
});

test('shared range edges cross a hidden storage batch between visible messages', async () => {
  const durable: StoredMessage[] = [
    userMessage(0, 'before'),
    ...Array.from(
      { length: 257 },
      (_, index): StoredMessage => ({
        type: 'permission_decision',
        id: `permission-between-${index}`,
        turnId: `turn-hidden-${index}`,
        ts: index + 2,
        toolUseId: `tool-between-${index}`,
        toolName: 'write_file',
        decision: 'allow',
      }),
    ),
    userMessage(258, 'after'),
  ];
  const reader = transcriptReader(durable);
  const { bootstrap, state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: durable.length - 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    projection: 'shared',
  });

  assert.equal(bootstrap.durable.rangeBoundarySequence, 0);
  assert.equal(bootstrap.durable.protectedTurnSequence, 258);

  const forward = await readSessionTranscriptPage({
    reader,
    state,
    request: {
      subscriptionId: 'subscription-1',
      source: 'durable',
      direction: 'newer',
      throughSequence: durable.length - 1,
      cursor: null,
      anchorSequence: null,
      maxBytes: 512 * 1024,
    },
  });
  assert.equal(forward.rangeBoundarySequence, 258);
  assert.equal(forward.protectedTurnSequence, 258);
});

test('shrinks the raw bootstrap until it fits its aggregate encoded budget', async () => {
  const durable = Array.from({ length: 100 }, (_, index) => userMessage(index, `message-${index}`));
  const { bootstrap } = await createSessionTranscriptBootstrap({
    reader: transcriptReader(durable),
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: durable.length - 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    maxEncodedBytes: 4 * 1024,
    projection: 'owner',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bootstrap), 'utf8') <= 4 * 1024);
  assert.ok(bootstrap.durable.nextCursor);
});

test('rejects an active overlay that exceeds its retained message bound', async () => {
  const overlay = Array.from({ length: 4_097 }, (_, index) => userMessage(index));
  await assert.rejects(
    prepareSessionTranscriptOverlay({
      reader: transcriptReader([], overlay),
      sessionId: 'session-1',
      throughSequence: null,
      rootTurn: null,
      activeAssistantStreams: [],
    }),
    /overlay exceeds its message limit/,
  );
});

test('delegates one deduplicated and bounded durable reconciliation request', async () => {
  const messages = Array.from({ length: 257 }, (_, index) => assistantMessage(index));
  const requests: Parameters<SessionTranscriptReader['readDurableMessagesById']>[1][] = [];
  const base = transcriptReader(messages, messages);
  const reader: SessionTranscriptReader = {
    ...base,
    readDurableMessagesById: async (_sessionId, request) => {
      requests.push(request);
      return messages.filter((message) => request.messageIds.includes(message.id));
    },
  };
  const activeAssistantStreams = messages.flatMap((message, index) => [
    {
      turnId: message.turnId,
      messageId: message.id,
      kind: 'text' as const,
      text: message.text,
    },
    ...(index === 0
      ? [
          {
            turnId: message.turnId,
            messageId: message.id,
            kind: 'thinking' as const,
            text: message.thinking!.text,
          },
        ]
      : []),
  ]);

  const overlay = await prepareSessionTranscriptOverlay({
    reader,
    sessionId: 'session-1',
    throughSequence: 256,
    rootTurn: null,
    activeAssistantStreams,
  });

  assert.equal(overlay.length, 257);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.messageIds.length, 257);
  assert.equal(new Set(requests[0]?.messageIds).size, 257);
  assert.equal(requests[0]?.throughSequence, 256);
  assert.equal(requests[0]?.maxMessages, 4_096);
  assert.equal(requests[0]?.maxBytes, 16 * 1024 * 1024);
});

function userMessage(index: number, text = `message-${index}`): StoredMessage {
  return {
    type: 'user',
    id: `message-${index}`,
    turnId: `turn-${index}`,
    ts: index + 1,
    text,
  };
}

function assistantMessage(index: number): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id: `message-${index}`,
    turnId: `turn-${index}`,
    ts: index + 1,
    modelId: 'model-1',
    text: `message-${index}`,
    thinking: { text: `thinking-${index}`, signature: '' },
  };
}

function decodeBootstrap(
  page: Awaited<ReturnType<typeof createSessionTranscriptBootstrap>>['bootstrap']['durable'],
): Array<Record<string, unknown>> {
  return page.fragments.map((fragment) =>
    JSON.parse(Buffer.from(fragment.data, 'base64').toString('utf8')),
  );
}
