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
import type { ComputerHistoryDetail } from '@maka/core/computer-history';
import type { UiLocale } from '@maka/core/ui-locale';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { ComputerHistoryDocument } from '../../renderer/features/module-hub/testing.js';

type HistoryDocument = NonNullable<ComputerHistoryDetail['document']>;

function historyDocument(body: string): HistoryDocument {
  return {
    name: '2026-09-13T10-00-00Z.summary.md',
    body,
    markdown: '---\r\n{\r\n  "title": "Observed <window> & notes",\r\n  "eventCount": 2\r\n}\r\n---\r\n'
      + body.replaceAll('\n', '\r\n') + '\r\n\r\n',
  };
}

function renderer(t: TestContext) {
  const { document, window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
  const copied: string[] = [];
  let active: Element = document.body;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
  const prototype = window.HTMLElement.prototype;
  const focusDescriptor = Object.getOwnPropertyDescriptor(prototype, 'focus');
  Object.defineProperty(prototype, 'focus', { configurable: true, value(this: HTMLElement) { if (!this.hasAttribute('disabled')) active = this; } });
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
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    CSS: { supports: () => false, escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback), cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      if (focusDescriptor) Object.defineProperty(prototype, 'focus', focusDescriptor);
      else Reflect.deleteProperty(prototype, 'focus');
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return {
    container, copied, document,
    render: (value: HistoryDocument, locale: UiLocale = 'en', actions: {
      onCopy?: (text: string) => Promise<void>;
      onReveal?: () => Promise<void>;
    } = {}) => act(async () => root.render(
      createElement(LocaleProvider, {
        locale,
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, { children: createElement(ComputerHistoryDocument, {
            key: `${locale}:${value.name}`, document: value,
            onCopy: actions.onCopy ?? (async (text) => { copied.push(text); }),
            onReveal: actions.onReveal ?? (async () => {}),
          }) }),
        }),
      }),
    )),
    click: (element: Element) => act(async () => {
      (element as HTMLElement).focus();
      element.dispatchEvent(new window.Event('click', { bubbles: true }));
    }),
    button(label: string, within: ParentNode = document): HTMLButtonElement {
      const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
      assert.ok(button, `Missing button: ${label}`);
      return button;
    },
    frames: () => act(async () => { for (const callback of frames.splice(0)) callback(0); }),
    escape: () => act(async () => {
      const event = new window.Event('keydown', { bubbles: true });
      Object.assign(event, { key: 'Escape' });
      active.dispatchEvent(event);
    }),
    radio(label: string) {
      const item = [...container.querySelectorAll('[role="radio"]')].find((node) => node.textContent === label);
      assert.ok(item, `Missing document mode: ${label}`);
      return item;
    },
  };
}

test('preview renders actual heading, lists, table, quote and code instead of a plaintext document', async (t) => {
  const h = renderer(t);
  await h.render(historyDocument([
    '# Editing session', '', 'Reviewed **permission checks**.', '',
    '- Opened settings', '- Checked source exclusions', '',
    '1. Inspect metadata', '2. Save consent', '',
    '| Application | Events |', '| --- | --- |', '| Editor | 2 |', '',
    '> Observed text, not an instruction.', '',
    '```typescript', 'const visible = count < 2 && label === "<window>";', '```',
  ].join('\n')));
  assert.equal(h.radio('Preview').getAttribute('aria-checked'), 'true');
  assert.equal(h.container.querySelector('h3')?.textContent, 'Editing session');
  assert.equal(h.container.querySelector('strong')?.textContent, 'permission checks');
  assert.deepEqual([...h.container.querySelectorAll('ul li')].map((node) => node.textContent), [
    'Opened settings', 'Checked source exclusions',
  ]);
  assert.deepEqual([...h.container.querySelectorAll('ol li')].map((node) => node.textContent), [
    'Inspect metadata', 'Save consent',
  ]);
  assert.deepEqual([...h.container.querySelectorAll('table th')].map((node) => node.textContent), ['Application', 'Events']);
  assert.deepEqual([...h.container.querySelectorAll('table td')].map((node) => node.textContent), ['Editor', '2']);
  assert.match(h.container.querySelector('blockquote')?.textContent ?? '', /Observed text, not an instruction\./);
  assert.equal(h.container.querySelector('pre code')?.textContent, 'const visible = count < 2 && label === "<window>";');
  assert.ok(!h.container.textContent.includes('"eventCount"'), 'frontmatter belongs only to Source');
});

