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
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatToolCalls } from '@astryxdesign/core/Chat';
import { parseHTML } from 'linkedom';

for (const controlled of [false, true]) {
  test(`tool group defers rows and preserves opened detail (${controlled ? 'controlled' : 'uncontrolled'})`, async (t) => {
    const original = {
      document: globalThis.document, window: globalThis.window,
      IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
    };
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.querySelector('#root')!;
    const root = createRoot(container);
    t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, original); });
    const calls = [0, 1].map(i => ({
      key: String(i), name: 'Read', target: `file-${i}.txt`,
      resultDetail: <input defaultValue="original" />,
    }));
    const render = async (expanded: boolean) => {
      await act(() => root.render(<ChatToolCalls calls={calls} {...(controlled ? { isExpanded: expanded } : {})} />));
    };
    const header = () => container.querySelector('[role="button"]')!;
    const rows = () => container.querySelectorAll('[data-slot="chat-tool-call-row"]');
    const toggle = async (expanded: boolean) => {
      if (controlled) await render(expanded);
      else await act(() => { header().dispatchEvent(new window.Event('click', { bubbles: true })); });
    };

    await render(false);
    assert.equal(header().getAttribute('aria-expanded'), 'false');
    assert.equal(rows().length, 0, 'closed group must not create hidden tool rows');
    assert.ok(document.getElementById(header().getAttribute('aria-controls')!), 'animation shell exists before first expansion');
    await toggle(true);
    assert.equal(rows().length, 2);
    await act(() => { rows()[0]!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    const input = container.querySelector('input')!;
    input.value = 'edited';
    await toggle(false);
    calls.push({ key: '2', name: 'Read', target: 'file-2.txt', resultDetail: <input /> });
    await render(false);
    await toggle(true);
    assert.equal(rows().length, 3, 'new tools appear after reopening');
    assert.equal(container.querySelector('input'), input, 'group close does not discard mounted detail state');
    assert.equal(input.value, 'edited');
  });
}
