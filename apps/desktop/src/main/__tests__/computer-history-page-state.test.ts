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
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ComputerHistoryStatus, ComputerHistoryTimelineEntry } from '@maka/core/computer-history';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import {
  ComputerHistoryPage, ComputerHistorySettingsPage, createFakeModuleHubServices,
  ModuleHubServicesProvider, type ModuleHubServices,
} from '../../renderer/features/module-hub/testing.js';

const STATUS: ComputerHistoryStatus = {
  platformSupported: true, helperAvailable: true, state: 'stopped',
  accessibilityGranted: true, inputMonitoringGranted: true,
  eventCount: 2, suppressedEventCount: 0, segmentCount: 1,
  settings: { enabled: false, captureText: false, summariesEnabled: false, blockedApplications: [], blockedDomains: [] },
};
const entry = (id: string): ComputerHistoryTimelineEntry => ({
  id, title: `Activity ${id}`, description: 'Observed metadata',
  start: '2026-09-13T10:00:00Z', end: '2026-09-13T10:10:00Z',
  applications: [], eventCount: 1, suppressedEventCount: 0, contextMarkdown: '',
});

function renderer(t: TestContext) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  let active: Element = document.body;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 0 });
  const prototype = window.HTMLElement.prototype;
  const descriptors = new Map(['focus', 'showModal', 'close', 'open'].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperties(prototype, {
    focus: { configurable: true, value(this: HTMLElement) { if (!this.hasAttribute('disabled')) active = this; } },
    showModal: { configurable: true, value(this: HTMLElement) { this.setAttribute('open', ''); } },
    close: { configurable: true, value(this: HTMLElement) { this.removeAttribute('open'); } },
    open: { configurable: true, get(this: HTMLElement) { return this.hasAttribute('open'); } },
  });
  const matchMedia = (media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' });
  Object.assign(window, { matchMedia, getComputedStyle, scrollTo() {} });
  const frames: FrameRequestCallback[] = [];
  const globals = {
    document, window, matchMedia, getComputedStyle,
    HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement,
    Node: window.Node, Event: window.Event, MutationObserver: window.MutationObserver,
    CSS: { supports: () => false, escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    try { await act(async () => root.unmount()); }
    finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else Reflect.deleteProperty(prototype, key);
      }
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return {
    root, document,
    async click(element: HTMLElement) {
      await act(async () => {
        element.focus();
        element.dispatchEvent(new window.Event('click', { bubbles: true }));
      });
    },
    button(label: string, within: ParentNode = document): HTMLButtonElement {
      const result = [...within.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
      assert.ok(result, `Missing button ${label}`);
      return result;
    },
    frames: () => { for (const callback of frames.splice(0)) callback(0); },
    dialog: () => document.querySelector<HTMLDialogElement>('dialog[role="alertdialog"][open]'),
  };
}

for (const page of ['settings', 'history'] as const) {
  test(`${page} deletion keeps failure inside the dialog with usable focus and preserves successful close`, async (t) => {
    const h = renderer(t);
    let deletion = deferred<ComputerHistoryStatus>();
    let deleted = false;
    const calls: string[] = [];
    const remove = async (target: string) => {
      calls.push(target);
      const result = await deletion.promise;
      deleted = true;
      return result;
    };
    const services: ModuleHubServices = createFakeModuleHubServices({
      computerHistory: {
        ...createFakeModuleHubServices().computerHistory,
        status: async () => STATUS,
        getAnalysisModel: async () => null,
        timeline: async () => ({ status: STATUS, entries: deleted ? [entry('b')] : [entry('a'), entry('b')] }),
        detail: async (id) => ({ entry: entry(id), events: [], eventTotal: 0, rawAvailable: false, truncated: false }),
        clear: remove, deleteEntry: remove, applications: async () => [],
      },
    });
    const content = page === 'settings'
      ? createElement(ComputerHistorySettingsPage, { onConfigureModel() {} })
      : createElement(ComputerHistoryPage, { onCreateDraft() {}, onOpenSettings() {}, isObscured: false });
    await act(async () => h.root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ModuleHubServicesProvider, { services }, content),
      }),
    })));
    if (page === 'history') {
      const activity = [...h.document.querySelectorAll<HTMLButtonElement>('li button')].find((button) => button.textContent?.includes('Activity a'));
      assert.ok(activity);
      await h.click(activity);
      h.frames();
    }
    const trigger = h.button(page === 'settings' ? 'Delete history' : 'Delete activity');
    const actionLabel = page === 'settings' ? 'Delete' : 'Delete permanently';
    await h.click(trigger);
    let dialog = h.dialog();
    assert.ok(dialog);
    const cancel = h.button('Cancel', dialog);
    await h.click(h.button(actionLabel, dialog));
    assert.deepEqual(calls, [page === 'settings' ? 'last_hour' : 'a']);
    assert.equal(h.document.activeElement, cancel, 'focus stays inside before the action is disabled');
    assert.ok(h.button(actionLabel, dialog).disabled);
    deletion.reject(new Error('Synthetic archive write denied'));
    await act(async () => { await deletion.promise.catch(() => {}); });
    assert.equal(h.dialog(), dialog);
    assert.match(dialog.textContent ?? '', /Synthetic archive write denied/);
    assert.equal(h.document.activeElement, cancel);
    assert.equal(h.button(actionLabel, dialog).disabled, false);
    await h.click(cancel);
    assert.equal(h.dialog(), null);
    assert.equal(h.document.activeElement, trigger);

    deletion = deferred<ComputerHistoryStatus>();
    await h.click(trigger);
    dialog = h.dialog();
    assert.ok(dialog);
    await h.click(h.button(actionLabel, dialog));
    deletion.resolve(STATUS);
    await act(async () => deletion.promise);
    h.frames();
    assert.equal(h.dialog(), null);
    assert.equal(calls.length, 2);
    if (page === 'settings') assert.equal(h.document.activeElement, trigger);
    else assert.equal(h.document.activeElement, h.document.querySelector('li button'));
  });
}

