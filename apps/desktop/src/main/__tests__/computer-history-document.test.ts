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
import type { ComputerHistoryDetail } from '@maka/core/computer-history';
import type { UiLocale } from '@maka/core/ui-locale';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
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
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    CSS: { supports: () => false, escape: (value: string) => value },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
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
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return {
    container, copied,
    render: (value: HistoryDocument, locale: UiLocale = 'en') => act(async () => root.render(
      createElement(LocaleProvider, {
        locale,
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ComputerHistoryDocument, { key: locale, document: value }),
        }),
      }),
    )),
    click: (element: Element) => act(async () => {
      element.dispatchEvent(new window.Event('click', { bubbles: true }));
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
    await h.click(h.radio(source));
    assert.equal(h.radio(source).getAttribute('aria-checked'), 'true');
    const code = h.container.querySelector('pre code');
    assert.ok(code);
    assert.ok(code.textContent.includes('"title": "Observed <window> & notes"'));
    assert.ok(code.textContent.includes('<tag attr="x">&value</tag>'));
    assert.equal(code.querySelector('window, tag'), null, 'source angle brackets remain text');
    const copy = h.container.querySelector('pre button');
    assert.ok(copy);
    await h.click(copy);
    assert.deepEqual(Buffer.from(h.copied.at(-1) ?? ''), Buffer.from(value.markdown), `${locale}: copied source must preserve CRLF and trailing whitespace`);
    await h.click(h.radio(preview));
    assert.ok(h.container.querySelector('h3'));
    await h.click(h.radio(source));
    const copyAgain = h.container.querySelector('pre button');
    assert.ok(copyAgain);
    await h.click(copyAgain);
    assert.equal(h.copied.at(-1), value.markdown);
  }
  assert.equal(h.copied.length, 6);
});
