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
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './platform-helper.js';
test('release .maka-extension installs directly through latest main package loader', async (t) => {
  const f = await fixture({ bundle: resolve('release/proactive-matters.maka-extension') });
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  assert.equal((await f.platform.clientSnapshot()).entries.length, 1);
  const view = await f.invoke('MatterStart', {
    title: '安装包检查',
    request: '验证发布包能够登记当前会话',
  });
  assert.ok(view.activationId);
  assert.equal((await f.remote('matters.list')).matters.length, 1);
  await f.invoke('MatterControl', { action: 'cancel' });
  assert.equal((await f.remote('matters.list')).matters[0].status, 'cancelled');
});
