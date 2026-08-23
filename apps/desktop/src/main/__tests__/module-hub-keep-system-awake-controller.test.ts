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
import {
  createFakeModuleHubServices,
  type KeepSystemAwakeController,
  useKeepSystemAwakeController,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('falls back safely after the initial read fails and propagates write failures', async () => {
  const { root } = installReactRenderer();
  const services = createFakeModuleHubServices({
    clientSettings: {
      supported: true,
      getKeepSystemAwake: async () => {
        throw new Error('bad settings.json');
      },
      setKeepSystemAwake: async () => {
        throw new Error('write failed');
      },
      subscribeChanges: () => () => undefined,
    },
  });
  let controller: KeepSystemAwakeController | undefined;

  function Probe() {
    controller = useKeepSystemAwakeController(services);
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller?.keepSystemAwake, false);
  await assert.rejects(() => controller!.setKeepSystemAwake(true), /write failed/);
  assert.equal(controller?.keepSystemAwake, false);
});

test('external changes win over a slow write and the subscription is disposed', async () => {
  const { root } = installReactRenderer();
  const write = deferred<boolean>();
  let persisted = false;
  let changed: (() => void) | undefined;
  let disposed = 0;
  const services = createFakeModuleHubServices({
    clientSettings: {
      supported: true,
      getKeepSystemAwake: async () => persisted,
      setKeepSystemAwake: async () => write.promise,
      subscribeChanges: (handler) => {
        changed = handler;
        return () => {
          disposed += 1;
        };
      },
    },
  });
  let controller: KeepSystemAwakeController | undefined;

  function Probe() {
    controller = useKeepSystemAwakeController(services);
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller?.keepSystemAwake, false);
  const pendingWrite = controller!.setKeepSystemAwake(false);
  persisted = true;
  await act(async () => {
    changed?.();
    await Promise.resolve();
  });
  assert.equal(controller?.keepSystemAwake, true);

  write.resolve(false);
  await act(async () => pendingWrite);
  assert.equal(controller?.keepSystemAwake, true);

  await act(async () => root.unmount());
  assert.equal(disposed, 1);
});

test('unsupported settings stay hidden and never probe an unavailable bridge', async () => {
  const { root } = installReactRenderer();
  let reads = 0;
  let subscriptions = 0;
  const services = createFakeModuleHubServices({
    clientSettings: {
      supported: false,
      getKeepSystemAwake: async () => {
        reads += 1;
        return true;
      },
      setKeepSystemAwake: async (next) => next,
      subscribeChanges: () => {
        subscriptions += 1;
        return () => undefined;
      },
    },
  });
  let controller: KeepSystemAwakeController | undefined;

  function Probe() {
    controller = useKeepSystemAwakeController(services);
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller?.supported, false);
  assert.equal(controller?.keepSystemAwake, undefined);
  assert.equal(reads, 0);
  assert.equal(subscriptions, 0);
  await assert.rejects(() => controller!.setKeepSystemAwake(true), /unavailable/);
});

test('a pending initial read cannot publish after controller disposal', async () => {
  const { root } = installReactRenderer();
  const read = deferred<boolean>();
  let disposed = 0;
  const services = createFakeModuleHubServices({
    clientSettings: {
      supported: true,
      getKeepSystemAwake: async () => read.promise,
      setKeepSystemAwake: async (next) => next,
      subscribeChanges: () => () => {
        disposed += 1;
      },
    },
  });
  let controller: KeepSystemAwakeController | undefined;

  function Probe() {
    controller = useKeepSystemAwakeController(services);
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  const disposedSnapshot = controller;
  assert.equal(disposedSnapshot?.keepSystemAwake, undefined);
  await act(async () => root.unmount());
  read.resolve(true);
  await act(async () => read.promise);

  assert.equal(disposed, 1);
  assert.equal(disposedSnapshot?.keepSystemAwake, undefined);
});

afterEach(() => cleanupFakeDom());
