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
import { createDefaultSettings } from '@maka/core/settings';
import {
  clientOwnedSettingsPatch,
  hasRuntimeHostSettingsPatch,
  projectClientOwnedSettings,
} from '../../shared/settings-ownership.js';

test('keeps the WorkHub opt-in client-global across Runtime Hosts', () => {
  assert.deepEqual(clientOwnedSettingsPatch({ workHub: { enabled: true } }), {
    workHub: { enabled: true },
  });
  assert.equal(hasRuntimeHostSettingsPatch({ workHub: { enabled: true } }), false);

  const client = createDefaultSettings();
  client.workHub.enabled = true;
  const runtimeHost = createDefaultSettings();
  assert.equal(projectClientOwnedSettings(runtimeHost, client).workHub.enabled, true);
});
