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
import { DesktopLocalHostRetirementError } from '../runtime-host-desktop-manager.js';
import { buildRuntimeHostQuitFailureDialog } from '../runtime-host-quit-copy.js';

const failure = new DesktopLocalHostRetirementError(
  {
    hostId: 'root-id',
    hostEpoch: 'host-epoch',
    lifecycleMode: 'ephemeral',
    rootPath: '/state/root',
    pid: 4242,
  },
  { cause: new Error('writer release timed out') },
);

for (const locale of ['en', 'zh'] as const) {
  test(`quit failure copy exposes actionable Host facts in ${locale}`, () => {
    const dialog = buildRuntimeHostQuitFailureDialog(failure, locale);

    assert.match(dialog.detail ?? '', /4242/);
    assert.match(dialog.detail ?? '', /host-epoch/);
    assert.match(dialog.detail ?? '', /\/state\/root/);
    assert.match(dialog.detail ?? '', /writer release timed out/);
  });
}

test('manual recovery copy names a cross-platform process-management concept', () => {
  const english = buildRuntimeHostQuitFailureDialog(failure, 'en').detail ?? '';
  const chinese = buildRuntimeHostQuitFailureDialog(failure, 'zh').detail ?? '';

  assert.match(english, /operating system's process-management tool/);
  assert.match(chinese, /操作系统的进程管理工具/);
  assert.doesNotMatch(`${english}\n${chinese}`, /Activity Monitor|Task Manager|活动监视器|任务管理器/);
});