test('background detail failure retains the mounted Source view and scroll, while a first failure shows an error state', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = renderer(t);
  const activity = { ...entry('a'), summaryLevel: '10min' as const };
  const other = { ...entry('b'), summaryLevel: '10min' as const };
  let failed = false;
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => STATUS,
      timeline: async () => ({ status: STATUS, entries: [activity, other] }),
      applications: async () => [],
      detail: async (id) => {
        if (failed || id === 'b') throw new Error('Synthetic detail read unavailable');
        return {
          entry: activity, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
          document: { name: 'observed.md', body: '# Observed workflow', markdown: '---\n{}\n---\n# Observed workflow' },
        };
      },
    },
  });
  await act(async () => h.root.render(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(AstryxLocaleProvider, {
      children: createElement(ModuleHubServicesProvider, { services },
        createElement(ComputerHistoryPage, { onCreateDraft() {}, onOpenSettings() {}, isObscured: false })),
    }),
  })));
  const row = (title: string) => {
    const result = [...h.document.querySelectorAll<HTMLButtonElement>('li button')].find((button) => button.textContent?.includes(title));
    assert.ok(result);
    return result;
  };
  await h.click(row('Activity a'));
  h.frames();
  await h.click(h.button('Source'));
  const source = h.document.querySelector('[role="radio"][aria-checked="true"]');
  const document = h.document.querySelector('.computer-history-document');
  const code = document?.querySelector('pre code');
  const reader = h.document.querySelector<HTMLElement>('.computer-history-detail');
  assert.ok(reader && code && source);
  reader.scrollTop = 240;
  failed = true;
  await act(async () => t.mock.timers.tick(15_000));
  const alert = h.document.querySelector<HTMLElement>('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent ?? '', /Synthetic detail read unavailable/);
  assert.equal(h.document.querySelector('.computer-history-document'), document);
  assert.equal(document?.querySelector('pre code'), code);
  assert.equal(source.getAttribute('aria-checked'), 'true');
  assert.equal(reader.scrollTop, 240);

  failed = false;
  await h.click(h.button('Refresh history', alert));
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.equal(document?.querySelector('pre code'), code);
  assert.equal(source.getAttribute('aria-checked'), 'true');
  assert.equal(reader.scrollTop, 240);

  await h.click(row('Activity b'));
  assert.equal(h.document.querySelector('.computer-history-document'), null);
  assert.match(reader.textContent ?? '', /Summary document could not be loaded/);
  assert.match(reader.textContent ?? '', /Synthetic detail read unavailable/);
});
