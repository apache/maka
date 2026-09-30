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
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { IpcHandler } from '../../main/ipc-reconnect-policy.js';
import { registerRuntimeHostRecallIpc } from '../runtime-host-recall-ipc-main.js';

/**
 * The recall IPC is a relay: the scan happens in the Host, so this layer only
 * forwards the request, bounds the wait, and relays the envelope. What is
 * worth pinning is therefore the relay's own behavior — what it refuses, what
 * it answers when the Host is gone, and that an abandoned request stops being
 * ours to wait on.
 */

type RecallClient = Parameters<typeof registerRuntimeHostRecallIpc>[0]['client'];

function successEnvelope(passages: readonly unknown[] = []): unknown {
  return {
    ok: true,
    result: { ok: true, passages, gaps: 'Searched 1 Session(s).', searchedEverySession: true },
  };
}

function register(client: RecallClient) {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostRecallIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client,
  });
  const handler = handlers.get('search:recall');
  const cancel = handlers.get('search:recall:cancel');
  assert.ok(handler, 'search:recall must be registered');
  assert.ok(cancel, 'search:recall:cancel must be registered');
  return { handler, cancel };
}

/**
 * An IPC event stand-in. The handler reads `event.sender` and subscribes to
 * its lifecycle, so the stub is an object carrying a sender that records the
 * listeners the handler attaches and can fire them.
 */
function ipcEvent(): { event: unknown; emit(event: string): void } {
  const listeners = new Map<string, (() => void)[]>();
  const sender = {
    once(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    removeListener(event: string, listener: () => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((it) => it !== listener));
    },
  };
  return {
    event: { sender },
    emit(event: string) {
      listeners.get(event)?.forEach((listener) => listener());
    },
  };
}

test('relays the Host envelope unchanged, including the navigation coordinate', async () => {
  const passage = {
    sessionId: 'session-1',
    sessionTitle: 'deploy notes',
    anchorMessageId: 'message-7',
    sequence: 7,
    messages: [],
    matchedTerms: ['deploy'],
    score: 1,
  };
  const seen: unknown[] = [];
  const { handler } = register({
    queryRecall: async (input: never) => {
      seen.push(input);
      return successEnvelope([passage]) as never;
    },
  });
  const { event } = ipcEvent();
  const response = (await handler(
    event as never,
    { terms: ['deploy'], limit: 5 },
    'request-1',
  )) as { ok: true; result: { passages: { sequence: number }[] } };
  assert.deepEqual(seen, [{ terms: ['deploy'], limit: 5 }]);
  assert.equal(response.ok, true);
  assert.equal(response.result.passages[0]?.sequence, 7);
});

test('refuses a malformed request identity without asking the Host', async () => {
  let asked = 0;
  const { handler } = register({
    queryRecall: async () => {
      asked += 1;
      return successEnvelope() as never;
    },
  });
  const { event } = ipcEvent();
  for (const requestId of ['', 'x'.repeat(129)]) {
    assert.deepEqual(await handler(event as never, { terms: ['a'] }, requestId), {
      ok: false,
      reason: 'invalid_query',
      message: 'Invalid search request identity.',
    });
  }
  assert.equal(asked, 0, 'an unroutable request must not reach the Host');
});

test('an unavailable Host answers a search failure rather than throwing', async () => {
  const { handler } = register({
    queryRecall: async () => {
      throw new Error('Host is not connected');
    },
  });
  const { event } = ipcEvent();
  assert.deepEqual(await handler(event as never, { terms: ['deploy'] }, 'request-1'), {
    ok: false,
    reason: 'provider_error',
    message: 'Runtime Host is unavailable for search',
  });
});

test('a cancellation abandons the wait and reports it as aborted', async () => {
  const { handler, cancel } = register({
    // The Host owns the scan; this side only stops waiting on it.
    queryRecall: () => new Promise<never>(() => {}),
  });
  const { event } = ipcEvent();
  const task = handler(event as never, { terms: ['deploy'] }, 'request-1');
  await cancel(event as never, 'request-1');
  assert.deepEqual(await task, {
    ok: false,
    reason: 'aborted',
    message: 'History search was aborted.',
  });
});

test('a renderer that goes away stops its in-flight search', async () => {
  const { handler } = register({
    queryRecall: () => new Promise<never>(() => {}),
  });
  const { event, emit: fire } = ipcEvent();
  const task = handler(event as never, { terms: ['deploy'] }, 'request-1');
  fire('render-process-gone');
  assert.deepEqual(await task, {
    ok: false,
    reason: 'aborted',
    message: 'History search was aborted.',
  });
});

test('a superseded request on one sender is cancelled before the new one runs', async () => {
  const cancelled: string[] = [];
  const { handler } = register({
    queryRecall: () => new Promise<never>(() => {}),
  });
  const { event } = ipcEvent();
  const first = handler(event as never, { terms: ['old'] }, 'same-id');
  const second = handler(event as never, { terms: ['new'] }, 'same-id');
  // The first request is replaced in the pending map, so it must observe the
  // rejection rather than hanging forever.
  assert.deepEqual(await first, {
    ok: false,
    reason: 'aborted',
    message: 'History search was aborted.',
  });
  assert.deepEqual(cancelled, []);
  void second;
});

test('a request without an identity is still answered', async () => {
  const reached = deferred<void>();
  const { handler } = register({
    queryRecall: async () => {
      reached.resolve();
      return successEnvelope() as never;
    },
  });
  const { event } = ipcEvent();
  const response = await handler(event as never, { terms: ['deploy'] });
  await reached.promise;
  assert.equal((response as { ok?: unknown }).ok, true);
});
