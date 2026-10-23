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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { MarkdownBody } from '../markdown-body.js';
import { EXTRA_CODE_STREAM_DELAY_MS, MAX_EXTRA_CODE_LENGTH } from '../markdown-code-highlighting.js';

const originalGlobals = {
  document: globalThis.document, window: globalThis.window,
  matchMedia: globalThis.matchMedia, requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

afterEach(() => Object.assign(globalThis, {
  ...originalGlobals, IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
}));

function markdownRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(window, { getComputedStyle: () => ({ direction: 'ltr', writingMode: 'horizontal-tb' }) });
  Object.assign(globalThis, {
    document, window, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  return { root: createRoot(container), container };
}

function fence(language: string, code: string): string {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.ok(predicate(), 'optional syntax highlighting did not settle');
}

test('adds delayed Java syntax spans to the existing CodeBlock without creating HTML', async () => {
  const { root, container } = markdownRoot();
  const code = 'public class X {\n  /* first\n   second 中文😀 */\n  String text = "<script>alert(1)</script>&amp;";\n  return 42;\n}';
  await act(() => root.render(<MarkdownBody text={fence('java', code)} density="compact" />));
  const before = container.querySelector('code')?.textContent;
  await settle(() => !!container.querySelector('.astryx-token-keyword'));
  assert.equal(container.querySelector('code')?.textContent, before);
  assert.ok(container.querySelector('.astryx-code-block'));
  assert.ok([...container.querySelectorAll('.astryx-token-comment')].some(node => node.textContent?.includes('second 中文😀')));
  assert.equal(container.querySelector('.astryx-token-number')?.textContent, '42');
  assert.equal(container.querySelector('script'), null);
  assert.ok([...container.querySelectorAll('button')].some(node => /copy/i.test(node.getAttribute('aria-label') ?? '')));
  await act(() => root.unmount());
});

test('normalizes punctuated aliases through the public AST for both Markdown densities', () => {
  for (const density of ['default', 'compact'] as const) {
    for (const [alias, canonical] of [['c++', 'cpp'], ['c#', 'csharp'], ['JAVA', 'java'], ['golang', 'go'], ['rs', 'rust']]) {
      const markup = renderToStaticMarkup(<MarkdownBody text={fence(alias!, 'return 42;')} density={density} />);
      assert.ok(markup.includes(`>${canonical}<`), markup);
      assert.ok(markup.includes('return 42;'));
    }
  }
});

test('does not rewrite language-looking text inside code, inline code, or prose', () => {
  const text = ['Use `c++` and c# as text.', '', '````text\n```c#\nkeep literal\n```\n````'].join('\n');
  const markup = renderToStaticMarkup(<MarkdownBody text={text} />);
  assert.ok(markup.includes('Use <code'));
  assert.ok(markup.includes('c++'));
  assert.ok(markup.includes('```c#'));
  assert.ok(!markup.includes('>csharp<'));
});

test('leaves existing TypeScript highlighting on the built-in synchronous path', async () => {
  const { root, container } = markdownRoot();
  await act(() => root.render(<MarkdownBody text={fence('typescript', 'const answer = "hello";')} />));
  assert.equal(container.querySelector('.astryx-token-keyword')?.textContent, 'const');
  assert.equal(container.querySelector('.astryx-token-string')?.textContent, '"hello"');
  await act(() => root.unmount());
});

test('coalesces a live stream and rejects obsolete code or language results', async () => {
  const { root, container } = markdownRoot();
  const first = fence('java', 'public class Old {}');
  const second = '```rust\nfn main() { let message = "new 中文😀"; }';
  await act(() => root.render(<MarkdownBody text={first} streaming settledText={first} />));
  await act(() => root.render(<MarkdownBody text={second} streaming settledText={second} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, EXTRA_CODE_STREAM_DELAY_MS / 3)); });
  assert.equal(container.querySelector('.astryx-token-keyword'), null);
  await settle(() => !!container.querySelector('.astryx-token-keyword'));
  assert.equal(container.querySelector('.astryx-token-keyword')?.textContent, 'fn');
  assert.ok(!container.textContent?.includes('Old'));
  assert.ok(container.querySelector('.astryx-token-string')?.textContent?.includes('new 中文😀'));
  const third = fence('go', 'package main\nfunc main() {}');
  await act(() => root.render(<MarkdownBody text={third} />));
  await settle(() => container.querySelector('.astryx-token-keyword')?.textContent === 'package');
  assert.ok(!container.textContent?.includes('new 中文😀'));
  await act(() => root.unmount());
});

test('keeps oversized and unknown-language blocks readable and uncoloured', async () => {
  const { root, container } = markdownRoot();
  const code = `/*${'x'.repeat(MAX_EXTRA_CODE_LENGTH)}*/ tail-marker`;
  await act(async () => root.render(<MarkdownBody text={fence('java', code)} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(container.querySelector('.astryx-token-keyword'), null);
  assert.ok(container.textContent?.includes('tail-marker'));
  assert.ok(container.querySelector('code')?.textContent?.includes('x'.repeat(MAX_EXTRA_CODE_LENGTH)));
  await act(() => root.render(<MarkdownBody text={fence('unsupported', 'return 42;')} />));
  assert.equal(container.querySelector('[class*="astryx-token-"]'), null);
  assert.ok(container.textContent?.includes('return 42;'));
  await act(() => root.unmount());
});

test('cancels pending token preparation when its code block unmounts', async () => {
  const { root } = markdownRoot();
  const text = fence('java', 'public class X {}');
  await act(() => root.render(<MarkdownBody text={text} streaming settledText={text} />));
  await act(() => root.unmount());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, EXTRA_CODE_STREAM_DELAY_MS + 10)); });
});
