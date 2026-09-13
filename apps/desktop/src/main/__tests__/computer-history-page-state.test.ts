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
import type { ComputerHistoryStatus, ComputerHistoryTimeline, ComputerHistoryTimelineEntry } from '@maka/core/computer-history';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
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
  summaryLevel: '10min',
});
const RECORDING_STATUS: ComputerHistoryStatus = {
  ...STATUS, state: 'running', summaryState: 'idle',
  settings: { ...STATUS.settings, enabled: true, summariesEnabled: true },
};
const RAW_ENTRY: ComputerHistoryTimelineEntry = {
  id: 'raw-window', title: 'Unprocessed window metadata', description: 'Raw-only search token',
  start: '2026-09-11T12:00:00Z', end: '2026-09-11T12:01:00Z',
  applications: ['com.example.RawSource'], eventCount: 1, suppressedEventCount: 0, contextMarkdown: '',
};

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
    heading(label: string) {
      const result = [...document.querySelectorAll('h2')].find((node) => node.textContent?.trim() === label);
      assert.ok(result, `Missing heading ${label}`);
      return result;
    },
    options(trigger: HTMLElement) {
      const id = trigger.getAttribute('aria-controls');
      assert.ok(id, 'selector identifies its own listbox');
      const listbox = document.getElementById(id);
      assert.ok(listbox);
      return [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
    },
    rows: () => [...document.querySelectorAll<HTMLButtonElement>('.computer-history-row button')],
    async search(value: string) {
      const input = document.querySelector<HTMLInputElement>('.computer-history-search input');
      assert.ok(input);
      // Linkedom does not synthesize React's input change tracking.
      const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
      assert.ok(propsKey);
      const props = (input as unknown as Record<string, unknown>)[propsKey] as {
        onChange?: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
      };
      assert.ok(props.onChange);
      await act(async () => {
        input.value = value;
        props.onChange?.({ target: input, defaultPrevented: false });
      });
    },
    frames: () => { for (const callback of frames.splice(0)) callback(0); },
    dialog: () => document.querySelector<HTMLDialogElement>('dialog[role="alertdialog"][open]'),
  };
}

async function renderHistory(
  h: ReturnType<typeof renderer>, services: ModuleHubServices, onOpenSettings = () => {},
) {
  await act(async () => h.root.render(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(AstryxLocaleProvider, {
      children: createElement(ToastProvider, { children: createElement(ModuleHubServicesProvider, { services },
        createElement(ComputerHistoryPage, { onCreateDraft() {}, onOpenSettings, isObscured: false })) }),
    }),
  })));
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
        children: createElement(ToastProvider, { children: createElement(ModuleHubServicesProvider, { services }, content) }),
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
  const activity = entry('a');
  const other = entry('b');
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
  await renderHistory(h, services);
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

for (const [summaryState, title] of [
  ['running', 'Generating summary'],
  ['idle', 'Waiting for activity summaries'],
  ['disabled', 'Model summaries off'],
] as const) {
  test(`raw-only history shows ${title} without exposing raw rows or changing consent`, async (t) => {
    const h = renderer(t);
    const status: ComputerHistoryStatus = {
      ...RECORDING_STATUS, summaryState,
      settings: { ...RECORDING_STATUS.settings, summariesEnabled: summaryState !== 'disabled' },
    };
    let settingsWrites = 0;
    let settingsOpened = 0;
    const applicationRequests: string[][] = [];
    const services = createFakeModuleHubServices({
      computerHistory: {
        ...createFakeModuleHubServices().computerHistory,
        status: async () => status,
        timeline: async () => ({ status, entries: [RAW_ENTRY] }),
        applications: async (ids) => { applicationRequests.push([...ids]); return []; },
        updateSettings: async () => { settingsWrites++; return status.settings; },
      },
    });
    await renderHistory(h, services, () => { settingsOpened++; });
    h.heading(title);
    assert.equal(h.rows().length, 0);
    assert.ok(!h.document.body.textContent?.includes(RAW_ENTRY.title));
    assert.equal(h.document.querySelector('.computer-history-filters'), null);
    assert.deepEqual(applicationRequests.flat(), []);
    assert.equal(settingsWrites, 0);
    if (summaryState === 'disabled') {
      const empty = h.document.querySelector('.computer-history-empty');
      const action = empty?.querySelector<HTMLButtonElement>('button');
      assert.ok(action, 'the disabled state offers a settings action');
      await h.click(action);
      assert.equal(settingsOpened, 1);
      assert.equal(settingsWrites, 0, 'opening settings does not silently enable model summaries');
      h.heading(title);
    }
  });
}

for (const state of ['paused', 'stopped'] as const) {
  test(`${state} recording distinguishes idle analysis from work already generating a summary`, async (t) => {
    const h = renderer(t);
    let status: ComputerHistoryStatus = { ...RECORDING_STATUS, state };
    const services = createFakeModuleHubServices({
      computerHistory: {
        ...createFakeModuleHubServices().computerHistory,
        status: async () => status,
        timeline: async () => ({ status, entries: [RAW_ENTRY] }),
        applications: async () => [],
      },
    });
    await renderHistory(h, services);
    h.heading(state === 'paused' ? 'Recording paused' : 'Recording off');
    if (state === 'stopped') assert.ok(h.document.querySelector('.computer-history-empty button'));
    status = { ...status, summaryState: 'running' };
    await h.click(h.button('Refresh history'));
    h.heading('Generating summary');
    assert.equal(h.rows().length, 0);
  });
}

