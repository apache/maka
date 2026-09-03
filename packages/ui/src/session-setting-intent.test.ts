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
import { useSessionSettingIntent } from './session-setting-intent.js';

type Channels = {
  model: string;
  permission: 'ask' | 'bypass';
};

type Controller = ReturnType<typeof useSessionSettingIntent<Channels>>;

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

test('channels keep independent workers and overlays for the same session', async () => {
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

  const modelWrite = deferred<boolean>();
  const permissionWrite = deferred<boolean>();
  let controller: Controller | undefined;
  await act(async () => {
    root.render(createElement(Harness, {
      capture: (next) => {
        controller = next;
      },
      modelWrite: () => modelWrite.promise,
      permissionWrite: () => permissionWrite.promise,
    }));
  });

  let modelCompletion!: Promise<boolean>;
  let permissionCompletion!: Promise<boolean>;
  await act(async () => {
    modelCompletion = controller!.request('model', 'session-1', 'model-b');
    permissionCompletion = controller!.request('permission', 'session-1', 'bypass');
  });

  assert.equal(controller!.overlayByChannel.model['session-1'], 'model-b');
  assert.equal(controller!.overlayByChannel.permission['session-1'], 'bypass');

  await act(async () => {
    modelWrite.resolve(true);
    permissionWrite.resolve(true);
    assert.deepEqual(await Promise.all([modelCompletion, permissionCompletion]), [true, true]);
  });
});

function Harness({
  capture,
  modelWrite,
  permissionWrite,
}: {
  capture(controller: Controller): void;
  modelWrite(sessionId: string, value: string): Promise<boolean>;
  permissionWrite(sessionId: string, value: 'ask' | 'bypass'): Promise<boolean>;
}) {
  const controller = useSessionSettingIntent<Channels>({
    catalogRevision: 0,
    refreshCatalog: async () => {},
    channels: {
      model: {
        write: modelWrite,
        onWriteError: () => {},
      },
      permission: {
        write: permissionWrite,
        onWriteError: () => {},
      },
    },
  });
  capture(controller);
  return null;
}
