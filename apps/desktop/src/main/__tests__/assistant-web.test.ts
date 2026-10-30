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
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markPersisted } from '@maka/core/persisted-value';
import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import { ClientSessionSubscription } from '../../../../../packages/runtime-host/dist/client/session-subscription.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
  updateSubscriberTranscriptHighWater,
} from '../../../../../packages/runtime-host/dist/server/session-transcript-pager.js';
import { openTranscriptLedger } from './transcript-ledger-test-fixture.js';
import type {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostSession,
} from '../runtime-host-client.js';
import {
  createAssistantWebBackend,
  visibleWebMessage,
  type AssistantWebBackend,
} from '../assistant-web-backend.js';
import { startAssistantWebServer } from '../assistant-web-server.js';

const user = (id: string): StoredMessage => ({
  type: 'user',
  id,
  turnId: id,
  text: `消息 ${id}`,
  ts: 1,
});
const assistant = (id: string): StoredMessage => ({
  type: 'assistant',
  id,
  turnId: id,
  text: `回复 ${id}`,
  summary: '**摘要**',
  ts: 2,
  modelId: 'fixture',
});

test('projects only visible conversation and retains displayText and authored summaries', () => {
  assert.equal(
    visibleWebMessage({ ...user('u'), displayText: '实际输入' } as StoredMessage, 1)?.text,
    '实际输入',
  );
  assert.equal(visibleWebMessage(assistant('a'), 2)?.summary, '**摘要**');
  assert.equal(visibleWebMessage({ type: 'tool_call', id: 'tool' } as StoredMessage, 3), undefined);
  assert.equal(
    visibleWebMessage(
      { ...user('system'), origin: { kind: 'schedule' } } as unknown as StoredMessage,
      4,
    ),
    undefined,
  );
});

