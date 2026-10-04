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
import { createStopAction } from '../../renderer/features/conversation/testing.js';
import { windowSubmissionServices } from './app-shell-chat-actions-fixture.js';

test('removes exactly the transient messages the Host retracts while stopping', async () => {
  const removed: Array<{ sessionId: string; messageId: string }> = [];
  const target = globalThis as unknown as { window?: unknown };
  const previousWindow = target.window;
  target.window = {
    maka: {
      sessions: {
        stop: async () => ({
          kind: 'interrupted',
          retractedMessageIds: ['message-1', 'message-2'],
        }),
      },
    },
  };
  try {
    const stop = createStopAction({
      services: windowSubmissionServices(),
      uiLocale: 'en',
      activeIdRef: { current: 'session-1' },
      stopPending: { claim: () => true, release: () => undefined },
      removeTransientMessage: (sessionId, messageId) => removed.push({ sessionId, messageId }),
      toastApi: { error() {} },
    });

    assert.equal(await stop(), 'interrupted');
    assert.deepEqual(removed, [
      { sessionId: 'session-1', messageId: 'message-1' },
      { sessionId: 'session-1', messageId: 'message-2' },
    ]);
  } finally {
    target.window = previousWindow;
  }
});

test('reports a thrown stop as failed after toasting it', async () => {
  const target = globalThis as unknown as { window?: unknown };
  const previousWindow = target.window;
  const errors: string[] = [];
  target.window = {
    maka: {
      sessions: {
        stop: async () => {
          throw new Error('stop failed');
        },
      },
    },
  };
  try {
    const stop = createStopAction({
      services: windowSubmissionServices(),
      uiLocale: 'en',
      activeIdRef: { current: 'session-1' },
      stopPending: { claim: () => true, release: () => undefined },
      removeTransientMessage: () => undefined,
      toastApi: {
        error(title) {
          errors.push(title);
        },
      },
    });

    assert.equal(await stop(), 'failed');
    assert.equal(errors.length, 1);
  } finally {
    target.window = previousWindow;
  }
});

test('reports a Host no-op stop as not_running when expectedTurnId is pinned', async () => {
  const target = globalThis as unknown as { window?: unknown };
  const previousWindow = target.window;
  const stopped: Array<{ sessionId: string; options: unknown }> = [];
  target.window = {
    maka: {
      sessions: {
        stop: async (sessionId: string, options?: unknown) => {
          stopped.push({ sessionId, options });
          // Host returns undefined when expectedTurnId no longer matches the
          // live root (settled or replaced by a newer turn).
          return undefined;
        },
      },
    },
  };
  try {
    const stop = createStopAction({
      services: windowSubmissionServices(),
      uiLocale: 'en',
      activeIdRef: { current: 'session-1' },
      stopPending: { claim: () => true, release: () => undefined },
      removeTransientMessage: () => undefined,
      toastApi: { error() {} },
    });

    assert.equal(await stop('session-1', 'turn-a'), 'not_running');
    assert.deepEqual(stopped, [
      {
        sessionId: 'session-1',
        options: { source: 'stop_button', expectedTurnId: 'turn-a' },
      },
    ]);
  } finally {
    target.window = previousWindow;
  }
});

test('stops the captured Session when the active id changes during the await', async () => {
  const target = globalThis as unknown as { window?: unknown };
  const previousWindow = target.window;
  const stopped: Array<{ sessionId: string; options: unknown }> = [];
  const activeIdRef = { current: 'session-a' as string | undefined };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  target.window = {
    maka: {
      sessions: {
        stop: async (sessionId: string, options?: unknown) => {
          stopped.push({ sessionId, options });
          await gate;
          return { kind: 'interrupted', retractedMessageIds: [] };
        },
      },
    },
  };
  try {
    const stop = createStopAction({
      services: windowSubmissionServices(),
      uiLocale: 'en',
      activeIdRef,
      stopPending: { claim: () => true, release: () => undefined },
      removeTransientMessage: () => undefined,
      toastApi: { error() {} },
    });

    const pending = stop('session-a', 'turn-1');
    activeIdRef.current = 'session-b';
    release();
    assert.equal(await pending, 'interrupted');
    assert.deepEqual(stopped, [
      { sessionId: 'session-a', options: { source: 'stop_button', expectedTurnId: 'turn-1' } },
    ]);
  } finally {
    target.window = previousWindow;
  }
});

test('a second stop for the same Session awaits the one in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hostCalls = 0;
  let held = false;
  const stop = createStopAction({
    services: {
      stop: async () => {
        hostCalls += 1;
        await gate;
        return { kind: 'interrupted', retractedMessageIds: [] };
      },
    },
    uiLocale: 'en',
    activeIdRef: { current: 'session-1' },
    stopPending: {
      claim: () => (held ? false : (held = true)),
      release: () => {
        held = false;
      },
    },
    removeTransientMessage: () => undefined,
    toastApi: { error() {} },
    inFlight: new Map(),
  });

  const first = stop('session-1');
  const second = stop('session-1', 'turn-1');
  release();
  assert.deepEqual(await Promise.all([first, second]), ['interrupted', 'interrupted']);
  assert.equal(hostCalls, 1);
});

test('reports busy when another owner holds the stop claim', async () => {
  let hostCalls = 0;
  const stop = createStopAction({
    services: {
      stop: async () => {
        hostCalls += 1;
        return undefined;
      },
    },
    uiLocale: 'en',
    activeIdRef: { current: 'session-1' },
    stopPending: { claim: () => false, release: () => undefined },
    removeTransientMessage: () => undefined,
    toastApi: { error() {} },
  });

  assert.equal(await stop('session-1'), 'busy');
  assert.equal(hostCalls, 0);
});