test('summary failure offers an explicit retry without falling back to raw activities', async (t) => {
  const h = renderer(t);
  let status: ComputerHistoryStatus = {
    ...RECORDING_STATUS, summaryState: 'error', summaryError: 'Synthetic model unavailable',
  };
  let retries = 0;
  let settingsWrites = 0;
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => status,
      timeline: async () => ({ status, entries: [RAW_ENTRY] }),
      applications: async () => [],
      updateSettings: async () => { settingsWrites++; return status.settings; },
      retrySummary: async () => {
        retries++;
        status = { ...RECORDING_STATUS, summaryState: 'running' };
        return status;
      },
    },
  });
  await renderHistory(h, services);
  const alert = h.document.querySelector<HTMLElement>('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent ?? '', /Synthetic model unavailable/);
  assert.equal(retries, 0, 'rendering a failure does not retry a model call');
  assert.equal(h.rows().length, 0);
  assert.ok(!h.document.body.textContent?.includes(RAW_ENTRY.title));
  await h.click(h.button('Retry summary', alert));
  assert.equal(retries, 1);
  assert.equal(settingsWrites, 0);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  h.heading('Generating summary');
  assert.equal(h.rows().length, 0);
});

test('a saved summary replaces the pending empty state on the 15-second refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = renderer(t);
  const summary = { ...entry('saved'), applications: ['com.example.SummarySource'] };
  let saved = false;
  const timelineDays: (number | undefined)[] = [];
  const applicationRequests: string[][] = [];
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => RECORDING_STATUS,
      timeline: async (days) => {
        timelineDays.push(days);
        return { status: RECORDING_STATUS, entries: saved ? [RAW_ENTRY, summary] : [RAW_ENTRY] };
      },
      applications: async (ids) => {
        applicationRequests.push([...ids]);
        return ids.map((bundleIdentifier) => ({ bundleIdentifier, name: 'Summary Editor', iconDataUrl: null }));
      },
    },
  });
  await renderHistory(h, services);
  h.heading('Waiting for activity summaries');
  assert.equal(h.rows().length, 0);
  assert.deepEqual(applicationRequests, []);
  saved = true;
  await act(async () => t.mock.timers.tick(14_999));
  h.heading('Waiting for activity summaries');
  assert.deepEqual(timelineDays, [30]);
  await act(async () => t.mock.timers.tick(1));
  assert.deepEqual(timelineDays, [30, 30]);
  assert.equal(h.document.querySelector('.computer-history-empty'), null);
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0]!.textContent ?? '', /Activity saved/);
  assert.ok(!h.document.body.textContent?.includes(RAW_ENTRY.title));
  assert.deepEqual(applicationRequests.flat(), summary.applications);
});

