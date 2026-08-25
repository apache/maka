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
import { createAppShellStopAction } from '../../renderer/app-shell-stop-action.js';

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
    const stop = createAppShellStopAction({
      uiLocale: 'en',
      activeIdRef: { current: 'session-1' },
      addPendingSessionAction: () => true,
      clearPendingSessionAction: () => undefined,
      setStopPendingBySession: () => undefined,
      stopPendingRef: { current: new Set<string>() },
      removeTransientMessage: (sessionId, messageId) => removed.push({ sessionId, messageId }),
      toastApi: { error() {} },
    });

    await stop();

    assert.deepEqual(removed, [
      { sessionId: 'session-1', messageId: 'message-1' },
      { sessionId: 'session-1', messageId: 'message-2' },
    ]);
  } finally {
    target.window = previousWindow;
  }
});
