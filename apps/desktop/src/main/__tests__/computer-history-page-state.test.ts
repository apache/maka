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
  ComputerHistoryPage, ComputerHistorySettingsPage, createFakeComputerHistoryAnalysisModel, createFakeModuleHubServices,
  ModuleHubServicesProvider, type ModuleHubServices,
} from '../../renderer/features/module-hub/testing.js';

const STATUS: ComputerHistoryStatus = {
  platformSupported: true, helperAvailable: true, state: 'stopped',
  accessibilityGranted: true, inputMonitoringGranted: true,
  eventCount: 2, suppressedEventCount: 0, segmentCount: 1,
  settings: { enabled: false, captureText: false, summariesEnabled: false, summaryTextEnabled: false, blockedApplications: [], blockedDomains: [] },
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
const CHILD_ENTRY = entry('child');
const ROLLUP_ENTRY: ComputerHistoryTimelineEntry = {
  ...entry('rollup'), summaryLevel: '6h', summaryChildren: [CHILD_ENTRY.id],
  start: '2026-09-13T06:00:00Z', end: '2026-09-13T12:00:00Z',
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
    groupButtons: () => [...document.querySelectorAll<HTMLButtonElement>('.computer-history-group-open')],
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
        getAnalysisModel: async () => createFakeComputerHistoryAnalysisModel(),
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
  const source = h.document.querySelector('.computer-history-document [role="radio"][aria-checked="true"]');
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
      start: new Date('2026-09-12T06:00:00').toISOString(), end: new Date('2026-09-12T12:00:00').toISOString(),
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
    assert.equal(h.rows().length, 1, 'the ten-minute summary remains an activity row');
    assert.equal(h.groupButtons().filter((button) => button.textContent?.includes(rollup.title)).length, 1,
      'the six-hour summary remains available through its group header');
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
    assert.equal(h.rows().length, 0);
    assert.equal(h.groupButtons().length, 1);
    assert.match(h.groupButtons()[0]!.textContent ?? '', /Activity rollup/);
    await h.click(h.button(formatDay(rollup.start)));
    const allDays = h.options(dateFilter).find((option) => option.textContent?.trim() === 'Recent 30 days');
    assert.ok(allDays);
    await h.click(allDays);

    for (const term of [RAW_ENTRY.title, RAW_ENTRY.description, RAW_ENTRY.applications[0]!]) {
      await h.search(term);
      assert.equal(h.rows().length, 0, `raw search term must not reveal an activity: ${term}`);
      assert.equal(h.groupButtons().length, 0);
      h.heading('No matching activities');
    }
    await h.search('release checklist');
    assert.equal(h.rows().length, 1);
    assert.match(h.rows()[0]!.textContent ?? '', /Activity saved/);
    await h.search('Rollup Browser');
    assert.equal(h.rows().length, 0);
    assert.equal(h.groupButtons().length, 1);
    assert.match(h.groupButtons()[0]!.textContent ?? '', /Activity rollup/);
    await h.search('');
    assert.equal(h.rows().length, 1);
    assert.equal(h.groupButtons().filter((button) => button.textContent?.includes(rollup.title)).length, 1);
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
  const source = h.document.querySelector('.computer-history-document [role="radio"][aria-checked="true"]');
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

test('granularity loads and persists every supported choice through its service across remounts', async (t) => {
  const h = renderer(t);
  let stored: '10min' | '6h' | 'day' = 'day';
  const writes: string[] = [];
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      getViewGranularity: () => stored,
      setViewGranularity: (value) => { writes.push(value); stored = value; },
      status: async () => STATUS,
      timeline: async () => ({ status: STATUS, entries: [CHILD_ENTRY, ROLLUP_ENTRY] }),
      applications: async () => [],
    },
  });
  await renderHistory(h, services);
  const controls = h.document.querySelector('.computer-history-viewbar');
  assert.ok(controls);
  assert.equal(h.button('1 day', controls).getAttribute('aria-checked'), 'true', 'the service preference overrides the default view');
  assert.deepEqual(writes, [], 'mounting reads the preference without rewriting it');
  for (const [value, label] of [['10min', '10 minutes'], ['6h', '6 hours'], ['day', '1 day']] as const) {
    await h.click(h.button(label, h.document.querySelector('.computer-history-viewbar')!));
    assert.equal(stored, value);
    await act(async () => h.root.render(null));
    await renderHistory(h, services);
    assert.equal(h.button(label, h.document.querySelector('.computer-history-viewbar')!).getAttribute('aria-checked'), 'true');
    assert.equal(h.document.querySelectorAll('.computer-history-viewbar [role="radio"][aria-checked="true"]').length, 1);
  }
  assert.deepEqual(writes, ['10min', '6h', 'day'], 'only explicit choices persist the preference');
  assert.equal(createFakeModuleHubServices().computerHistory.getViewGranularity(), '6h', 'a separate service keeps its own default');
});

