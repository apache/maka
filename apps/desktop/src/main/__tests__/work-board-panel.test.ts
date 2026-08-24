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

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkBoardItem } from '@maka/core/work-board';
import { LocaleProvider } from '@maka/ui';
import type { WorkBoardIpcResult } from '../../shared/work-board-ipc.js';
import { WorkBoardPanel } from '../../renderer/work-board-panel.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT,
};
const mountedRoots: Root[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function item(): WorkBoardItem {
  return {
    schemaVersion: 1,
    id: 'created-item',
    revision: 1,
    scope: { kind: 'inbox' },
    title: 'Later',
    state: 'todo',
    creator: { kind: 'user' },
    provenance: { kind: 'manual' },
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

async function renderPanel(create: (input: unknown) => Promise<WorkBoardIpcResult<WorkBoardItem>>) {
  const { document, window } = parseHTML('<div id="root"></div>');
  const matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (globalThis.window as unknown as { maka: unknown }).maka = {
    workBoard: {
      list: async () => ({ ok: true, value: { items: [], nextCursor: undefined } }),
      create,
      update: async () => ({ ok: true, value: item() }),
      archive: async () => ({ ok: true, value: item() }),
      unarchive: async () => ({ ok: true, value: item() }),
      remove: async () => ({ ok: true, value: undefined }),
      subscribeChanges: () => () => undefined,
    },
  };
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { locale: 'en', children: createElement(WorkBoardPanel, { projectId: null }) },
      ),
    );
    await Promise.resolve();
  });
  return { container, window };
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, originalGlobals);
});

test('prevents a second Work Board create while the first request is pending', async () => {
  const createResult = deferred<WorkBoardIpcResult<WorkBoardItem>>();
  let createCalls = 0;
  const harness = await renderPanel(async () => {
    createCalls += 1;
    return createResult.promise;
  });
  const input = harness.container.querySelector('input');
  assert.ok(input);
  input.value = 'Later';
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
  assert.ok(propsKey, 'missing React props on input');
  const props = (input as unknown as Record<string, unknown>)[propsKey] as {
    onChange?: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
  };
  assert.ok(props.onChange, 'missing React change handler');
  await act(async () => {
    props.onChange?.({ target: input, defaultPrevented: false });
    await Promise.resolve();
  });

  const add = Array.from(harness.container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Add',
  );
  assert.ok(add);
  await act(async () => {
    add.click();
    add.click();
  });

  assert.equal(createCalls, 1);
  assert.equal(add.getAttribute('disabled'), '');

  await act(async () => {
    createResult.resolve({ ok: true, value: item() });
    await createResult.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(createCalls, 1);
  assert.equal(input.getAttribute('disabled'), null);
});
