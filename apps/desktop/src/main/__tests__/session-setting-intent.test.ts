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
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useSessionSettingIntent } from '@maka/ui';

type SessionSettingIntentController<Value> = ReturnType<
  typeof useSessionSettingIntent<{ setting: Value }>
>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('Runtime leaving Plan after approval supersedes the committed Plan overlay', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  let controller: SessionSettingIntentController<boolean> | undefined;
  const render = async (catalogRevision: number, catalogValue: boolean) => {
    await act(async () => {
      root.render(createElement(Harness, {
        catalogRevision,
        catalogValue,
        capture: (next) => {
          controller = next;
        },
      }));
    });
  };

  await render(0, false);
  await act(async () => {
    await controller?.request('setting', 'session-1', true);
  });
  assert.equal(container.querySelector('output')?.getAttribute('data-value'), 'true');

  // Runtime automatically leaves Plan after approval. This is a successful,
  // causally newer catalog observation, so its Agent value must win even
  // though it differs from the renderer's earlier committed Plan value.
  await render(1, false);

  assert.equal(container.querySelector('output')?.getAttribute('data-value'), 'false');
});

test('rapid requests share the worker and settle only after the latest value commits', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  const writes: Array<{ value: string; result: ReturnType<typeof deferred<boolean>> }> = [];
  let controller: SessionSettingIntentController<string> | undefined;
  await act(async () => {
    root.render(createElement(LatestIntentHarness, {
      capture: (next) => {
        controller = next;
      },
      write: (_sessionId, value) => {
        const result = deferred<boolean>();
        writes.push({ value, result });
        return result.promise;
      },
    }));
  });

  let first!: Promise<boolean>;
  let latest!: Promise<boolean>;
  await act(async () => {
    first = controller!.request('setting', 'session-1', 'first');
    latest = controller!.request('setting', 'session-1', 'latest');
  });
  let latestSettled = false;
  void latest.then(() => {
    latestSettled = true;
  });
  await Promise.resolve();

  assert.equal(latestSettled, false);
  assert.deepEqual(writes.map((entry) => entry.value), ['first']);
  assert.equal(container.querySelector('output')?.getAttribute('data-value'), 'latest');

  await act(async () => {
    writes[0]!.result.resolve(true);
    await writes[0]!.result.promise;
  });
  assert.deepEqual(writes.map((entry) => entry.value), ['first', 'latest']);
  assert.equal(latestSettled, false);

  await act(async () => {
    writes[1]!.result.resolve(true);
    await Promise.all([first, latest]);
  });
  assert.equal(latestSettled, true);
  assert.equal(await first, true);
  assert.equal(await latest, true);
});

function Harness({
  catalogRevision,
  catalogValue,
  capture,
}: {
  catalogRevision: number;
  catalogValue: boolean;
  capture(controller: SessionSettingIntentController<boolean>): void;
}) {
  const controller = useSessionSettingIntent<{ setting: boolean }>({
    catalogRevision,
    refreshCatalog: async () => {
      throw new Error('catalog unavailable');
    },
    channels: {
      setting: {
        write: async () => true,
        onWriteError: () => {},
      },
    },
  });
  capture(controller);
  return createElement('output', {
    'data-value': (controller.overlayByChannel.setting['session-1'] ?? catalogValue).toString(),
  });
}

function LatestIntentHarness({
  capture,
  write,
}: {
  capture(controller: SessionSettingIntentController<string>): void;
  write(sessionId: string, value: string): Promise<boolean>;
}) {
  const controller = useSessionSettingIntent<{ setting: string }>({
    catalogRevision: 0,
    refreshCatalog: async () => {},
    channels: {
      setting: {
        write,
        onWriteError: () => {},
      },
    },
  });
  capture(controller);
  return createElement('output', {
    'data-value': controller.overlayByChannel.setting['session-1'],
  });
}
