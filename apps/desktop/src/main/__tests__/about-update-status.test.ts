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
import {
  aboutChannelBadge,
} from '../../renderer/settings/about-update-status.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

const copy = getSettingsPreferencesCopy('zh').about;

test('a packaged nightly build is labelled Nightly, never 正式版', () => {
  const badge = aboutChannelBadge(
    { buildMode: 'packaged', buildCommit: null, updateChannel: 'nightly' },
    copy,
  );
  assert.deepEqual(badge, {
    label: 'Nightly',
    variant: 'orange',
    channelName: 'Nightly',
  });
});

test('a packaged release build keeps the release pill', () => {
  const badge = aboutChannelBadge(
    { buildMode: 'packaged', buildCommit: null, updateChannel: 'release' },
    copy,
  );
  assert.deepEqual(badge, {
    label: '正式版',
    variant: 'blue',
    channelName: '正式版',
  });
});

test('a dev checkout carries its commit on a neutral pill', () => {
  const withCommit = aboutChannelBadge(
    { buildMode: 'dev', buildCommit: 'abc1234', updateChannel: 'release' },
    copy,
  );
  assert.deepEqual(withCommit, {
    label: '本地开发版 · abc1234',
    variant: 'neutral',
    channelName: '本地开发版',
  });

  const withoutCommit = aboutChannelBadge(
    { buildMode: 'dev', buildCommit: null, updateChannel: 'nightly' },
    copy,
  );
  assert.deepEqual(withoutCommit, {
    label: '本地开发版',
    variant: 'neutral',
    channelName: '本地开发版',
  });
});