test('real ledger paging freezes history, fills a gap, and shares cursors without model calls', async () => {
  const source = Array.from({ length: 300 }, (_, i) => user(`user-${i}`));
  source.push(assistant('later'));
  const ledger = await openTranscriptLedger(source);
  let through = await ledger.appendThrough('user-299');
  let enabled = true;
  let opens = 0;
  const submissions: unknown[] = [];
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6uAAAAABJRU5ErkJggg==',
    'base64',
  );
  const imageId = createHash('sha256').update(bytes).digest('hex');
  const imageData = bytes.toString('base64');
  let useImage = false;
  let imageReads = 0;
  const subscriptions: ClientSessionSubscription[] = [];
  const client = {
    rootId: 'root-web',
    request: async (
      _: string,
      input: { method: string; input: { id?: string; offset?: number } },
    ) => {
      if (input.method === 'assistant.enablement') return { value: { enabled } };
      if (input.method === 'assistant.avatar')
        return {
          value: {
            avatar: useImage
              ? {
                  background: '#E5EDFF',
                  image: { id: imageId, mimeType: 'image/png', length: imageData.length },
                }
              : { emoji: '🦊', background: '#E5EDFF' },
          },
        };
      if (input.method === 'assistant.avatar-image') {
        imageReads++;
        const offset = input.input.offset!;
        return {
          value: { id: input.input.id, offset, data: imageData.slice(offset, offset + 17) },
        };
      }
      return { value: { state: { sessionId: ledger.sessionId }, bot: { working: true } } };
    },
    submitMessage: async (input: unknown) => {
      submissions.push(input);
      return { disposition: 'inbox' };
    },
    openSession: async (): Promise<DesktopRuntimeHostSession> => {
      opens++;
      const subscriptionId = `web-${opens}`;
      const opened = await createSessionTranscriptBootstrap({
        reader: ledger.reader,
        sessionId: ledger.sessionId,
        subscriptionId,
        throughSequence: through,
        maxBytes: 16384,
        projection: 'owner',
      });
      const subscription = new ClientSessionSubscription(
        {
          hostEpoch: 'host-web',
          subscriptionId,
          nextSequence: 1,
          activeAssistantStreams: [],
          transcript: opened.bootstrap,
          snapshot: {
            schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
            session: {
              sessionId: ledger.sessionId,
              metadataRevision: 1,
              status: 'active',
              createdAt: 1,
              isArchived: false,
            },
            projectionRevision: 1,
            rootTurn: null,
            goal: null,
            queue: { hostEpoch: 'host-web', queueRevision: 0, steering: [], followup: [] },
            interactions: { pending: [] },
          },
        },
        async () => undefined,
        (request) =>
          readSessionTranscriptPage({ reader: ledger.reader, state: opened.state, request }),
        async () => undefined,
      );
      subscriptions.push(subscription);
      return {
        hostEpoch: 'host-web',
        subscriptionId,
        snapshot: subscription.snapshot,
        activeAssistantStreams: [],
        transcriptBootstrap: opened.bootstrap,
        get transcriptWatermark() {
          return through;
        },
        deathCause: undefined,
        events: subscription,
        ready: () => subscription.ready(),
        close: () => subscription.close(),
        loadTranscript: async () => [],
        loadTranscriptPage: (input) => {
          if (through !== null) updateSubscriberTranscriptHighWater(opened.state, through);
          return subscription.loadTranscriptPage(input);
        },
        decodeTranscriptPage: (page) =>
          subscription.decodeTranscriptPage(page, (v) =>
            decodeStoredMessage(markPersisted<StoredMessage>(v)),
          ),
      };
    },
  } as unknown as DesktopRuntimeHostClient;
  const backend = createAssistantWebBackend(() => client);
  try {
    const [state] = await Promise.all([backend.state(), backend.state(), backend.state()]);
    assert.equal(state.working, true);
    assert.equal(state.avatar.emoji, '🦊');
    useImage = true;
    assert.match((await backend.state()).avatar.imageUrl!, new RegExp(imageId));
    const [imageA, imageB] = await Promise.all([
      backend.avatarImage(state.conversationId, imageId),
      backend.avatarImage(state.conversationId, imageId),
    ]);
    assert.deepEqual(imageA.bytes, bytes);
    assert.deepEqual(imageB.bytes, bytes);
    assert.equal(
      imageReads,
      Math.ceil(imageData.length / 17),
      'concurrent image reads reuse one transfer',
    );
    await assert.rejects(backend.avatarImage('other-host', imageId), /会话已变更/);
    useImage = false;
    await assert.rejects(backend.avatarImage(state.conversationId, imageId), /头像已变更/);
    assert.equal((await backend.state()).avatar.emoji, '🦊');
    const first = await backend.history(new URLSearchParams());
    assert.ok(first.next);
    through = await ledger.appendThrough('later');
    for (const sub of subscriptions)
      sub.accept({
        kind: 'subscription.transcript_advanced',
        hostEpoch: 'host-web',
        subscriptionId: sub.subscriptionId,
        sequence: 1,
        sessionId: ledger.sessionId,
        throughSequence: through!,
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const all = [...first.messages];
    let next: string | null = first.next;
    while (next) {
      const page = await backend.history(new URLSearchParams({ cursor: next }));
      all.push(...page.messages);
      next = page.next;
    }
    assert.equal(new Set(all.map((m) => m.id)).size, 300);
    assert.ok(!all.some((m) => m.id === 'later'));
    const caught = await backend.history(
      new URLSearchParams({ after: String(first.through), conversationId: state.conversationId }),
    );
    assert.deepEqual(
      caught.messages.map((m) => m.id),
      ['later'],
    );
    assert.equal(opens, 1, 'cursors stay on the subscription that signed them');
    assert.equal(submissions.length, 0);
    const input = { conversationId: state.conversationId, id: 'web-stable-id-1234', text: '你好' };
    await backend.send(input);
    await backend.send(input);
    assert.deepEqual(submissions[0], submissions[1]);
    await assert.rejects(backend.send({ ...input, conversationId: 'other-host' }), /会话已变更/);
    await assert.rejects(
      backend.history(new URLSearchParams({ cursor: first.next! + 'x' })),
      /游标已失效/,
    );
    subscriptions[0]!.finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await backend.state()).conversationId, state.conversationId);
    assert.equal(opens, 2, 'reconnect opens exactly one new subscription');
    await assert.rejects(
      backend.history(new URLSearchParams({ cursor: first.next! })),
      /会话已变更/,
    );
    enabled = false;
    await assert.rejects(backend.history(new URLSearchParams()), /启用个人助手/);
    await assert.rejects(backend.send(input), /启用个人助手/);
    assert.equal(submissions.length, 2);
  } finally {
    await backend.close();
    await Promise.all(subscriptions.map((s) => s.close()));
    await ledger.close();
  }
});