test('switching 10min, 6h and day preserves the selected Source DOM and reader scroll without history or model operations', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = renderer(t);
  const status: ComputerHistoryStatus = {
    ...RECORDING_STATUS, summaryState: 'error', summaryError: 'Synthetic summary failure awaiting explicit retry',
  };
  const reads: string[] = [];
  const unexpected: string[] = [];
  const preferenceWrites: string[] = [];
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      getViewGranularity: () => '6h',
      setViewGranularity: (value) => { preferenceWrites.push(value); },
      status: async () => { reads.push('status'); return status; },
      timeline: async () => { reads.push('timeline'); return { status, entries: [CHILD_ENTRY, ROLLUP_ENTRY] }; },
      applications: async () => [],
      detail: async (id) => {
        reads.push(`detail:${id}`);
        assert.equal(id, CHILD_ENTRY.id);
        return {
          entry: CHILD_ENTRY, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
          document: { name: 'child.md', body: '# Child activity', markdown: '---\n{}\n---\n# Child activity' },
        };
      },
    },
  });
  for (const operation of [
    'updateSettings', 'retrySummary', 'getAnalysisModel', 'setAnalysisModel', 'requestPermissions',
    'pause', 'resume', 'clear', 'deleteEntry', 'revealSummary',
  ] as const) {
    t.mock.method(services.computerHistory, operation, async () => {
      unexpected.push(operation);
      throw new Error(`Unexpected ${operation} while changing granularity`);
    });
  }
  t.mock.method(services.clipboard, 'writeText', async () => { unexpected.push('clipboard.writeText'); });
  await renderHistory(h, services);
  assert.equal(h.button('6 hours').getAttribute('aria-checked'), 'true');
  assert.equal(h.rows().length, 0, 'saved rollups start collapsed');
  assert.match(h.groupButtons()[0]!.textContent ?? '', /Activity rollup/);
  await h.click(h.button('10 minutes'));
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0]!.textContent ?? '', /Activity child/);
  await h.click(h.rows()[0]!);
  h.frames();
  await h.click(h.button('Source'));
  const document = h.document.querySelector('.computer-history-document');
  const code = document?.querySelector('pre code');
  const source = document?.querySelector('[role="radio"][aria-checked="true"]');
  const reader = h.document.querySelector<HTMLElement>('.computer-history-detail');
  assert.ok(document && code && source && reader);
  assert.equal(source.textContent?.trim(), 'Source');
  reader.scrollTop = 360;
  const initialReads = [...reads];
  for (const label of ['6 hours', '1 day', '10 minutes']) {
    await h.click(h.button(label));
    h.frames();
    assert.equal(h.button(label).getAttribute('aria-checked'), 'true');
    assert.equal(h.document.querySelector('.computer-history-detail'), reader);
    assert.equal(reader.getAttribute('aria-label'), CHILD_ENTRY.title);
    assert.equal(h.document.querySelector('.computer-history-document'), document);
    assert.equal(document.querySelector('pre code'), code);
    assert.equal(document.querySelector('[role="radio"][aria-checked="true"]'), source);
    assert.equal(reader.scrollTop, 360);
    assert.deepEqual(reads, initialReads, 'view changes do not refresh or reopen a saved document');
    assert.deepEqual(unexpected, [], 'only the view preference service may be written');
  }
  assert.equal(h.rows().length, 1);
  assert.deepEqual(preferenceWrites, ['10min', '6h', 'day', '10min']);
});

