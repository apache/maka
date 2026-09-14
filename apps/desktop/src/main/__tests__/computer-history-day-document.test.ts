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
import { act, createElement, StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ComputerHistoryDetail, ComputerHistoryTimelineEntry } from '@maka/core/computer-history';
import type { UiLocale } from '@maka/core/ui-locale';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import {
  ComputerHistoryDayDocument, createFakeModuleHubServices, ModuleHubServicesProvider, type ModuleHubServices,
} from '../../renderer/features/module-hub/testing.js';

function entry(id: string, overrides: Partial<ComputerHistoryTimelineEntry> = {}): ComputerHistoryTimelineEntry {
  return {
    id, title: `Activity ${id}`, description: `Observed workflow ${id}`,
    start: '2026-09-13T10:00:00Z', end: '2026-09-13T10:10:00Z',
    applications: ['com.example.Editor'], eventCount: 2, suppressedEventCount: 0,
    contextMarkdown: 'Bounded context, not the saved document', summaryLevel: '10min',
    summaryText: 'Bounded summary, not the full body', ...overrides,
  };
}

function detail(activity: ComputerHistoryTimelineEntry, body = `# Full saved ${activity.id}`): ComputerHistoryDetail {
  return {
    entry: activity, events: [], eventTotal: 0, rawAvailable: false, truncated: false,
    document: {
      name: `${activity.id}.summary.md`, body,
      markdown: `---\r\n{\r\n  "title": ${JSON.stringify(activity.title)}\r\n}\r\n---\r\n${body.replaceAll('\n', '\r\n')}\r\n\r\n`,
    },
  };
}

function CommitObserver({ children, observe }: { children: ReactNode; observe?: () => void }) {
  useLayoutEffect(() => { observe?.(); });
  return children;
}

