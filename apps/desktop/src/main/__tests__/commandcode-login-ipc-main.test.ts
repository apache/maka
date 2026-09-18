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
import { describe, test } from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import {
  COMMANDCODE_LOGIN_IPC_CHANNELS,
  registerCommandCodeLoginIpc,
  type CommandCodeLoginIpcDeps,
} from '../commandcode-login-ipc-main.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const EVENT = {} as IpcMainInvokeEvent;

function harness() {
  const handlers = new Map<string, Handler>();
  const calls: unknown[][] = [];
  const controller: CommandCodeLoginIpcDeps['controller'] = {
    start: async (input) => {
      calls.push(['start', input]);
      return { ok: true, attemptId: 'a1', authUrl: 'https://commandcode.ai/x' };
    },
    complete: async (attemptId) => {
      calls.push(['complete', attemptId]);
      return { ok: false, reason: 'timeout' };
    },
    cancel: (attemptId) => {
      calls.push(['cancel', attemptId]);
    },
  };
  registerCommandCodeLoginIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      },
    } as unknown as CommandCodeLoginIpcDeps['ipcMain'],
    controller,
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler(EVENT, ...args);
  };
  return { handlers, calls, invoke };
}

describe('registerCommandCodeLoginIpc', () => {
  test('registers exactly the three shared channels', () => {
    const { handlers } = harness();
    assert.deepEqual(
      [...handlers.keys()].sort(),
      Object.values(COMMANDCODE_LOGIN_IPC_CHANNELS).sort(),
    );
  });

  test('start forwards only a well-formed baseUrl', async () => {
    const { calls, invoke } = harness();
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, {
      baseUrl: 'https://staging-api.commandcode.ai/provider/v1',
    });
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, { baseUrl: 42 });
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, { baseUrl: 'x'.repeat(5_000) });
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, 'not an object');
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, undefined);
    assert.deepEqual(calls, [
      ['start', { baseUrl: 'https://staging-api.commandcode.ai/provider/v1' }],
      ['start', {}],
      ['start', {}],
      ['start', {}],
      ['start', {}],
    ]);
  });

  test('complete requires a bounded attempt id and otherwise reports superseded', async () => {
    const { calls, invoke } = harness();
    assert.deepEqual(await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.complete, 'a1'), {
      ok: false,
      reason: 'timeout',
    });
    assert.deepEqual(await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.complete, 7), {
      ok: false,
      reason: 'superseded',
    });
    assert.deepEqual(await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.complete, ''), {
      ok: false,
      reason: 'superseded',
    });
    assert.deepEqual(calls, [['complete', 'a1']]);
  });

  test('cancel needs a well-formed attempt id; anything else is ignored', async () => {
    const { calls, invoke } = harness();
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, undefined);
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, 'a1');
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, { attemptId: 'a1' });
    assert.deepEqual(calls, [['cancel', 'a1']]);
  });
});