test('a rollup arriving on the 15-second poll keeps its selected child visible and the Source reader mounted', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = renderer(t);
  let saved = false;
  let timelineCalls = 0;
  const detailIds: string[] = [];
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      status: async () => RECORDING_STATUS,
      timeline: async () => {
        timelineCalls++;
        return { status: RECORDING_STATUS, entries: saved ? [ROLLUP_ENTRY, { ...CHILD_ENTRY }] : [CHILD_ENTRY] };
      },
      applications: async () => [],
      detail: async (id) => {
        detailIds.push(id);
        return {
          entry: { ...CHILD_ENTRY }, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
          document: { name: 'child.md', body: '# Child activity', markdown: '---\n{}\n---\n# Child activity' },
        };
      },
    },
  });
  await renderHistory(h, services);
  assert.equal(h.rows().length, 1, 'a six-hour group without its rollup starts expanded');
  await h.click(h.rows()[0]!);
  h.frames();
  await h.click(h.button('Source'));
  const document = h.document.querySelector('.computer-history-document');
  const code = document?.querySelector('pre code');
  const source = document?.querySelector('[role="radio"][aria-checked="true"]');
  const reader = h.document.querySelector<HTMLElement>('.computer-history-detail');
  assert.ok(document && code && source && reader);
  reader.scrollTop = 280;
  saved = true;
  await act(async () => t.mock.timers.tick(14_999));
  assert.equal(timelineCalls, 1);
  assert.ok(!h.groupButtons().some((button) => button.textContent?.includes(ROLLUP_ENTRY.title)));
  await act(async () => t.mock.timers.tick(1));
  h.frames();
  assert.equal(timelineCalls, 2);
  assert.deepEqual(detailIds, [CHILD_ENTRY.id, CHILD_ENTRY.id], 'polling rereads the selected child, never the new rollup');
  assert.equal(h.groupButtons().length, 1);
  assert.match(h.groupButtons()[0]!.textContent ?? '', /Activity rollup/);
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0]!.textContent ?? '', /Activity child/);
  assert.equal(h.document.querySelector('.computer-history-group-header [aria-expanded]')?.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.querySelector('.computer-history-detail'), reader);
  assert.equal(reader.getAttribute('aria-label'), CHILD_ENTRY.title);
  assert.equal(h.document.querySelector('.computer-history-document'), document);
  assert.equal(document.querySelector('pre code'), code);
  assert.equal(document.querySelector('[role="radio"][aria-checked="true"]'), source);
  assert.equal(reader.scrollTop, 280);
});