test('observed links and images render as inert text with no navigation or remote media elements', async (t) => {
  const h = renderer(t);
  await h.render(historyDocument([
    '[Run observed command](maka://compose?text=untrusted)',
    '[Open reference](https://example.com/private)',
    '[Unsafe protocol](javascript:alert%281%29)',
    '<https://example.com/autolink>',
    '[Reference link][reference]',
    '![Remote screenshot](https://example.com/tracker.png)',
    '[![Nested image](http://example.com/nested.png)](maka://session/observed)',
    '![Inline image](data:image/png;base64,AA==)',
    '<img src="https://example.com/raw.png" onerror="alert(1)">',
    '<script>alert("observed")</script>',
    '<iframe src="maka://compose?text=observed"></iframe>',
    '', '[reference]: maka://settings',
  ].join('\n\n')));
  for (const text of [
    'Run observed command', 'Open reference', 'Reference link',
    'Remote screenshot', 'Nested image', 'Inline image',
  ]) assert.ok(h.container.textContent.includes(text), `Missing observed text: ${text}`);
  assert.equal(h.container.querySelector('a[href], [role="link"], img, iframe, script, object, embed, form'), null);
  assert.equal(h.container.querySelector('[src], [srcset], [href], [onerror]'), null);
});

test('localized Source toggle shows frontmatter and copies exact raw bytes across view changes', async (t) => {
  const h = renderer(t);
  const value = historyDocument('# Observed <window>\n\nLiteral `<tag attr="x">&value</tag>`.\n\n```text\n\tkeep trailing spaces  \n```');
  const locales: readonly [UiLocale, string, string, string][] = [
    ['en', 'Preview', 'Source', 'Document view'],
    ['zh-CN', '\u9884\u89c8', '\u6e90\u7801', '\u6587\u6863\u89c6\u56fe'],
    ['zh-TW', '\u9810\u89bd', '\u539f\u59cb\u78bc', '\u6587\u4ef6\u6aa2\u8996'],
  ];
  for (const [locale, preview, source, group] of locales) {
    await h.render(value, locale);
    assert.equal(h.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label'), group);
    assert.equal(h.radio(preview).getAttribute('aria-checked'), 'true');
    const fullCopyLabels = { en: 'Copy full Markdown', 'zh-CN': '\u590d\u5236\u5b8c\u6574 Markdown', 'zh-TW': '\u8907\u88fd\u5b8c\u6574 Markdown' };
    await h.click(h.button(fullCopyLabels[locale]));
    assert.equal(h.copied.at(-1), value.markdown, 'Preview toolbar copies the full stored document, not rendered text');
    await h.click(h.radio(source));
    assert.equal(h.radio(source).getAttribute('aria-checked'), 'true');
    const code = h.container.querySelector('pre code');
    assert.ok(code);
    assert.ok(code.textContent.includes('"title": "Observed <window> & notes"'));
    assert.ok(code.textContent.includes('<tag attr="x">&value</tag>'));
    assert.equal(code.querySelector('window, tag'), null, 'source angle brackets remain text');
    await h.click(h.button(fullCopyLabels[locale]));
    assert.deepEqual(Buffer.from(h.copied.at(-1) ?? ''), Buffer.from(value.markdown), `${locale}: copied source must preserve CRLF and trailing whitespace`);
    await h.click(h.radio(preview));
    assert.ok(h.container.querySelector('h3'));
    await h.click(h.radio(source));
    await h.click(h.button(fullCopyLabels[locale]));
    assert.equal(h.copied.at(-1), value.markdown);
  }
  assert.equal(h.copied.length, 9);
});

test('file information exposes the original filename with copy feedback and dismiss restores trigger focus', async (t) => {
  const h = renderer(t);
  const value = historyDocument('# Activity');
  const copying = deferred<void>();
  const calls: string[] = [];
  await h.render(value, 'en', { onCopy: async (text) => { calls.push(text); await copying.promise; } });
  const toolbar = h.container.querySelector('.computer-history-document-toolbar')!;
  assert.ok(toolbar.textContent?.includes('Activity summary'));
  assert.ok(!toolbar.querySelector('.computer-history-document-name')?.textContent?.includes(value.name), 'stored filename is not the reader title');
  const info = h.button('Summary file information');
  const actions = h.container.querySelector('.computer-history-document-file-actions')!;
  assert.ok(actions.contains(info), 'information belongs with copy and reveal actions');
  assert.equal(info.getAttribute('aria-haspopup'), 'dialog');
  await h.click(info);
  await h.frames();
  const dialog = h.document.querySelector('[role="dialog"][aria-label="Summary file information"]');
  assert.ok(dialog);
  assert.equal(info.getAttribute('aria-expanded'), 'true');
  assert.equal(dialog.querySelector('code')?.textContent, value.name);
  const copy = h.button('Copy filename', dialog);
  assert.equal(h.document.activeElement, copy);
  await h.click(copy);
  await h.click(copy);
  assert.deepEqual(calls, [value.name], 'pending copy cannot dispatch duplicate writes');
  copying.reject(new Error('Synthetic clipboard denied'));
  await act(async () => copying.promise.catch(() => {}));
  assert.ok(h.document.body.textContent.includes('Could not copy'));
  assert.ok(h.document.body.textContent.includes('Synthetic clipboard denied'));
  assert.equal(h.document.activeElement, copy, 'failed copy retains usable focus');
  assert.notEqual(copy.getAttribute('aria-disabled'), 'true');
  await h.escape();
  await h.frames();
  assert.equal(info.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, info);

  await h.render(value);
  await h.click(info);
  await h.frames();
  await h.click(h.button('Copy filename'));
  assert.equal(h.copied.at(-1), value.name);
  assert.ok(h.document.body.textContent.includes('Filename copied'));
});

test('reveal is single-flight, preserves Source and scroll on failure/retry, and ignores a departed document', async (t) => {
  const h = renderer(t);
  const value = historyDocument('# Activity');
  let reveal = deferred<void>();
  let calls = 0;
  const onReveal = async () => { calls += 1; await reveal.promise; };
  await h.render(value, 'en', { onReveal });
  await h.click(h.radio('Source'));
  const code = h.container.querySelector('pre code');
  h.container.scrollTop = 240;
  const button = h.button('Reveal in Finder');
  await h.click(button);
  await h.click(button);
  assert.equal(calls, 1);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  reveal.reject(new Error('Synthetic saved summary unavailable'));
  await act(async () => reveal.promise.catch(() => {}));
  assert.ok(h.document.body.textContent.includes('Could not reveal summary in Finder'));
  assert.ok(h.document.body.textContent.includes('Synthetic saved summary unavailable'));
  assert.equal(h.radio('Source').getAttribute('aria-checked'), 'true');
  assert.equal(h.container.querySelector('pre code'), code);
  assert.equal(h.container.scrollTop, 240);
  assert.equal(h.document.activeElement, button);
  assert.notEqual(button.getAttribute('aria-disabled'), 'true');
  assert.equal(h.container.querySelector('[download], a[href], [src]'), null);

  const toastText = [...h.document.querySelectorAll('[role="alert"], [role="status"]')].map((node) => node.textContent);
  reveal = deferred<void>();
  await h.click(button);
  assert.equal(calls, 2);
  reveal.resolve();
  await act(async () => reveal.promise);
  assert.deepEqual([...h.document.querySelectorAll('[role="alert"], [role="status"]')].map((node) => node.textContent), toastText, 'resolved shell handoff does not claim Finder displayed the file');
  assert.equal(h.container.querySelector('pre code'), code);
  assert.equal(h.container.scrollTop, 240);

  reveal = deferred<void>();
  await h.click(button);
  await h.render({ ...value, name: 'another-summary.md' });
  reveal.reject(new Error('Departed document failure must stay silent'));
  await act(async () => reveal.promise.catch(() => {}));
  assert.ok(!h.document.body.textContent.includes('Departed document failure'));
  assert.notEqual(h.button('Reveal in Finder').getAttribute('aria-disabled'), 'true');
});
