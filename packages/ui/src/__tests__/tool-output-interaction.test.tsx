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
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { SessionToolResultProvider, ToolResultHostProvider, type ToolOutputOpenRequest } from '../tool-activity/tool-result-context.js';
import { LocaleProvider } from '../locale-context.js';
import { ToolCallDetail, ToolTrow } from '../tool-activity.js';
import { ToolResultPreview } from '../tool-activity/tool-result-preview.js';

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
const globals = { document: globalThis.document, window: globalThis.window,
  matchMedia: globalThis.matchMedia, requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame, ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver };
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  Object.assign(globalThis, globals);
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, 'navigator');
  if (actEnvironmentDescriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironmentDescriptor);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});
function mount() {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const container = document.querySelector('#root')!;
  root = createRoot(container);
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === label);
    assert.ok(button, `missing action: ${label}`);
    await act(async () => { button.click(); });
  };
  return { container, click };
}

it('keeps all retained shell output in a tail-pinned viewport', () => {
  const markup = renderToStaticMarkup(<LocaleProvider locale="en"><ToolResultPreview content={{
    kind: 'terminal', cwd: '/repo', cmd: 'npm test', status: 'completed', exitCode: 0,
    output: { mode: 'pipes', stdout: 'FIRST_LINE\n' + 'progress\n'.repeat(40) + 'ALL_TESTS_PASSED', stderr: '', redacted: false, stdoutTruncated: false, stderrTruncated: false },
  }} /></LocaleProvider>);
  assert.match(markup, /ALL_TESTS_PASSED/);
  assert.match(markup, /FIRST_LINE/);
  assert.match(markup, /role="region"/);
  assert.match(markup, /tabindex="0"/);
  assert.doesNotMatch(markup, /Open full output|more lines/);
});

it('pauses on a one-pixel upward scroll and offers resume only away from the tail', async () => {
  const { container, click } = mount();
  const render = (seq: number) => <LocaleProvider locale="en"><ToolCallDetail item={{
    toolUseId: 'stream', toolName: 'Bash', status: 'running', args: { command: 'npm test' },
    outputChunks: [{ seq, stream: 'stdout', text: `progress ${seq}`, redacted: false, createdAt: seq }],
  }} /></LocaleProvider>;
  await act(async () => { root!.render(render(1)); });
  const pre = container.querySelector('pre')!;
  let top = 0;
  Object.defineProperties(pre, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.min(800, Math.max(0, value)); } } });
  await act(async () => { root!.render(render(2)); });
  assert.equal(pre.scrollTop, 800);
  const wheel = new window.Event('wheel');
  Object.defineProperty(wheel, 'deltaY', { value: -1 });
  await act(async () => { pre.dispatchEvent(wheel); });
  pre.scrollTop = 799;
  await act(async () => { pre.dispatchEvent(new window.Event('scroll')); });
  await act(async () => { root!.render(render(3)); });
  assert.equal(pre.scrollTop, 799);
  assert.doesNotMatch(container.textContent!, /Jump to bottom/);
  pre.scrollTop = 600;
  await act(async () => { pre.dispatchEvent(new window.Event('scroll')); });
  await click('Jump to bottom');
  await act(async () => { root!.render(render(4)); });
  assert.equal(pre.scrollTop, 800);
  assert.doesNotMatch(container.textContent!, /Jump to bottom/);
});

it('passes the archive source bound to the originating session', async () => {
  const { click } = mount();
  const requests: ToolOutputOpenRequest[] = [];
  const render = (sessionId: string) => <LocaleProvider locale="en"><ToolResultHostProvider
    value={request => requests.push(request)}
  ><SessionToolResultProvider value={sessionId}><ToolResultPreview content={{
    kind: 'archived_tool_result', status: 'not_loaded', resourceRef: 'maka://archive-ledger/v1/evidence', bodySha256: '0'.repeat(64),
    originalBytes: 42, originalEstimatedTokens: 10, runtimeEventId: 'event', toolCallId: 'tool', toolName: 'Inspect',
    rewriteVersion: 2, reason: 'stale_tool_result_pruned_before_compact',
  }} /></SessionToolResultProvider></ToolResultHostProvider></LocaleProvider>;
  await act(() => root!.render(render('old')));
  await click('Open full output');
  await act(() => root!.render(render('new')));
  await click('Open full output');
  assert.deepEqual(requests.map(request => request.source), [
    { kind: 'archive', sessionId: 'old', identity: {
      resourceRef: 'maka://archive-ledger/v1/evidence', bodySha256: '0'.repeat(64), originalBytes: 42,
    } },
    { kind: 'archive', sessionId: 'new', identity: {
      resourceRef: 'maka://archive-ledger/v1/evidence', bodySha256: '0'.repeat(64), originalBytes: 42,
    } },
  ]);
});

it('keeps complete diff hunks when only the following hunk is outside the budget', () => {
  const diff = '@@ -1,1 +1,1 @@\n-old\n+new\n@@ -10,27 +10,27 @@\n'
    + Array.from({ length: 27 }, (_, i) => `-old${i}\n+new${i}`).join('\n')
    + '\n context\n context\n@@ -100,1 +100,1 @@\n-last\n+last';
  const markup = renderToStaticMarkup(<LocaleProvider locale="en"><ToolResultPreview
    content={{ kind: 'file_diff', paths: ['a.txt'], diff }} /></LocaleProvider>);
  assert.match(markup, /new26/);
});
