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
import { connectRuntimeHostWslEnvironment } from '../client/wsl-environment.js';

test('passes WSL target values as literal argv to the absolute operator', async () => {
  const sentinel = new Error('stop after argv capture');
  let invocation: { readonly executable: string; readonly args: readonly string[] } | undefined;
  await assert.rejects(
    connectRuntimeHostWslEnvironment(
      {
        distribution: 'Ubuntu work; echo unsafe',
        operatorPath: "/opt/Maka operator's/bin/maka-operator",
        rootId: 'a'.repeat(64),
        clientInstanceId: 'desktop-test',
      },
      {
        wslExecutable: 'C:\\Windows\\System32\\wsl.exe',
        processFactory: (executable, args) => {
          invocation = { executable, args };
          throw sentinel;
        },
      },
    ),
    sentinel,
  );
  assert.deepEqual(invocation, {
    executable: 'C:\\Windows\\System32\\wsl.exe',
    args: [
      '--distribution',
      'Ubuntu work; echo unsafe',
      '--exec',
      "/opt/Maka operator's/bin/maka-operator",
      'connect',
      '--framed',
      '--root-id',
      'a'.repeat(64),
    ],
  });
});
