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
/**
 * #4695: the Composer shows a Plan (or other setting) change as soon as it is
 * requested, while the Host admits a turn under the committed value. A send
 * into an existing Session must wait for that write, and must not submit at
 * all when it did not commit.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TransientUserMessageProjection } from '@maka/ui';
import { createChatActions } from '../../renderer/features/conversation/testing.js';

import {
  createActionsDeps,
  EMPTY_SKILL_INVOCATION,
  installWindow,
} from './app-shell-chat-actions-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('#4695 send waits for in-flight session settings', () => {
  it('submits only after a delayed Plan write commits', async () => {
    const settings = deferred<boolean>();
    const submitted: string[] = [];
    const restoreWindow = installWindow({ sessions: {
      submitMessage: async (sessionId: string) => {
        submitted.push(sessionId);
        return { ok: true, disposition: 'turn_started', attachments: [], inlineReferences: [], skillInvocation: EMPTY_SKILL_INVOCATION };
      },
    } });
    try {
      const awaited: string[] = [];
      const actions = createChatActions({
        ...createActionsDeps(), activeIdRef: { current: 'session-a' },
        awaitSessionSettings: (sessionId) => {
          awaited.push(sessionId);
          return settings.promise;
        },
      });
      const sending = actions.send('start by submitting a plan');
      await flush();
      assert.deepEqual(awaited, ['session-a']);
      assert.deepEqual(submitted, [], 'the turn must not be admitted before Plan commits');

      settings.resolve(true);
      assert.equal(await sending, true);
      assert.deepEqual(submitted, ['session-a']);
    } finally { restoreWindow(); }
  });

  it('keeps the draft and submits nothing when the setting write fails', async () => {
    const transient = new Map<string, TransientUserMessageProjection>();
    let submitCount = 0;
    const restoreWindow = installWindow({ sessions: {
      submitMessage: async () => {
        submitCount += 1;
        return { ok: true, disposition: 'turn_started', attachments: [], inlineReferences: [], skillInvocation: EMPTY_SKILL_INVOCATION };
      },
    } });
    try {
      const actions = createChatActions({
        ...createActionsDeps(), activeIdRef: { current: 'session-a' },
        awaitSessionSettings: async () => false,
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
      });
      assert.equal(await actions.send('start by submitting a plan'), false);
      assert.equal(submitCount, 0);
      assert.equal(transient.size, 0, 'no optimistic row for a send that never left');
    } finally { restoreWindow(); }
  });

  it('drops the send when the user leaves the Session while the write is in flight', async () => {
    const settings = deferred<boolean>();
    let submitCount = 0;
    let ownerActive = true;
    const restoreWindow = installWindow({ sessions: {
      submitMessage: async () => {
        submitCount += 1;
        return { ok: true, disposition: 'turn_started', attachments: [], inlineReferences: [], skillInvocation: EMPTY_SKILL_INVOCATION };
      },
    } });
    try {
      const actions = createChatActions({
        ...createActionsDeps(), activeIdRef: { current: 'session-a' },
        awaitSessionSettings: () => settings.promise,
        isShellSurfaceOwnerActive: () => ownerActive,
      });
      const sending = actions.send('start by submitting a plan');
      await flush();
      ownerActive = false;
      settings.resolve(true);
      assert.equal(await sending, false);
      assert.equal(submitCount, 0);
    } finally { restoreWindow(); }
  });
});
