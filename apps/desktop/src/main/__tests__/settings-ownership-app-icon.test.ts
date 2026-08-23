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
import { clientOwnedSettingsPatch } from '../../shared/settings-ownership.js';

/**
 * The app icon is owned by the main process's icon seam, which serializes
 * selection against import and removal and refuses a choice whose artwork is
 * gone. A write arriving through the generic settings channel would queue
 * behind none of that, and a well-formed id landing between a removal's
 * settings apply and its file deletion would leave the setting naming artwork
 * that no longer exists.
 */
test('the generic settings channel cannot carry an app-icon choice', () => {
  const patch = clientOwnedSettingsPatch({
    appearance: { theme: 'dark', appIcon: `custom:${'a'.repeat(32)}` },
  });

  assert.deepEqual(patch.appearance, { theme: 'dark' });
});

test('an appearance patch that is only an icon drops out entirely', () => {
  // Nothing left to forward: the section would otherwise arrive empty and
  // still count as a write on the generic channel.
  assert.equal(clientOwnedSettingsPatch({ appearance: { appIcon: 'sky' } }).appearance, undefined);
});

test('the rest of appearance still travels', () => {
  const patch = clientOwnedSettingsPatch({ appearance: { theme: 'light', palette: 'nord' } });
  assert.deepEqual(patch.appearance, { theme: 'light', palette: 'nord' });
});