function reader(t: TestContext) {
  const { document, window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
  let active: Element = document.body;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
  const prototype = window.HTMLElement.prototype;
  const focus = Object.getOwnPropertyDescriptor(prototype, 'focus');
  Object.defineProperty(prototype, 'focus', { configurable: true, value(this: HTMLElement) { if (!this.hasAttribute('disabled')) active = this; } });
  const matchMedia = (media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' });
  Object.assign(window, { matchMedia, getComputedStyle, scrollTo() {} });
  const globals = {
    document, window, matchMedia, getComputedStyle,
    HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement,
    Node: window.Node, Event: window.Event, MutationObserver: window.MutationObserver,
    CSS: { supports: () => false, escape: (value: string) => value },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  t.after(async () => {
    try { await act(async () => root.unmount()); }
    finally {
      if (focus) Object.defineProperty(prototype, 'focus', focus);
      else Reflect.deleteProperty(prototype, 'focus');
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const opened: ComputerHistoryTimelineEntry[] = [];
  const searches: string[] = [];
  return {
    container, document, opened, searches,
    render: (services: ModuleHubServices, entries: readonly ComputerHistoryTimelineEntry[], locale: UiLocale = 'en', observe?: () => void) =>
      act(async () => root.render(createElement(StrictMode, null, createElement(CommitObserver, { observe, children: createElement(LocaleProvider, {
        locale,
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, { children: createElement(ModuleHubServicesProvider, { services },
            createElement(ComputerHistoryDayDocument, { entries, onOpenEntry: (value) => opened.push(value), onSearchKeyword: (value) => searches.push(value) })) }),
        }),
      }) })))),
    remove: () => act(async () => root.render(null)),
    click: (element: Element) => act(async () => {
      (element as HTMLElement).focus();
      element.dispatchEvent(new window.Event('click', { bubbles: true }));
    }),
    button(label: string, within: ParentNode = container) {
      const result = [...within.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
      assert.ok(result, `Missing button: ${label}`);
      return result;
    },
    section(id: string) {
      const result = [...container.querySelectorAll<HTMLElement>('.computer-history-day-document-section')].find((node) =>
        node.querySelector('.computer-history-day-document-title')?.textContent === `Activity ${id}`);
      assert.ok(result, `Missing section: ${id}`);
      return result;
    },
  };
}

function archive() {
  const requests: { id: string; response: ReturnType<typeof deferred<ComputerHistoryDetail | null>> }[] = [];
  const copied: string[] = [];
  const revealed: string[] = [];
  const unexpected: string[] = [];
  let active = 0;
  let peak = 0;
  const computerHistory = new Proxy({
    detail: async (id: string) => {
      const response = deferred<ComputerHistoryDetail | null>();
      requests.push({ id, response });
      active++;
      peak = Math.max(peak, active);
      try { return await response.promise; }
      finally { active--; }
    },
    revealSummary: async (id: string) => { revealed.push(id); },
  } as ModuleHubServices['computerHistory'], {
    get(target, name, receiver) {
      if (Reflect.has(target, name)) return Reflect.get(target, name, receiver);
      return () => { unexpected.push(String(name)); throw new Error(`Unexpected history operation: ${String(name)}`); };
    },
  });
  const services = createFakeModuleHubServices({
    computerHistory, clipboard: { writeText: async (text) => { copied.push(text); } },
    dailyReview: new Proxy({} as ModuleHubServices['dailyReview'], {
      get: (_, name) => () => { unexpected.push(`dailyReview.${String(name)}`); throw new Error('Daily reports are not part of a saved collection'); },
    }),
  });
  return {
    services, requests, copied, revealed, unexpected,
    active: () => active, peak: () => peak,
    resolve: (index: number, value: ComputerHistoryDetail | null) => act(async () => {
      requests[index]!.response.resolve(value);
      await requests[index]!.response.promise;
    }),
    reject: (index: number, error: unknown = new Error('Synthetic archive unavailable')) => act(async () => {
      requests[index]!.response.reject(error);
      await requests[index]!.response.promise.catch(() => {});
    }),
  };
}

test('reads full persisted documents with four shared slots, keeping input order as reads finish out of order', async (t) => {
  const h = reader(t);
  const a = archive();
  const entries = Array.from({ length: 7 }, (_, index) => entry(String(index)));
  await h.render(a.services, entries);
  assert.deepEqual(a.requests.map((request) => request.id), ['0', '1', '2', '3']);
  assert.equal(a.active(), 4);
  await a.resolve(2, detail(entries[2]!));
  assert.deepEqual(a.requests.map((request) => request.id), ['0', '1', '2', '3', '4']);
  assert.match(h.section('2').textContent ?? '', /Full saved 2/);
  assert.equal(h.section('0').querySelector('[aria-busy]')?.getAttribute('aria-busy'), 'true');
  for (const index of [0, 4, 1, 3, 5, 6]) await a.resolve(index, detail(entries[index]!));
  assert.equal(a.peak(), 4);
  assert.equal(a.active(), 0);
  assert.deepEqual([...h.container.querySelectorAll('.computer-history-day-document-title')].map((node) => node.textContent),
    entries.map((value) => value.title));
  assert.equal(h.container.querySelectorAll('.computer-history-document').length, 7);
  assert.equal(h.container.querySelector('[aria-busy="true"]'), null);
  assert.ok(!h.container.textContent.includes('Bounded summary'));
  assert.ok(!h.container.textContent.includes('Bounded context'));
  assert.deepEqual(a.unexpected, []);
  assert.deepEqual(a.copied, []);
  assert.deepEqual(a.revealed, []);
});

test('identical polling snapshots do not reread, and changed sources preserve mounted Source views and scroll', async (t) => {
  const h = reader(t);
  const a = archive();
  const one = entry('one');
  const two = entry('two');
  await h.render(a.services, [one, two]);
  await a.resolve(0, detail(one));
  await a.resolve(1, detail(two));
  await h.click(h.button('Source', h.section('one')));
  await h.click(h.button('Source', h.section('two')));
  const firstDocument = h.section('one').querySelector('.computer-history-document');
  const secondDocument = h.section('two').querySelector('.computer-history-document');
  const firstCode = firstDocument?.querySelector('pre code');
  const secondCode = secondDocument?.querySelector('pre code');
  assert.ok(firstCode && secondCode);
  h.container.scrollTop = 380;
  for (let poll = 0; poll < 3; poll++) {
    await h.render(a.services, [{ ...one, applications: [...one.applications] }, { ...two }]);
  }
  assert.equal(a.requests.length, 2);
  const revised = { ...one, summaryText: 'Source revised after the last poll' };
  await h.render(a.services, [two, revised]);
  assert.deepEqual(a.requests.map((request) => request.id), ['one', 'two', 'one']);
  assert.equal(h.section('one').querySelector('pre code'), firstCode, 'refresh retains the previous readable document');
  await a.resolve(2, detail(revised, '# Revised saved body'));
  assert.equal(h.section('one').querySelector('.computer-history-document'), firstDocument);
  assert.equal(h.section('two').querySelector('.computer-history-document'), secondDocument);
  assert.equal(h.section('two').querySelector('pre code'), secondCode);
  assert.equal(h.button('Source', h.section('one')).getAttribute('aria-checked'), 'true');
  assert.equal(h.button('Source', h.section('two')).getAttribute('aria-checked'), 'true');
  assert.match(h.section('one').querySelector('pre code')?.textContent ?? '', /Revised saved body/);
  assert.equal(h.container.scrollTop, 380);
  await h.click(h.button('Activity one'));
  assert.equal(h.opened.at(-1), revised, 'title opens the current entry, not the snapshot returned by detail');
  await h.render(a.services, [{ ...two }, { ...revised }]);
  assert.equal(a.requests.length, 3);
});

test('a changed document revision rereads an unchanged timeline preview and copies the updated full tail', async (t) => {
  const h = reader(t);
  const a = archive();
  const prefix = '# Saved workflow\n\n' + 'Observed editor activity and checked recorded evidence.\n\n'.repeat(240);
  assert.ok(prefix.length > 12_000, 'the changed tail lies beyond the bounded timeline preview');
  const one = entry('one', { documentRevision: 'saved-v1', summaryText: prefix.slice(0, 12_000) });
  const two = entry('two', { documentRevision: 'unchanged-v1' });
  const original = detail(one, `${prefix}Original saved tail.`);
  await h.render(a.services, [one, two]);
  await a.resolve(0, original);
  await a.resolve(1, detail(two));
  await h.click(h.button('Source', h.section('one')));
  await h.click(h.button('Source', h.section('two')));
  const document = h.section('one').querySelector('.computer-history-document');
  const originalCode = document?.querySelector('pre code');
  const unchangedCode = h.section('two').querySelector('pre code');
  assert.ok(originalCode && unchangedCode);
  h.container.scrollTop = 420;
  await h.render(a.services, [{ ...one }, { ...two }]);
  assert.equal(a.requests.length, 2, 'a repeated backend revision must not reread');

  const revised = { ...one, documentRevision: 'saved-v2' };
  const updated = detail(revised, `${prefix}Updated saved tail with new evidence.\n\tKeep trailing spaces  `);
  await h.render(a.services, [revised, { ...two }]);
  assert.deepEqual(a.requests.map((request) => request.id), ['one', 'two', 'one']);
  assert.equal(h.section('one').querySelector('pre code'), originalCode, 'keep the saved body readable during refresh');
  await a.resolve(2, updated);
  assert.equal(h.section('one').querySelector('.computer-history-document'), document);
  assert.equal(h.section('two').querySelector('pre code'), unchangedCode);
  assert.equal(h.button('Source', h.section('one')).getAttribute('aria-checked'), 'true');
  assert.equal(h.container.scrollTop, 420);
  const source = h.section('one').querySelector('pre code')?.textContent ?? '';
  assert.ok(source.includes('Updated saved tail with new evidence.'));
  assert.ok(!source.includes('Original saved tail.'));
  await h.click(h.button('Copy full Markdown', h.section('one')));
  assert.deepEqual(Buffer.from(a.copied.at(-1)!), Buffer.from(updated.document!.markdown));
  await h.click(h.button('Preview', h.section('one')));
  assert.ok(h.section('one').textContent?.includes('Updated saved tail with new evidence.'));
  assert.ok(!h.section('one').textContent?.includes('Original saved tail.'));
  assert.equal(h.section('one').querySelector('.computer-history-document h4')?.textContent, 'Saved workflow');
  assert.equal(h.container.querySelector('h1,h2'), null);

  await h.render(a.services, [{ ...revised, summaryText: 'A differently bounded preview of the same saved revision' }, { ...two }]);
  assert.equal(a.requests.length, 3, 'the backend revision is authoritative, not combined with the preview fingerprint');
  assert.equal(h.section('two').querySelector('pre code'), unchangedCode);
  assert.deepEqual(a.unexpected, []);
});

test('legacy entries without a document revision use preview metadata without depending on property order', async (t) => {
  const h = reader(t);
  const a = archive();
  let value = entry('one');
  await h.render(a.services, [value]);
  await a.resolve(0, detail(value));
  const changes: Partial<ComputerHistoryTimelineEntry>[] = [
    { title: 'Updated title' }, { description: 'Updated description' },
    { start: '2026-09-13T09:50:00Z' }, { end: '2026-09-13T10:20:00Z' },
    { applications: ['com.example.Terminal'] }, { eventCount: 5 }, { suppressedEventCount: 1 },
    { summaryLevel: '6h' }, { summaryChildren: ['child-1'] },
    { keywords: ['Agent Native'] }, { documentName: 'renamed-summary.md' },
    { contextMarkdown: 'Updated context' }, { suggestion: { type: 'skill', name: 'Review', description: 'Observed repetition' } },
  ];
  for (const change of changes) {
    value = { ...value, ...change };
    const index = a.requests.length;
    await h.render(a.services, [value]);
    assert.equal(a.requests.length, index + 1);
    await a.resolve(index, detail(value));
  }
  const count = a.requests.length;
  await h.render(a.services, [{
    ...value, applications: [...value.applications], summaryChildren: [...value.summaryChildren!],
    suggestion: { description: value.suggestion!.description, name: value.suggestion!.name, type: value.suggestion!.type },
  }]);
  assert.equal(a.requests.length, count);
  for (const searchText of ['First query excerpt', '', 'A different query excerpt', undefined]) {
    await h.render(a.services, [{ ...value, searchText }]);
    assert.equal(a.requests.length, count, 'query-only excerpts must not invalidate a saved document');
  }
});

test('collection keywords follow descriptions, activate exact search text and leave legacy entries unchanged', async (t) => {
  const h = reader(t);
  const a = archive();
  const one = entry('one', { keywords: ['Agent Native', '任务评测'] });
  await h.render(a.services, [one, entry('legacy')]);
  await a.resolve(0, detail(one));
  await a.resolve(1, detail(entry('legacy')));
  const keywords = h.section('one').querySelector('.computer-history-keywords');
  assert.ok(keywords);
  assert.ok(keywords.previousElementSibling?.classList.contains('computer-history-day-document-description'));
  await h.click(h.button('Search keyword: Agent Native', keywords));
  assert.deepEqual(h.searches, ['Agent Native']);
  assert.equal(h.section('legacy').querySelector('.computer-history-keywords'), null);
  assert.deepEqual(a.requests.map(({ id }) => id), ['one', 'legacy']);
  assert.deepEqual(a.unexpected, []);
});

test('day changes discard queued entries and fence departed completions while sharing the physical read limit', async (t) => {
  const h = reader(t);
  const a = archive();
  const old = Array.from({ length: 6 }, (_, index) => entry(`old-${index}`));
  await h.render(a.services, old);
  const next = Array.from({ length: 5 }, (_, index) => entry(`next-${index}`));
  await h.render(a.services, next);
  assert.equal(a.requests.length, 4, 'departed requests cannot be cancelled and must still occupy slots');
  for (let index = 0; index < 4; index++) await a.resolve(index, detail(old[index]!));
  assert.deepEqual(a.requests.map((request) => request.id), ['old-0', 'old-1', 'old-2', 'old-3', 'next-0', 'next-1', 'next-2', 'next-3']);
  assert.ok(!h.container.textContent.includes('old-'));
  for (let index = 4; index < 9; index++) await a.resolve(index, detail(next[index - 4]!));
  assert.equal(a.peak(), 4);
  assert.equal(h.container.querySelectorAll('.computer-history-document').length, 5);
  assert.deepEqual(a.unexpected, []);
});

test('superseded revisions and removed-then-returned IDs cannot overwrite the current document or failure', async (t) => {
  const h = reader(t);
  const a = archive();
  const original = entry('one', { documentRevision: 'saved-v1' });
  const revised = { ...original, documentRevision: 'saved-v2' };
  await h.render(a.services, [original]);
  await h.render(a.services, [revised]);
  await a.resolve(1, detail(revised, '# Current document'));
  await a.resolve(0, detail(original, '# Obsolete document'));
  assert.match(h.section('one').textContent ?? '', /Current document/);
  assert.ok(!h.container.textContent.includes('Obsolete document'));
  await h.render(a.services, [{ ...revised, documentRevision: 'saved-v3' }]);
  await h.render(a.services, []);
  await h.render(a.services, [revised]);
  await a.resolve(3, detail(revised, '# Returned document'));
  await a.reject(2, new Error('Departed failure must not appear'));
  assert.match(h.section('one').textContent ?? '', /Returned document/);
  assert.equal(h.container.querySelector('[role="alert"]'), null);
  assert.deepEqual(a.unexpected, []);
});

test('failures, missing files and missing documents stay per-section and retry only the selected read', async (t) => {
  const h = reader(t);
  const a = archive();
  const entries = ['failed', 'missing', 'no-document', 'healthy'].map((id) => entry(id));
  await h.render(a.services, entries);
  await a.reject(0, new Error('Synthetic permission denied <script>'));
  await a.resolve(1, null);
  await a.resolve(2, { ...detail(entries[2]!), document: undefined });
  await a.resolve(3, detail(entries[3]!));
  assert.equal(h.container.querySelectorAll('[role="alert"]').length, 3);
  assert.match(h.section('failed').textContent ?? '', /Synthetic permission denied <script>/);
  assert.match(h.section('missing').textContent ?? '', /This activity is no longer available/);
  assert.match(h.section('no-document').textContent ?? '', /No model summary has been saved/);
  assert.equal(h.container.querySelector('script'), null);
  const healthyDocument = h.section('healthy').querySelector('.computer-history-document');
  await h.render(a.services, entries.map((value) => ({ ...value })));
  assert.equal(a.requests.length, 4, 'polling must not turn a persistent read failure into a retry loop');
  const retry = h.button('Refresh history', h.section('failed'));
  await h.click(retry);
  await h.click(retry);
  assert.equal(a.requests.length, 5);
  assert.equal(h.section('failed').querySelector('[role="alert"]'), null);
  await a.resolve(4, detail(entries[0]!));
  assert.equal(h.container.querySelectorAll('[role="alert"]').length, 2);
  assert.equal(h.section('healthy').querySelector('.computer-history-document'), healthyDocument);
  for (const [id, index, request] of [['missing', 1, 5], ['no-document', 2, 6]] as const) {
    await h.click(h.button('Refresh history', h.section(id)));
    await a.resolve(request, detail(entries[index]!));
  }
  assert.equal(h.container.querySelector('[role="alert"]'), null);
  assert.equal(h.container.querySelectorAll('.computer-history-document').length, 4);
  assert.deepEqual(a.unexpected, []);
});

test('retry admission waits behind outstanding reads, and unmount prevents queued work and completion updates', async (t) => {
  const h = reader(t);
  const a = archive();
  const entries = Array.from({ length: 6 }, (_, index) => entry(String(index)));
  await h.render(a.services, entries);
  await a.reject(0);
  assert.equal(a.requests.length, 5);
  await h.click(h.button('Refresh history', h.section('0')));
  assert.equal(a.requests.length, 5, 'retry must queue while all four physical slots are occupied');
  await a.resolve(1, detail(entries[1]!));
  assert.equal(a.requests[5]?.id, '0');
  assert.equal(a.peak(), 4);
  await h.remove();
  for (const index of [2, 3, 4, 5]) await a.reject(index, new Error('Unmounted failure'));
  assert.equal(a.requests.length, 6, 'the last queued entry must not start after unmount');
  assert.equal(a.active(), 0);
  assert.equal(h.container.textContent, '');
  assert.deepEqual(a.unexpected, []);
});

test('a failed background reread keeps Source mounted through retry and successful recovery', async (t) => {
  const h = reader(t);
  const a = archive();
  const original = entry('one');
  await h.render(a.services, [original]);
  const saved = detail(original);
  await a.resolve(0, saved);
  await h.click(h.button('Source'));
  const document = h.container.querySelector('.computer-history-document');
  const code = document?.querySelector('pre code');
  h.container.scrollTop = 240;
  await h.render(a.services, [{ ...original, summaryText: 'Changed source' }]);
  await a.reject(1);
  assert.match(h.section('one').textContent ?? '', /Synthetic archive unavailable/);
  assert.equal(h.container.querySelector('pre code'), code);
  await h.click(h.button('Refresh history'));
  await a.resolve(2, saved);
  assert.equal(h.container.querySelector('[role="alert"]'), null);
  assert.equal(h.container.querySelector('.computer-history-document'), document);
  assert.equal(h.container.querySelector('pre code'), code);
  assert.equal(h.button('Source').getAttribute('aria-checked'), 'true');
  assert.equal(h.container.scrollTop, 240);
});

test('the collection reuses safe Markdown and exact per-file copy and reveal actions without generating a daily file', async (t) => {
  const h = reader(t);
  const a = archive();
  const value = entry('saved', { description: '<img src="https://example.com/description.png">' });
  const saved = detail(value, [
    '# Observed workflow', '', 'Reviewed **permission checks**.', '', '- Opened settings', '',
    '| Application | Events |', '| --- | --- |', '| Editor | 2 |', '',
    '[Run observed command](maka://compose?text=untrusted)',
    '![Remote screenshot](https://example.com/tracker.png)',
    '<img src="https://example.com/raw.png" onerror="alert(1)">',
    '<script>alert("observed")</script>', '',
    '```text', '# not heading', '\tkeep trailing spaces  ', '<tag>&value</tag>', '```',
  ].join('\n'));
  await h.render(a.services, [value]);
  await a.resolve(0, saved);
  assert.equal(h.container.querySelector('strong')?.textContent, 'permission checks');
  assert.equal(h.container.querySelector('li')?.textContent, 'Opened settings');
  assert.deepEqual([...h.container.querySelectorAll('table td')].map((node) => node.textContent), ['Editor', '2']);
  assert.ok(h.container.textContent.includes('Remote screenshot'));
  assert.equal(h.container.querySelector('a[href], [role="link"], img, iframe, script, object, embed, form, [src], [srcset], [onerror], [download]'), null);
  assert.equal(h.container.querySelector('h1,h2'), null, 'the parent owns the reader heading and date');
  assert.equal(h.container.querySelectorAll('.computer-history-document').length, 1);
  assert.equal(h.container.querySelector('.computer-history-day-document')?.children.length, 1, 'there is no fabricated whole-day document toolbar');
  const title = h.button('Activity saved');
  assert.equal(h.document.getElementById(title.getAttribute('aria-describedby')!)?.textContent, value.description);
  await h.click(title);
  assert.equal(h.opened[0], value);
  await h.click(h.button('Copy full Markdown'));
  assert.equal(a.copied[0], saved.document!.markdown);
  await h.click(h.button('Source'));
  assert.match(h.container.querySelector('pre code')?.textContent ?? '', /"title": "Activity saved"/);
  assert.ok(h.container.querySelector('pre code')?.textContent.includes('\tkeep trailing spaces  '));
  assert.equal(h.container.querySelector('pre code tag'), null);
  await h.click(h.button('Copy full Markdown'));
  assert.deepEqual(Buffer.from(a.copied[1]!), Buffer.from(saved.document!.markdown));
  await h.click(h.button('Reveal in Finder'));
  assert.deepEqual(a.revealed, ['saved']);
  assert.deepEqual(a.unexpected, []);
});

test('day sections use H3 titles and H4 body headings, preserving relative depth and original source', async (t) => {
  const h = reader(t);
  const a = archive();
  const one = entry('one');
  const two = entry('two');
  const saved = detail(one, [
    '```markdown', '# not a heading', '```', '',
    '### Workflow', '', 'Reviewed settings.', '',
    '#### Evidence', '', 'Opened the editor.', '',
    '##### Uncertainty', '', 'Outcome not recorded.', '',
    '###### Details', '', 'Retained notes.',
  ].join('\n'));
  await h.render(a.services, [one, two]);
  await a.resolve(0, saved);
  await a.resolve(1, detail(two, '# Another workflow\n\n### Nested evidence\n\nObserved metadata.'));
  const headings = () => [...h.container.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((node) => [node.tagName.toLowerCase(), node.textContent]);
  const expected = [
    ['h3', one.title], ['h4', 'Workflow'], ['h5', 'Evidence'],
    ['h6', 'Uncertainty'], ['h6', 'Details'],
    ['h3', two.title], ['h4', 'Another workflow'], ['h6', 'Nested evidence'],
  ];
  assert.equal(h.container.querySelector('h1,h2'), null);
  assert.deepEqual(headings(), expected);
  assert.equal(h.section('one').querySelector('pre code')?.textContent, '# not a heading');
  await h.click(h.button('Source', h.section('one')));
  assert.deepEqual(headings(), [expected[0], ...expected.slice(5)]);
  for (const text of ['### Workflow', '#### Evidence', '##### Uncertainty', '###### Details']) {
    assert.ok(h.section('one').querySelector('pre code')?.textContent.includes(text));
  }
  await h.click(h.button('Copy full Markdown', h.section('one')));
  assert.deepEqual(Buffer.from(a.copied[0]!), Buffer.from(saved.document!.markdown));
  await h.click(h.button('Preview', h.section('one')));
  assert.deepEqual(headings(), expected);
  assert.equal(a.requests.length, 2);
});

test('orphan six-hour summaries show localized cross-day ranges using local dates, with no reread on locale changes', async (t) => {
  const h = reader(t);
  const a = archive();
  const start = new Date(2026, 8, 13, 22);
  const end = new Date(2026, 8, 14, 4);
  const value = entry('rollup', { summaryLevel: '6h', summaryChildren: ['expired-child'], start: start.toISOString(), end: end.toISOString() });
  const locales = [
    ['en', '6-hour summary', 'Cross-day', 'Source', 'Summary document could not be loaded', 'Refresh history'],
    ['zh-CN', '6 \u5c0f\u65f6\u6458\u8981', '\u8de8\u65e5', '\u6e90\u7801', '\u6458\u8981\u6587\u6863\u8bfb\u53d6\u5931\u8d25', '\u5237\u65b0\u5386\u53f2'],
    ['zh-TW', '6 \u5c0f\u6642\u6458\u8981', '\u8de8\u65e5', '\u539f\u59cb\u78bc', '\u6458\u8981\u6587\u4ef6\u8b80\u53d6\u5931\u6557', '\u91cd\u65b0\u6574\u7406\u6b77\u53f2'],
  ] as const;
  await h.render(a.services, [value]);
  await a.resolve(0, detail(value));
  for (const [locale, rollup, crossDay, source] of locales) {
    await h.render(a.services, [{ ...value }], locale);
    const meta = h.section('rollup').querySelector('.computer-history-day-document-meta')!;
    const format = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    assert.deepEqual([...meta.querySelectorAll('time')].map((node) => [node.getAttribute('dateTime'), node.textContent]),
      [[value.start, format.format(start)], [value.end, format.format(end)]]);
    assert.ok(meta.textContent?.includes(rollup));
    assert.ok(meta.textContent?.includes(crossDay));
    h.button(source);
  }
  assert.equal(a.requests.length, 1);
  const revised = { ...value, summaryText: 'Revised rollup' };
  await h.render(a.services, [revised]);
  await a.reject(1, 'Non-Error failure');
  for (const [locale, , , , failure, refresh] of locales) {
    await h.render(a.services, [{ ...revised }], locale);
    assert.equal(h.section('rollup').querySelector('[role="alert"] > span')?.textContent?.trim(), failure);
    h.button(refresh);
  }
  assert.equal(a.requests.length, 2);
});

test('a replaced service owns fresh reads and ignores the departed service result', async (t) => {
  const h = reader(t);
  const a = archive();
  const b = archive();
  const value = entry('one');
  await h.render(a.services, [value]);
  await h.render(b.services, [value]);
  await b.resolve(0, detail(value, '# Current service'));
  await a.resolve(0, detail(value, '# Departed service'));
  assert.match(h.section('one').textContent ?? '', /Current service/);
  assert.ok(!h.container.textContent.includes('Departed service'));
  await h.click(h.button('Reveal in Finder'));
  assert.deepEqual(a.revealed, []);
  assert.deepEqual(b.revealed, ['one']);
});

test('a service switch never commits the departed document, even before passive effects reconcile reads', async (t) => {
  const h = reader(t);
  const a = archive();
  const b = archive();
  const value = entry('one');
  await h.render(a.services, [value]);
  await a.resolve(0, detail(value, '# Private departed service content'));
  await h.click(h.button('Source'));
  const commits: { text: string; document: boolean; loading: boolean }[] = [];
  await h.render(b.services, [value], 'en', () => {
    commits.push({
      text: h.container.textContent,
      document: Boolean(h.container.querySelector('.computer-history-document')),
      loading: Boolean(h.container.querySelector('[aria-busy="true"]')),
    });
  });
  assert.ok(commits.length > 0, 'observe the commit before the reader passive effect');
  for (const commit of commits) {
    assert.ok(!commit.text.includes('Private departed service content'));
    assert.equal(commit.document, false);
    assert.equal(commit.loading, true);
  }
  await b.resolve(0, detail(value, '# Current service content'));
  assert.match(h.section('one').textContent ?? '', /Current service content/);
  assert.equal(h.button('Preview').getAttribute('aria-checked'), 'true');
  assert.equal(h.button('Source').getAttribute('aria-checked'), 'false');
});

test('a new same-service revision immediately hides the previous failure while keeping the saved body', async (t) => {
  const h = reader(t);
  const a = archive();
  const value = entry('one');
  await h.render(a.services, [value]);
  await a.resolve(0, detail(value));
  await h.click(h.button('Source'));
  const code = h.container.querySelector('pre code');
  await h.render(a.services, [{ ...value, summaryText: 'First revision' }]);
  await a.reject(1);
  assert.ok(h.container.querySelector('[role="alert"]'));
  let observed = false;
  await h.render(a.services, [{ ...value, summaryText: 'Second revision' }], 'en', () => {
    observed = true;
    assert.equal(h.container.querySelector('[role="alert"]'), null);
    assert.equal(h.container.querySelector('pre code'), code);
    assert.ok(h.container.querySelector('[aria-busy="true"]'));
  });
  assert.equal(observed, true);
  await a.resolve(2, detail(value));
});