for (const partialAtOpen of [false, true]) {
  test(`a six-hour collection opened ${partialAtOpen ? 'from a remaining pending subgroup' : 'before its rollup arrives'} retains the entire window through partial and complete rollups`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = renderer(t);
    const a = entry('a');
    const b: ComputerHistoryTimelineEntry = {
      ...entry('b'), start: '2026-09-13T10:20:00Z', end: '2026-09-13T10:30:00Z',
    };
    const outside: ComputerHistoryTimelineEntry = {
      ...entry('outside'), start: '2026-09-13T12:30:00Z', end: '2026-09-13T12:40:00Z',
    };
    const leaves = [a, b, outside];
    let rollup: ComputerHistoryTimelineEntry | null = partialAtOpen
      ? { ...ROLLUP_ENTRY, summaryChildren: [a.id] } : null;
    let timelineCalls = 0;
    const detailIds: string[] = [];
    const services = createFakeModuleHubServices({
      computerHistory: {
        ...createFakeModuleHubServices().computerHistory,
        status: async () => RECORDING_STATUS,
        timeline: async () => {
          timelineCalls++;
          return {
            status: RECORDING_STATUS,
            entries: [...leaves.map((leaf) => ({ ...leaf })), ...(rollup ? [{ ...rollup }] : [])],
          };
        },
        applications: async () => [],
        detail: async (id) => {
          detailIds.push(id);
          const selected = leaves.find((leaf) => leaf.id === id);
          assert.ok(selected, 'a collection reads saved leaf documents, not its new rollup');
          return {
            entry: selected, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
            document: { name: `${id}.md`, body: `# Saved ${id}`, markdown: `---\n{}\n---\n# Saved ${id}` },
          };
        },
      },
    });
    await renderHistory(h, services);
    const pending = h.groupButtons().find((button) =>
      button.querySelector('.computer-history-pending') &&
      button.closest('.computer-history-day')?.textContent?.includes(b.title));
    assert.ok(pending);
    const pendingRows = pending.closest('.computer-history-day')!.querySelectorAll('.computer-history-row button');
    assert.equal(pendingRows.length, partialAtOpen ? 1 : 2, 'the entry point may show only unowned leaves');
    await h.click(pending);
    h.frames();
    const reader = h.document.querySelector<HTMLElement>('.computer-history-detail');
    const collection = reader?.querySelector('.computer-history-day-document');
    assert.ok(reader && collection);
    const sections = [...collection.querySelectorAll<HTMLElement>('.computer-history-day-document-section')];
    assert.deepEqual(sections.map((section) =>
      section.querySelector('.computer-history-day-document-title')?.textContent?.trim()).sort(), [a.title, b.title],
    'opening any pending subgroup reads the full six-hour window without adjacent-window documents');
    assert.deepEqual([...detailIds].sort(), [a.id, b.id]);
    const snapshots: { section: HTMLElement; document: Element; source: Element; code: Element }[] = [];
    for (const section of sections) {
      const document = section.querySelector('.computer-history-document');
      assert.ok(document);
      await h.click(h.button('Source', document));
      const source = document.querySelector('[role="radio"][aria-checked="true"]');
      const code = document.querySelector('pre code');
      assert.ok(source && code);
      assert.equal(source.textContent?.trim(), 'Source');
      const savedEntry = leaves.find((leaf) =>
        section.querySelector('.computer-history-day-document-title')?.textContent?.trim() === leaf.title);
      assert.ok(savedEntry);
      assert.ok(code.textContent?.includes(`# Saved ${savedEntry.id}`));
      snapshots.push({ section, document, source, code });
    }
    reader.scrollTop = 410;
    const assertPreserved = () => {
      assert.equal(h.document.querySelector('.computer-history-detail'), reader);
      assert.equal(reader.querySelector('.computer-history-day-document'), collection);
      assert.equal(collection.querySelectorAll('.computer-history-day-document-section').length, 2);
      for (const { section, document, source, code } of snapshots) {
        assert.ok(collection.contains(section), 'both owned and pending documents stay mounted');
        assert.equal(section.querySelector('.computer-history-document'), document);
        assert.equal(document.querySelector('pre code'), code);
        assert.equal(document.querySelector('[role="radio"][aria-checked="true"]'), source);
      }
      assert.equal(reader.scrollTop, 410);
      assert.deepEqual([...detailIds].sort(), [a.id, b.id], 'unchanged saved documents are not reopened on rollup polling');
    };
    if (!partialAtOpen) {
      rollup = { ...ROLLUP_ENTRY, summaryChildren: [a.id] };
      await act(async () => t.mock.timers.tick(15_000));
      h.frames();
      assert.equal(timelineCalls, 2);
      assert.ok(h.groupButtons().some((button) => button.textContent?.includes(ROLLUP_ENTRY.title)));
      assertPreserved();
    }
    rollup = { ...ROLLUP_ENTRY, summaryChildren: [a.id, b.id] };
    await act(async () => t.mock.timers.tick(15_000));
    h.frames();
    assert.equal(timelineCalls, partialAtOpen ? 2 : 3);
    assert.ok(!h.groupButtons().some((button) =>
      button.querySelector('.computer-history-pending') &&
      button.closest('.computer-history-day')?.textContent?.includes(b.title)),
    'the remaining pending subgroup disappears once the parent owns both leaves');
    assertPreserved();
  });
}

