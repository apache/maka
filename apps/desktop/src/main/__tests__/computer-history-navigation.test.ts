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
import { afterEach, test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import { SETTINGS_SECTIONS, type SettingsSection } from '@maka/core/settings';
import type { DesktopRuntimeHostProfileSnapshot } from '../../preload/bridge-contract.js';
import {
  computerHistoryModelSettingsProfile,
  computerHistorySettingsBackLabel,
  groupedNav,
  settingsSectionScope,
} from '../../renderer/settings/settings-nav.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import { useHistoryModelSettingsNavigation, useHistorySettingsFocus } from '../../renderer/features/module-hub/testing.js';
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

function navigationHarness(t: TestContext, requestedSection: SettingsSection = 'computer-history') {
  const { root } = installReactRenderer();
  const { document: paneDocument, window: paneWindow } = parseHTML('<section></section>');
  const pane = paneDocument.querySelector('section')!;
  pane.scrollTop = 280;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true, value: paneWindow.MutationObserver,
  });
  t.after(() => {
    if (previousObserver) Object.defineProperty(globalThis, 'MutationObserver', previousObserver);
    else Reflect.deleteProperty(globalThis, 'MutationObserver');
  });
  let navigation!: ReturnType<typeof useHistoryModelSettingsNavigation>;
  function Probe() {
    navigation = useHistoryModelSettingsNavigation(() => requestedSection);
    navigation.mainPaneRef.current = pane;
    return null;
  }
  return {
    root, pane,
    current: () => navigation,
    async render() {
      await act(async () => root.render(createElement(Probe)));
    },
    async frames() {
      await act(async () => {
        await Promise.resolve();
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      });
    },
    async model(disabled = false) {
      const wrapper = paneDocument.createElement('span');
      wrapper.setAttribute('data-computer-history-model', '');
      const selector = paneDocument.createElement('button');
      const manage = paneDocument.createElement('button');
      const focuses: FocusOptions[] = [];
      selector.focus = (options) => { focuses.push(options ?? {}); };
      manage.focus = () => { assert.fail('return must focus the selector, not Manage'); };
      if (disabled) selector.setAttribute('disabled', '');
      wrapper.append(selector, manage);
      await act(async () => pane.append(wrapper));
      return { selector, focuses };
    },
  };
}

test('contextual Models return waits for the selector, restores pane scroll once and supports repeated visits', async (t) => {
  const h = navigationHarness(t);
  await h.render();
  assert.equal(h.current().canReturnToHistory, false);
  await act(async () => h.current().openHistoryModels());
  assert.equal(h.current().section, 'models');
  assert.equal(h.current().canReturnToHistory, true);
  assert.equal(h.pane.scrollTop, 0, 'model header starts in view');
  await act(async () => h.current().returnToHistory());
  assert.equal(h.current().section, 'computer-history');
  assert.equal(h.current().canReturnToHistory, false);
  assert.equal(h.current().restoringHistory, true, 'surface skips sidebar focus during return');
  await h.frames();
  const model = await h.model(true);
  await h.frames();
  assert.deepEqual(model.focuses, [], 'wait for usable selector');
  assert.equal(h.pane.scrollTop, 280, 'scroll restores even while the model is unavailable');
  await act(async () => model.selector.removeAttribute('disabled'));
  await h.frames();
  assert.deepEqual(model.focuses, [{ preventScroll: true }]);
  assert.equal(h.pane.scrollTop, 280);
  h.pane.scrollTop = 365;
  await h.render();
  await act(async () => model.selector.setAttribute('data-loaded', 'true'));
  await h.frames();
  assert.equal(model.focuses.length, 1, 'later renders and DOM updates must not reclaim focus');
  assert.equal(h.pane.scrollTop, 365);
  await act(async () => h.current().openHistoryModels());
  await act(async () => h.current().returnToHistory());
  await h.frames();
  assert.equal(model.focuses.length, 2);
  assert.equal(h.pane.scrollTop, 365, 'second visit remembers its own scroll position');
});

test('ordinary navigation, including the current section, retires the history return intent', async (t) => {
  const h = navigationHarness(t);
  await h.render();
  await act(async () => h.current().navigate('models'));
  assert.equal(h.current().canReturnToHistory, false, 'ordinary Models visits have no return affordance');
  await act(async () => h.current().navigate('computer-history'));
  await act(async () => h.current().openHistoryModels());
  await act(async () => h.current().navigate('models'));
  assert.equal(h.current().canReturnToHistory, false, 'explicit external Models jump clears context too');
  await act(async () => h.current().navigate('computer-history'));
  await act(async () => h.current().openHistoryModels());
  await act(async () => h.current().navigate('appearance'));
  assert.equal(h.current().section, 'appearance');
  await act(async () => h.current().navigate('models'));
  assert.equal(h.current().canReturnToHistory, false);
  await act(async () => h.current().returnToHistory());
  assert.equal(h.current().section, 'models', 'expired return cannot resurrect history');
});

test('abandoned or unmounted history return cannot focus a late selector', async (t) => {
  const h = navigationHarness(t);
  await h.render();
  await act(async () => h.current().openHistoryModels());
  await act(async () => h.current().returnToHistory());
  await act(async () => h.current().navigate('appearance'));
  const model = await h.model();
  await h.frames();
  assert.deepEqual(model.focuses, []);
  await act(async () => h.current().navigate('computer-history'));
  await act(async () => h.current().openHistoryModels());
  await act(async () => h.current().returnToHistory());
  await act(async () => h.root.unmount());
  await h.frames();
  assert.deepEqual(model.focuses, []);
});

for (const interruption of ['focusin', 'pointerdown', 'keydown', 'wheel', 'error', 'timeout']) {
  test(`history return stops waiting after ${interruption} instead of stealing focus on recovery`, async (t) => {
    const h = navigationHarness(t);
    if (interruption === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    await h.render();
    await act(async () => h.current().openHistoryModels());
    await act(async () => h.current().returnToHistory());
    const model = await h.model(true);
    await h.frames();
    const marker = model.selector.parentElement!;
    if (interruption === 'error') {
      await act(async () => {
        const alert = marker.ownerDocument.createElement('span');
        alert.setAttribute('role', 'alert');
        marker.append(alert);
      });
      await h.frames();
      marker.querySelector('[role="alert"]')?.remove();
    } else if (interruption === 'timeout') {
      t.mock.timers.tick(5_000);
    } else {
      marker.ownerDocument.dispatchEvent(new marker.ownerDocument.defaultView!.Event(interruption, { bubbles: true }));
    }
    h.pane.scrollTop = 410;
    await act(async () => model.selector.removeAttribute('disabled'));
    await h.frames();
    assert.deepEqual(model.focuses, []);
    assert.equal(h.pane.scrollTop, 410, 'recovery must not restore stale scroll after user interaction or failure');
  });
}

test('history return label names the settings destination in every locale', () => {
  assert.equal(computerHistorySettingsBackLabel('en'), 'Back to Computer history settings');
  assert.equal(computerHistorySettingsBackLabel('zh-CN'), '返回电脑历史设置');
  assert.equal(computerHistorySettingsBackLabel('zh-TW'), '返回電腦歷史設定');
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
