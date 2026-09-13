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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { SETTINGS_SECTIONS } from '@maka/core/settings';
import type { DesktopRuntimeHostProfileSnapshot } from '../../preload/bridge-contract.js';
import {
  computerHistoryModelSettingsProfile,
  groupedNav,
  settingsSectionScope,
} from '../../renderer/settings/settings-nav.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import { useHistorySettingsFocus } from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('Computer History is a client-scoped Activity settings destination in every locale', () => {
  assert.ok(SETTINGS_SECTIONS.includes('computer-history'));
  assert.equal(settingsSectionScope('computer-history'), 'client');
  for (const [locale, label] of [
    ['en', 'Computer history'],
    ['zh-CN', '电脑历史'],
    ['zh-TW', '電腦歷史'],
  ] as const) {
    const item = groupedNav(locale).find((group) => group.group === 'activity')
      ?.items.find((entry) => entry.id === 'computer-history');
    assert.ok(item?.enabled);
    assert.equal(item.label, label);
    assert.ok(item.description);
    assert.equal(getShellCopy(locale).commandPalette.settingsSections['computer-history'], label);
  }
});

const CATALOG: DesktopRuntimeHostProfileSnapshot = {
  defaultProfileId: 'remote-selected',
  entries: [
    {
      profile: {
        id: 'remote-selected', name: 'Remote', kind: 'remote', rootId: 'remote-root',
        transport: { kind: 'tls', url: 'https://example.invalid' },
      },
      enabled: true, isDefault: true, readiness: 'ready', hostId: 'remote-host',
    },
    {
      profile: { id: 'local', name: 'Local', kind: 'local' },
      enabled: true, isDefault: false, readiness: 'ready', hostId: 'local-host',
    },
  ],
};
const VERIFIED = { phase: 'ready', isVerified: true, hasSnapshot: true } as const;

test('history model configuration selects only the verified catalog local profile', () => {
  assert.equal(computerHistoryModelSettingsProfile(CATALOG, VERIFIED), 'local');
  assert.equal(computerHistoryModelSettingsProfile(CATALOG, {
    ...VERIFIED, phase: 'loading', isVerified: false,
  }), undefined, 'cached catalog cannot grant a model settings target');
  assert.equal(computerHistoryModelSettingsProfile(CATALOG, {
    ...VERIFIED, phase: 'error',
  }), undefined, 'failed catalog refresh does not route');
  assert.equal(computerHistoryModelSettingsProfile(undefined, VERIFIED), undefined);
  assert.equal(computerHistoryModelSettingsProfile({
    ...CATALOG, entries: CATALOG.entries.filter((entry) => entry.profile.kind !== 'local'),
  }, VERIFIED), undefined, 'remote default is not a fallback');
  assert.equal(computerHistoryModelSettingsProfile({
    ...CATALOG, entries: CATALOG.entries.map((entry) => ({
      ...entry, enabled: entry.profile.kind !== 'local',
    })),
  }, VERIFIED), undefined);
  assert.equal(computerHistoryModelSettingsProfile({
    ...CATALOG, entries: CATALOG.entries.map((entry) => entry.profile.kind === 'local'
      ? { ...entry, readiness: 'unavailable', hostId: undefined } : entry),
  }, VERIFIED), 'local', 'offline local target can show its own unavailable state');
});

test('history focus restores once without scrolling and rejects removed or obscured openers', async () => {
  const { root } = installReactRenderer();
  let focus!: ReturnType<typeof useHistorySettingsFocus>;
  function Probe() {
    focus = useHistorySettingsFocus();
    return null;
  }
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  const gear = document.createElement('button');
  const page = document.createElement('section');
  const focusCalls: FocusOptions[] = [];
  let connected = true;
  let obscured = false;
  let inHistory = true;
  Object.defineProperty(document, 'activeElement', { configurable: true, value: gear });
  Object.defineProperty(gear, 'isConnected', { get: () => connected });
  gear.closest = ((selector: string) => selector === '.computer-history-page'
    ? (inHistory ? page : null) : (obscured ? page : null)) as typeof gear.closest;
  gear.blur = () => {};
  gear.focus = (options) => { focusCalls.push(options ?? {}); };

  await act(async () => root.render(createElement(Probe)));
  focus.capture();
  focus.restore();
  assert.deepEqual(focusCalls, [], 'restore waits until Settings has released inert');
  frames.shift()?.(0);
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);

  focus.restore();
  assert.equal(frames.length, 0, 'the opener is consumed once');
  focus.capture();
  focus.restore();
  connected = false;
  frames.shift()?.(0);
  assert.equal(focusCalls.length, 1, 'navigation away must not refocus a disconnected gear');

  connected = true;
  focus.capture();
  focus.restore();
  obscured = true;
  frames.shift()?.(0);
  assert.equal(focusCalls.length, 1, 'a reopened overlay retains focus ownership');

  inHistory = false;
  focus.capture();
  focus.restore();
  assert.equal(frames.length, 0, 'non-history openers do not gain return focus');
});