test('a UTC-aligned ten-minute activity crossing Kathmandu midnight remains visible on its second local date', async (t) => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Kathmandu';
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  const h = renderer(t);
  const crossing: ComputerHistoryTimelineEntry = {
    ...entry('crossing-midnight'), start: '2026-09-13T18:10:00Z', end: '2026-09-13T18:20:00Z',
  };
  const firstDayOnly: ComputerHistoryTimelineEntry = {
    ...entry('first-day-only'), start: '2026-09-13T18:00:00Z', end: '2026-09-13T18:10:00Z',
  };
  assert.equal(new Date(crossing.start).getDate(), 13);
  assert.equal(new Date(crossing.end).getDate(), 14);
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      getViewGranularity: () => '10min',
      status: async () => STATUS,
      timeline: async () => ({ status: STATUS, entries: [crossing, firstDayOnly] }),
      applications: async () => [],
      detail: async (id) => {
        assert.equal(id, crossing.id);
        return { entry: crossing, events: [], eventTotal: 0, rawAvailable: false, truncated: false };
      },
    },
  });
  await renderHistory(h, services);
  assert.equal(h.rows().length, 2);
  const dateFilter = h.button('Recent 30 days');
  await h.click(dateFilter);
  const secondDay = new Intl.DateTimeFormat('en', {
    month: 'long', day: 'numeric', weekday: 'short',
  }).format(new Date('2026-09-14T12:00:00'));
  const option = h.options(dateFilter).find((node) => node.textContent?.trim() === secondDay);
  assert.ok(option);
  await h.click(option);
  assert.equal(h.button('10 minutes').getAttribute('aria-checked'), 'true');
  assert.equal(h.rows().length, 1, 'interval overlap retains a row even though its ten-minute group starts on the first date');
  assert.match(h.rows()[0]!.textContent ?? '', /Activity crossing-midnight/);
  assert.ok(!h.document.querySelector('.computer-history-master')?.textContent?.includes(firstDayOnly.title));
  await h.click(h.rows()[0]!);
  assert.equal(h.document.querySelector('.computer-history-detail')?.getAttribute('aria-label'), crossing.title);

  await h.click(h.button('1 day'));
  assert.equal(h.groupButtons().length, 1, 'day view still clips duplicate cross-midnight collections to the chosen date');
  assert.ok(h.groupButtons()[0]!.querySelector('.computer-history-row-title')?.textContent?.includes(secondDay));
  await h.click(h.button('10 minutes'));
  assert.equal(h.rows().length, 1);
});