for (const summariesEnabled of [true, false]) {
  test(`list, date, application and search filters exclude raw entries with summaries ${summariesEnabled ? 'on' : 'off'}`, async (t) => {
    const h = renderer(t);
    const status: ComputerHistoryStatus = {
      ...RECORDING_STATUS, summaryState: summariesEnabled ? 'idle' : 'disabled',
      settings: { ...RECORDING_STATUS.settings, summariesEnabled },
    };
    const summary = { ...entry('saved'), applications: ['com.example.SummarySource'], summaryText: 'Reviewed the release checklist' };
    const rollup: ComputerHistoryTimelineEntry = {
      ...entry('rollup'), summaryLevel: '6h', applications: ['com.example.RollupSource'],
      start: '2026-09-12T12:00:00Z', end: '2026-09-12T18:00:00Z',
    };
    const applicationRequests: string[][] = [];
    const names: Record<string, string> = {
      'com.example.RawSource': 'Raw Window Viewer',
      'com.example.SummarySource': 'Summary Editor',
      'com.example.RollupSource': 'Rollup Browser',
    };
    const services = createFakeModuleHubServices({
      computerHistory: {
        ...createFakeModuleHubServices().computerHistory,
        status: async () => status,
        timeline: async () => ({ status, entries: [RAW_ENTRY, summary, rollup] }),
        applications: async (ids) => {
          applicationRequests.push([...ids]);
          return ids.map((bundleIdentifier) => ({ bundleIdentifier, name: names[bundleIdentifier]!, iconDataUrl: null }));
        },
      },
    });
    await renderHistory(h, services);
    assert.equal(h.rows().length, 2, 'both ten-minute and six-hour saved summaries remain visible');
    assert.ok(!h.document.body.textContent?.includes(RAW_ENTRY.title));
    assert.deepEqual(applicationRequests.flat().sort(), [...summary.applications, ...rollup.applications].sort());

    const applicationFilter = h.button('All applications');
    await h.click(applicationFilter);
    let options = h.options(applicationFilter);
    assert.deepEqual(options.map((option) => option.textContent?.trim()).sort(), ['All applications', 'Rollup Browser', 'Summary Editor']);
    const summaryOption = options.find((option) => option.textContent?.trim() === 'Summary Editor');
    assert.ok(summaryOption);
    await h.click(summaryOption);
    assert.equal(h.rows().length, 1);
    assert.match(h.rows()[0]!.textContent ?? '', /Activity saved/);
    await h.click(h.button('Summary Editor'));
    const allApplications = h.options(applicationFilter).find((option) => option.textContent?.trim() === 'All applications');
    assert.ok(allApplications);
    await h.click(allApplications);

    const dateFilter = h.button('Recent 30 days');
    await h.click(dateFilter);
    options = h.options(dateFilter);
    const formatDay = (start: string) => new Intl.DateTimeFormat('en', {
      month: 'long', day: 'numeric', weekday: 'short',
    }).format(new Date(start));
    assert.deepEqual(options.map((option) => option.textContent?.trim()).sort(), ['Recent 30 days', formatDay(rollup.start), formatDay(summary.start)].sort());
    const rollupDay = options.find((option) => option.textContent?.trim() === formatDay(rollup.start));
    assert.ok(rollupDay);
    await h.click(rollupDay);
    assert.equal(h.rows().length, 1);
    assert.match(h.rows()[0]!.textContent ?? '', /Activity rollup/);
    await h.click(h.button(formatDay(rollup.start)));
    const allDays = h.options(dateFilter).find((option) => option.textContent?.trim() === 'Recent 30 days');
    assert.ok(allDays);
    await h.click(allDays);

    for (const term of [RAW_ENTRY.title, RAW_ENTRY.description, RAW_ENTRY.applications[0]!]) {
      await h.search(term);
      assert.equal(h.rows().length, 0, `raw search term must not reveal an activity: ${term}`);
      h.heading('No matching activities');
    }
    await h.search('release checklist');
    assert.equal(h.rows().length, 1);
    assert.match(h.rows()[0]!.textContent ?? '', /Activity saved/);
    await h.search('Rollup Browser');
    assert.equal(h.rows().length, 1);
    assert.match(h.rows()[0]!.textContent ?? '', /Activity rollup/);
    await h.search('');
    assert.equal(h.rows().length, 2);
  });
}

test('pending and failed timeline refresh retain the open Source document and scroll through recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = renderer(t);
  const activity = entry('saved');
  const refresh = deferred<ComputerHistoryTimeline>();
  let pending = false;
  let timelineCalls = 0;
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => RECORDING_STATUS,
      timeline: async () => {
        timelineCalls++;
        return pending ? refresh.promise : { status: RECORDING_STATUS, entries: [RAW_ENTRY, activity] };
      },
      applications: async () => [],
      detail: async () => ({
        entry: activity, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
        document: { name: 'saved.md', body: '# Saved activity', markdown: '---\n{}\n---\n# Saved activity' },
      }),
    },
  });
  await renderHistory(h, services);
  assert.equal(h.rows().length, 1);
  await h.click(h.rows()[0]!);
  h.frames();
  await h.click(h.button('Source'));
  const document = h.document.querySelector('.computer-history-document');
  const code = document?.querySelector('pre code');
  const source = h.document.querySelector('[role="radio"][aria-checked="true"]');
  const reader = h.document.querySelector<HTMLElement>('.computer-history-detail');
  assert.ok(document && code && source && reader);
  reader.scrollTop = 320;
  const assertPreserved = () => {
    assert.equal(h.document.querySelector('.computer-history-detail'), reader);
    assert.equal(h.document.querySelector('.computer-history-document'), document);
    assert.equal(document.querySelector('pre code'), code);
    assert.equal(source.getAttribute('aria-checked'), 'true');
    assert.equal(reader.scrollTop, 320);
    assert.equal(h.rows().length, 1);
  };
  pending = true;
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(timelineCalls, 2, 'the background refresh has started');
  assertPreserved();
  await act(async () => {
    refresh.reject(new Error('Synthetic timeline archive unavailable'));
    await refresh.promise.catch(() => {});
  });
  const alert = h.document.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent ?? '', /Synthetic timeline archive unavailable/);
  assertPreserved();
  pending = false;
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(timelineCalls, 3);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assertPreserved();
});

test('a fresh stopped profile still offers first-run setup without changing consent', async (t) => {
  const h = renderer(t);
  const status: ComputerHistoryStatus = { ...STATUS, eventCount: 0, segmentCount: 0, summaryState: 'disabled' };
  let settingsOpened = 0;
  let settingsWrites = 0;
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => status,
      timeline: async () => ({ status, entries: [] }),
      applications: async () => [],
      updateSettings: async () => { settingsWrites++; return status.settings; },
    },
  });
  await renderHistory(h, services, () => { settingsOpened++; });
  h.heading('Start recording your activity');
  assert.equal(h.rows().length, 0);
  assert.equal(settingsWrites, 0);
  await h.click(h.button('Set up recording'));
  assert.equal(settingsOpened, 1);
  assert.equal(settingsWrites, 0);
  h.heading('Start recording your activity');
});
