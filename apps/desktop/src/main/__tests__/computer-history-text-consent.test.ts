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
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ComputerHistorySettings, ComputerHistoryStatus } from '@maka/core/computer-history';
import {
  ComputerHistorySettingsPage, createFakeComputerHistoryAnalysisModel, createFakeModuleHubServices, ModuleHubServicesProvider,
  type ModuleHubServices,
} from '../../renderer/features/module-hub/testing.js';

function harness(t: TestContext, overrides: Partial<ModuleHubServices['computerHistory']> = {}, locale: UiLocale = 'en') {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' });
  Object.assign(window, { matchMedia, getComputedStyle });
  const globals = {
    document, window, matchMedia, getComputedStyle,
    HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement,
    Node: window.Node, Event: window.Event, MutationObserver: window.MutationObserver,
    CSS: { supports: () => false, escape: (value: string) => value },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    try { await act(async () => root.unmount()); }
    finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  let status: ComputerHistoryStatus = {
    platformSupported: true, helperAvailable: true, state: 'stopped',
    accessibilityGranted: true, inputMonitoringGranted: true,
    eventCount: 0, suppressedEventCount: 0, segmentCount: 0,
    settings: { enabled: false, captureText: false, summariesEnabled: true, summaryTextEnabled: false, blockedApplications: [], blockedDomains: [] },
  };
  const patches: Partial<ComputerHistorySettings>[] = [];
  const navigation = { permissions: 0, models: 0, grants: 0 };
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      // Keep a trap for the retired API so UI regressions cannot silently grant.
      ...{ requestPermissions: async () => { navigation.grants++; return status; } },
      status: async () => structuredClone(status),
      getAnalysisModel: async () => createFakeComputerHistoryAnalysisModel({
        modelKey: 'coproxy::gpt-6-astra',
        models: [{ key: 'coproxy::gpt-6-astra', label: 'GPT-6 Astra', connectionName: 'Coproxy' }],
      }),
      timeline: async () => { throw new Error('Synthetic archive unavailable'); },
      updateSettings: async (patch) => {
        patches.push(patch);
        status = { ...status, settings: { ...status.settings, ...patch } };
        return status.settings;
      },
      ...overrides,
    },
  });
  return {
    document, patches, navigation,
    setStatus: (patch: Partial<ComputerHistoryStatus>) => { status = { ...status, ...patch }; },
    state: () => status,
    render: () => act(async () => root.render(createElement(LocaleProvider, {
      locale,
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, {
          children: createElement(ModuleHubServicesProvider, { services }, createElement(ComputerHistorySettingsPage, {
            onConfigureModel() { navigation.models++; },
            onOpenPermissions() { navigation.permissions++; },
          })),
        }),
      }),
    }))),
    control(label: string) {
      const node = [...document.querySelectorAll('label')].find((element) => element.textContent === label);
      assert.ok(node, `Missing switch label: ${label}`);
      const input = document.getElementById(node.getAttribute('for')!) as HTMLInputElement;
      assert.equal(input?.getAttribute('role'), 'switch');
      return input;
    },
    async click(label: string) {
      const button = [...document.querySelectorAll('button')].find((element) => element.textContent === label || element.getAttribute('aria-label') === label);
      assert.ok(button, `Missing button: ${label}`);
      await act(async () => button.click());
    },
    async change(input: HTMLInputElement, checked: boolean) {
      // Linkedom does not synthesize React checkbox change tracking.
      const key = Object.keys(input).find((value) => value.startsWith('__reactProps$'));
      assert.ok(key);
      const props = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!;
      await act(async () => props.onChange({ target: { checked }, defaultPrevented: false }));
    },
  };
}

for (const [locale, text, summary, capture] of [
  ['en', 'Use recorded text in summaries', 'Allow model summaries', 'Include text content'],
  ['zh-CN', '将已记录文本用于摘要', '允许模型生成摘要', '包含文本内容'],
  ['zh-TW', '將已記錄文字用於摘要', '允許模型產生摘要', '包含文字內容'],
] as const) {
  test(`${locale}: text authorization is an independent switch with visible model authority`, async (t) => {
    const h = harness(t, {}, locale);
    await h.render();
    assert.equal(h.control(text).checked, false);
    assert.equal(h.control(capture).checked, false);
    assert.equal(h.control(summary).checked, true);
    assert.ok(h.document.body.textContent?.includes('coproxy::gpt-6-astra'));
    assert.equal(h.document.querySelector('[role="radiogroup"]'), null);
    assert.deepEqual(h.patches, [], 'opening settings never grants consent');
    await h.change(h.control(text), true);
    assert.deepEqual(h.patches, [{ summaryTextEnabled: true }]);
    assert.equal(h.control(text).checked, true);
    assert.equal(h.control(capture).checked, false);
    await h.change(h.control(summary), false);
    assert.deepEqual(h.patches, [{ summaryTextEnabled: true }, { summariesEnabled: false }]);
    assert.equal(h.control(text).checked, true, 'summary pause preserves the separate authorization');
    await h.change(h.control(capture), true);
    await h.change(h.control(text), false);
    assert.equal(h.control(capture).checked, true, 'revoking text use does not stop local capture');
    assert.equal(h.control(summary).checked, false, 'text changes do not restart summaries');
  });
}