test('a day collection opened from a parent-only search keeps that saved parent after clearing search and receiving late leaves', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = renderer(t);
  const a = entry('a');
  const b: ComputerHistoryTimelineEntry = {
    ...entry('b'), start: '2026-09-13T10:20:00Z', end: '2026-09-13T10:30:00Z',
  };
  const parent: ComputerHistoryTimelineEntry = {
    ...ROLLUP_ENTRY, title: 'Release window overview', summaryChildren: [a.id, b.id],
  };
  let late = false;
  let timelineCalls = 0;
  const detailIds: string[] = [];
  const services = createFakeModuleHubServices({
    computerHistory: {
      ...createFakeModuleHubServices().computerHistory,
      getViewGranularity: () => 'day',
      status: async () => RECORDING_STATUS,
      timeline: async () => {
        timelineCalls++;
        return { status: RECORDING_STATUS, entries: [parent, a, ...(late ? [b] : [])].map((entry) => ({ ...entry })) };
      },
      applications: async () => [],
      detail: async (id) => {
        detailIds.push(id);
        const selected = [parent, a, b].find((entry) => entry.id === id);
        assert.ok(selected);
        return {
          entry: selected, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
          document: { name: `${id}.md`, body: `# ${selected.title}`, markdown: `# Saved document: ${selected.title}` },
        };
      },
    },
  });
  await renderHistory(h, services);
  await h.search(parent.title);
  assert.equal(h.groupButtons().length, 1);
  assert.ok(h.groupButtons()[0]!.textContent?.includes(parent.title), 'a parent-only match offers a day collection');
  await h.click(h.groupButtons()[0]!);
  h.frames();
  const reader = h.document.querySelector<HTMLElement>('.computer-history-detail');
  const collection = reader?.querySelector('.computer-history-day-document');
  assert.ok(reader && collection);
  const parentSection = [...collection.querySelectorAll<HTMLElement>('.computer-history-day-document-section')]
    .find((section) => section.querySelector('.computer-history-day-document-title')?.textContent?.trim() === parent.title);
  const document = parentSection?.querySelector('.computer-history-document');
  assert.ok(parentSection && document, 'the reader includes the saved parent chosen through search');
  await h.click(h.button('Source', document));
  const code = document.querySelector('pre code');
  const source = document.querySelector('[role="radio"][aria-checked="true"]');
  assert.ok(code && source);
  assert.ok(code.textContent?.includes(`# Saved document: ${parent.title}`));
  reader.scrollTop = 330;
  const assertParentPreserved = () => {
    assert.equal(h.document.querySelector('.computer-history-detail'), reader);
    assert.equal(reader.querySelector('.computer-history-day-document'), collection);
    assert.ok(collection.contains(parentSection), 'the chosen parent survives the unfiltered day projection');
    assert.equal(parentSection.querySelector('.computer-history-document'), document);
    assert.equal(document.querySelector('pre code'), code);
    assert.equal(document.querySelector('[role="radio"][aria-checked="true"]'), source);
    assert.equal(reader.scrollTop, 330);
    assert.equal(detailIds.filter((id) => id === parent.id).length, 1);
  };
  await h.search('');
  assertParentPreserved();
  late = true;
  await act(async () => t.mock.timers.tick(15_000));
  h.frames();
  assert.equal(timelineCalls, 2);
  assertParentPreserved();
  assert.deepEqual([...collection.querySelectorAll('.computer-history-day-document-title')]
    .map((title) => title.textContent?.trim()).sort(), [a.title, b.title, parent.title].sort(),
  'the day reader combines newly available leaves with the parent the user opened');
});

