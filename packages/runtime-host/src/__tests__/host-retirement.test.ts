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
import type { RuntimeHostConnection } from '../client/connection.js';
import { prepareConnectedRuntimeHostRetirement } from '../client/host-retirement.js';

test('retirement binds both interruption policy choices to the authenticated Host epoch', async () => {
  const requests: unknown[] = [];
  const connection = {
    hostEpoch: 'authenticated-host',
    request: async (operation: string, input: unknown) => {
      requests.push({ operation, input });
      return { kind: 'prepared', pid: 42 };
    },
  } as unknown as RuntimeHostConnection;

  await prepareConnectedRuntimeHostRetirement(connection, 'refuse_active_work');
  await prepareConnectedRuntimeHostRetirement(connection, 'interrupt_active_work');
  await prepareConnectedRuntimeHostRetirement(
    { ...connection, cooperativeHandoff: true },
    'refuse_active_work',
  );

  assert.deepEqual(requests, [
    {
      operation: 'host.upgrade.prepare',
      input: {
        expectedHostEpoch: 'authenticated-host',
        allowInterruptActiveTasks: false,
      },
    },
    {
      operation: 'host.upgrade.prepare',
      input: {
        expectedHostEpoch: 'authenticated-host',
        allowInterruptActiveTasks: true,
      },
    },
    {
      operation: 'host.upgrade.prepare',
      input: {
        expectedHostEpoch: 'authenticated-host',
        allowInterruptActiveTasks: false,
        allowCooperativeHandoff: true,
      },
    },
  ]);
});

test('quit can require interruption consent instead of waiting for cooperative handoff', async () => {
  const connection = {
    hostEpoch: 'authenticated-host',
    cooperativeHandoff: true,
    request: async (operation: string, input: unknown, timeoutMs: number) => {
      assert.equal(operation, 'host.upgrade.prepare');
      assert.deepEqual(input, {
        expectedHostEpoch: 'authenticated-host',
        allowInterruptActiveTasks: false,
      });
      assert.equal(timeoutMs, 2_000);
      return { kind: 'active_tasks' };
    },
  } as unknown as RuntimeHostConnection;
  assert.deepEqual(
    await prepareConnectedRuntimeHostRetirement(
      connection,
      'refuse_active_work',
      2_000,
      undefined,
      { allowCooperativeHandoff: false },
    ),
    { kind: 'active_tasks' },
  );
});

test('cancelling preparation closes its connection and waits for the request to settle', async () => {
  const cancellation = new AbortController();
  let rejectRequest!: (error: Error) => void;
  let closed = false;
  let settled = false;
  const connection = {
    hostEpoch: 'source',
    cooperativeHandoff: true,
    request: () =>
      new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    close: async () => {
      closed = true;
    },
  } as unknown as RuntimeHostConnection;
  const result = prepareConnectedRuntimeHostRetirement(
    connection,
    'refuse_active_work',
    undefined,
    cancellation.signal,
  );
  const rejected = assert.rejects(result, /user cancelled/u).then(() => {
    settled = true;
  });
  cancellation.abort(new Error('user cancelled'));
  await Promise.resolve();
  assert.equal(closed, true);
  assert.equal(settled, false);
  rejectRequest(new Error('connection closed'));
  await rejected;
});
