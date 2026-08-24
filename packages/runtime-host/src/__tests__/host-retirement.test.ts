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
  ]);
});