for (const withChild of [false, true]) {
  test(`date filtering includes a cross-midnight rollup on its second local day ${withChild ? 'with' : 'without'} a retained child`, async (t) => {
    const h = renderer(t);
    const child: ComputerHistoryTimelineEntry = {
      ...CHILD_ENTRY,
      start: new Date('2026-09-13T01:10:00').toISOString(), end: new Date('2026-09-13T01:20:00').toISOString(),
    };
    const rollup: ComputerHistoryTimelineEntry = {
      ...ROLLUP_ENTRY,
      start: new Date('2026-09-12T20:00:00').toISOString(), end: new Date('2026-09-13T02:00:00').toISOString(),
    };
    const outside: ComputerHistoryTimelineEntry = {
      ...entry('outside'),
      start: new Date('2026-09-10T10:00:00').toISOString(), end: new Date('2026-09-10T10:10:00').toISOString(),
    };
    const services = createFakeModuleHubServices({
      computerHistory: {
        ...createFakeModuleHubServices().computerHistory,
        status: async () => STATUS,
        timeline: async () => ({ status: STATUS, entries: [outside, rollup, ...(withChild ? [child] : [])] }),
        applications: async () => [],
        detail: async () => ({ entry: rollup, events: [], eventTotal: 0, rawAvailable: false, truncated: false }),
      },
    });
    await renderHistory(h, services);
    const dateFilter = h.button('Recent 30 days');
    await h.click(dateFilter);
    const secondDay = new Intl.DateTimeFormat('en', {
      month: 'long', day: 'numeric', weekday: 'short',
    }).format(new Date('2026-09-13T12:00:00'));
    const option = h.options(dateFilter).find((node) => node.textContent?.trim() === secondDay);
    assert.ok(option, 'the selector offers the second day even when only the rollup covers it');
    await h.click(option);
    assert.equal(h.groupButtons().length, 1);
    assert.match(h.groupButtons()[0]!.textContent ?? '', /Activity rollup/);
    assert.ok(!h.document.querySelector('.computer-history-master')?.textContent?.includes(outside.title));
    const toggle = h.document.querySelector<HTMLButtonElement>('.computer-history-group-header [aria-expanded]');
    assert.ok(toggle);
    if (withChild) {
      await h.click(toggle);
      assert.equal(h.rows().length, 1);
      assert.match(h.rows()[0]!.textContent ?? '', /Activity child/);
    } else {
      assert.equal(h.rows().length, 0);
      assert.equal(toggle.getAttribute('aria-disabled'), 'true', 'the tooltip remains accessible on an empty group');
      await h.click(toggle);
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(h.document.querySelector('.computer-history-detail'), null);
    }
    await h.click(h.groupButtons()[0]!);
    assert.equal(h.document.querySelector('.computer-history-detail')?.getAttribute('aria-label'), rollup.title);
  });
}

for (const grain of ['6 hours', '1 day']) {
  test(`${grain} group expansion and collapse are independent from opening its saved content`, async (t) => {
    const h = renderer(t);
    const entries = [CHILD_ENTRY, ROLLUP_ENTRY];
    const detailIds: string[] = [];
    const services = createFakeModuleHubServices({
      computerHistory: {
        ...createFakeModuleHubServices().computerHistory,
        status: async () => STATUS,
        timeline: async () => ({ status: STATUS, entries }),
        applications: async () => [],
        detail: async (id) => {
          detailIds.push(id);
          const selected = entries.find((entry) => entry.id === id);
          assert.ok(selected);
          return {
            entry: selected, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
            document: { name: `${id}.md`, body: `# ${selected.title}`, markdown: `# ${selected.title}` },
          };
        },
      },
    });
    await renderHistory(h, services);
    if (grain === '1 day') await h.click(h.button(grain));
    assert.equal(h.groupButtons().length, 1);
    const open = h.groupButtons()[0]!;
    const toggle = h.document.querySelector<HTMLButtonElement>('.computer-history-group-header [aria-expanded]');
    assert.ok(toggle);
    assert.notEqual(toggle, open);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    await h.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(h.rows().length, 1);
    assert.equal(h.document.querySelector('.computer-history-detail'), null);
    assert.deepEqual(detailIds, [], 'expansion does not load a reader');
    await h.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(h.rows().length, 0);
    assert.deepEqual(detailIds, []);

    await h.click(open);
    h.frames();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'opening content does not expand its group');
    assert.equal(h.rows().length, 0);
    assert.deepEqual(detailIds, [grain === '6 hours' ? ROLLUP_ENTRY.id : CHILD_ENTRY.id]);
    const reader = h.document.querySelector<HTMLElement>('.computer-history-detail');
    const document = reader?.querySelector('.computer-history-document');
    assert.ok(reader && document);
    assert.equal(Boolean(reader.querySelector('.computer-history-day-document')), grain === '1 day');
    reader.scrollTop = 190;
    await h.click(toggle);
    assert.equal(h.rows().length, 1);
    await h.click(toggle);
    assert.equal(h.rows().length, 0);
    assert.equal(h.document.querySelector('.computer-history-detail'), reader);
    assert.equal(reader.querySelector('.computer-history-document'), document);
    assert.equal(reader.scrollTop, 190);
    assert.deepEqual(detailIds, [grain === '6 hours' ? ROLLUP_ENTRY.id : CHILD_ENTRY.id]);
  });
}

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