test('missing or failed model prevents enabling but still permits revoking consent with an unavailable helper', async (t) => {
  let modelFails = false;
  const h = harness(t, {
    getAnalysisModel: async () => {
      if (modelFails) throw new Error('Model read failed');
      return createFakeComputerHistoryAnalysisModel();
    },
  });
  h.setStatus({ platformSupported: false, helperAvailable: false });
  await h.render();
  const text = h.control('Use recorded text in summaries');
  assert.equal(text.disabled || text.getAttribute('aria-disabled') === 'true', true);
  await h.change(text, true);
  assert.deepEqual(h.patches, []);
  await h.change(h.control('Allow model summaries'), false);
  assert.deepEqual(h.patches, [{ summariesEnabled: false }]);
  h.setStatus({ settings: { ...h.state().settings, summaryTextEnabled: true, captureText: true } });
  modelFails = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.ok(h.document.querySelector('[role="alert"]')?.textContent?.includes('Model read failed'));
  assert.equal(h.control('Use recorded text in summaries').disabled, false);
  await h.change(h.control('Use recorded text in summaries'), false);
  assert.deepEqual(h.patches, [{ summariesEnabled: false }, { summaryTextEnabled: false }]);
  assert.equal(h.control('Include text content').checked, true);
});

test('all four History switches and navigation are independent of OS permission actions', async (t) => {
  const h = harness(t);
  h.setStatus({
    state: 'needs_permission', accessibilityGranted: false, inputMonitoringGranted: false,
    settings: { ...h.state().settings, summariesEnabled: false },
  });
  await h.render();
  assert.equal(h.document.querySelectorAll('[data-computer-history-permissions]').length, 1);
  assert.ok(h.document.body.textContent?.includes('Accessibility and Input Monitoring are required.'));
  assert.equal(h.document.querySelectorAll('[role="switch"]').length, 4);
  await h.click('Go to permissions');
  await h.click('Manage connections');
  assert.deepEqual(h.navigation, { permissions: 1, models: 1, grants: 0 });
  assert.deepEqual(h.patches, []);
  for (const [label, key] of [
    ['Record activity on this Mac', 'enabled'],
    ['Include text content', 'captureText'],
    ['Allow model summaries', 'summariesEnabled'],
    ['Use recorded text in summaries', 'summaryTextEnabled'],
  ] as const) {
    await h.change(h.control(label), true);
    assert.deepEqual(h.patches.at(-1), { [key]: true });
  }
  assert.equal(h.patches.length, 4);
  assert.equal(h.navigation.grants, 0);
  await h.click('Refresh history');
  assert.equal(h.navigation.grants, 0);
  assert.equal(h.patches.length, 4);
  assert.doesNotMatch(h.document.body.textContent ?? '', /Request macOS permissions|Recheck/);
});

test('readiness refresh preserves feature-off consent and does not turn unknown status into denial', async (t) => {
  let failing = false;
  const h = harness(t, { status: async () => {
    if (failing) throw new Error('Synthetic status read failed');
    return structuredClone(h.state());
  } });
  h.setStatus({ inputMonitoringGranted: false });
  await h.render();
  assert.ok(h.document.body.textContent?.includes('Input Monitoring is required.'));
  h.setStatus({ inputMonitoringGranted: true });
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.ok(h.document.body.textContent?.includes('Accessibility and Input Monitoring are ready.'));
  assert.equal(h.control('Record activity on this Mac').checked, false);
  assert.ok(h.document.body.textContent?.includes('This Mac · Off'));
  await h.click('Manage permissions');
  h.setStatus({ state: 'error', accessibilityGranted: false, inputMonitoringGranted: false });
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.ok(h.document.body.textContent?.includes('Permission status is unknown.'), 'probe failure is not a missing grant');
  failing = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.ok(h.document.body.textContent?.includes('Permission status is unknown.'));
  assert.ok(!h.document.body.textContent?.includes('Accessibility and Input Monitoring are ready.'));
  await h.click('Manage permissions');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.navigation, { permissions: 2, models: 0, grants: 0 });
});
