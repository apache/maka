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
import type { SessionManager } from '@maka/runtime/session-manager';
import { readRuntimeHostHistoryMessages } from '../server/tool-composition.js';

test('history message reads fail closed when unavailable or aborted', async () => {
  const messages = [{ role: 'user', content: 'hello' }];
  const manager = {
    getMessages: async () => messages,
  } as unknown as Pick<SessionManager, 'getMessages'>;
  assert.equal(await readRuntimeHostHistoryMessages(() => manager, 'session'), messages);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await readRuntimeHostHistoryMessages(() => manager, 'session', aborted.signal),
    null,
  );

  const unavailable = {
    getMessages: async () => {
      throw new Error('unavailable');
    },
  } as unknown as Pick<SessionManager, 'getMessages'>;
  assert.equal(await readRuntimeHostHistoryMessages(() => unavailable, 'session'), null);
});

test('history cancellation is checked before acquiring a manager and acquisition errors reject asynchronously', async () => {
  const failure = new Error('SessionManager is not composed');
  let acquisitions = 0;
  const getManager = () => {
    acquisitions += 1;
    throw failure;
  };
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await readRuntimeHostHistoryMessages(getManager, 'session', aborted.signal), null);
  assert.equal(acquisitions, 0);
  let read: ReturnType<typeof readRuntimeHostHistoryMessages> | undefined;
  assert.doesNotThrow(() => {
    read = readRuntimeHostHistoryMessages(getManager, 'session');
  });
  assert.ok(read instanceof Promise);
  await assert.rejects(read, (error: unknown) => error === failure);
  assert.equal(acquisitions, 1);
});

test('history cancellation during a pending read discards the completed messages', async () => {
  const abort = new AbortController();
  const messages = [{ role: 'user', content: 'hello' }];
  const manager = {
    getMessages: async () => {
      abort.abort();
      return messages;
    },
  } as unknown as Pick<SessionManager, 'getMessages'>;
  assert.equal(await readRuntimeHostHistoryMessages(() => manager, 'session', abort.signal), null);
});