test('HTTP serves app, validates messages, streams state, and closes live connections', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'maka-web-'));
  await writeFile(join(assets, 'index.html'), '<h1>Maka</h1>');
  const sent: unknown[] = [];
  let closed = false;
  const cardCalls: unknown[] = [];
  const backend: AssistantWebBackend = {
    cardAction: async input => { cardCalls.push(input); return { selectedKey: input.actionKey ?? null }; },
    state: async () => ({
      conversationId: 'owner',
      working: true,
      revision: 3,
      avatar: { emoji: '🦊', background: '#E5EDFF' },
    }),
    avatarImage: async () => ({ bytes: Buffer.from('image'), mimeType: 'image/png' }),
    history: async () => ({ conversationId: 'owner', messages: [], next: null, through: 3 }),
    send: async (input) => {
      sent.push(input);
    },
    close: async () => {
      closed = true;
    },
  };
  const server = await startAssistantWebServer({
    backend,
    assets,
    port: 0,
    publicOrigin: 'https://assistant.example',
  });
  const url = `http://127.0.0.1:${server.port}`;
  const rawRequest = (host: string, origin?: string, path = '/api/history') => new Promise<number>((resolve, reject) => {
    const req = request(`${url}${path}`, { headers: { Host: host, ...(origin ? { Origin: origin } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    for (const path of ['/api/history', '/api/events', '/api/avatar', '/api/messages', '/api/card-action', '/']) {
      assert.equal(await rawRequest(`attacker.example:${server.port}`, `http://attacker.example:${server.port}`, path), 403);
      assert.equal(await rawRequest(`attacker.example:${server.port}`, undefined, path), 403);
    }
    assert.equal(await rawRequest('assistant.example', 'https://assistant.example'), 200);
    assert.equal(await rawRequest(`localhost:${server.port}`, `http://localhost:${server.port}`), 200);
    assert.equal(await rawRequest(`localhost:${server.port + 1}`), 403);
    assert.equal(await rawRequest(`127.0.0.1:${server.port}`, 'null'), 403);
    await assert.rejects(startAssistantWebServer({backend, assets, port: 0, host: '0.0.0.0'}), /loopback/);
    await assert.rejects(startAssistantWebServer({backend, assets, port: 0, host: '192.168.1.5', publicOrigin: 'https://assistant.example'}), /loopback/);
    assert.match(await (await fetch(url)).text(), /Maka/);
    const imageResponse = await fetch(url + '/api/avatar?conversationId=owner&id=image');
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.equal(await imageResponse.text(), 'image');
    assert.equal((await fetch(url + '/api/history')).status, 200);
    assert.equal(
      (
        await fetch(url + '/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + '/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'null',
        })
      ).status,
      400,
    );
    const input = { conversationId: 'owner', id: 'web-message-123456', text: '中文消息 👋' };
    assert.equal(
      (
        await fetch(url + '/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).status,
      200,
    );
    assert.deepEqual(sent, [input]);
    const choice = { conversationId: 'owner', cardId: 'card-1', actionKey: '0:1' };
    const chosen = await fetch(url + '/api/card-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice) });
    assert.equal(chosen.status, 200);
    assert.deepEqual(await chosen.json(), { selectedKey: '0:1' });
    assert.deepEqual(cardCalls, [choice]);
    const invalidChoice = await fetch(url + '/api/card-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...choice, actionKey: 'invalid' }) });
    assert.equal(invalidChoice.status, 400);
    assert.equal(cardCalls.length, 1);
    const proxyInput = { ...input, id: 'web-proxy-message-123456' };
    assert.equal(
      (
        await fetch(url + '/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://assistant.example' },
          body: JSON.stringify(proxyInput),
        })
      ).status,
      200,
    );
    assert.deepEqual(sent, [input, proxyInput]);
    assert.equal(
      (
        await fetch(url + '/api/history', {
          headers: {
            Origin: 'https://elsewhere.example',
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'elsewhere.example',
          },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url + '/api/arbitrary-runtime-command')).status, 404);
    const events = await fetch(url + '/api/events');
    const reader = events.body!.getReader();
    let text = '';
    while (!text.includes('"working":true'))
      text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"conversationId":"owner"/);
    await reader.cancel();
  } finally {
    await server.close();
    await rm(assets, { recursive: true, force: true });
  }
  assert.ok(closed);
});

 test('web history preserves structured assistant cards', () => {
 const card = { type: 'offer' as const, title: '报销', items: [{ title: '整理材料' }] };
 assert.deepEqual(visibleWebMessage({ ...assistant('card'), card } as StoredMessage, 3)?.card, card);
 });
