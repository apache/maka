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
import {
  type SessionSettingIntentChannel,
  type SessionSettingIntentWriteResult,
  useSessionSettingIntent,
} from './session-setting-intent.js';

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

test('revision-aware channel types require a catalog Session revision reader', () => {
  // @ts-expect-error A revision receipt requires catalogSessionRevision.
  const invalidChannel: SessionSettingIntentChannel<string> = {
    write: async () => ({ committed: true, sessionRevision: 2 }),
    onWriteError: () => {},
  };

  assert.equal(typeof invalidChannel.write, 'function');
});

test('preserves the public Session setting write result union', () => {
  const booleanResult: SessionSettingIntentWriteResult = true;
  const revisionResult: SessionSettingIntentWriteResult = {
    committed: true,
    sessionRevision: 2,
  };

  assert.equal(booleanResult, true);
  assert.equal(revisionResult.sessionRevision, 2);
});

test('revision-aware commits retire only after the target session observes that revision', async () => {
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

  let controller: Controller | undefined;
  const render = (catalogRevision: number, sessionRevision: number) => {
    root.render(createElement(RevisionHarness, {
      capture: (next) => {
        controller = next;
      },
      catalogRevision,
      sessionRevision,
    }));
  };

  await act(async () => render(0, 0));
  await act(async () => {
    assert.equal(await controller!.request('model', 'session-1', 'model-b'), true);
  });
  assert.equal(controller!.overlayByChannel.model['session-1'], 'model-b');

  await act(async () => render(1, 1));
  assert.equal(controller!.overlayByChannel.model['session-1'], 'model-b');

  await act(async () => render(2, 2));
  assert.equal(controller!.overlayByChannel.model['session-1'], undefined);
});

test('rapid revision-aware requests retire only after the last committed revision', async () => {
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

  const writes: Array<{
    value: string;
    result: ReturnType<typeof deferred<{
      committed: boolean;
      sessionRevision: number;
    }>>;
  }> = [];
  let controller: Controller | undefined;
  const render = (catalogRevision: number, sessionRevision: number) => {
    root.render(createElement(RapidRevisionHarness, {
      capture: (next) => {
        controller = next;
      },
      catalogRevision,
      sessionRevision,
      write: async (_sessionId, value) => {
        const result = deferred<{ committed: boolean; sessionRevision: number }>();
        writes.push({ value, result });
        return result.promise;
      },
    }));
  };

  await act(async () => render(0, 0));
  let completion!: Promise<boolean>;
  await act(async () => {
    completion = controller!.request('model', 'session-1', 'model-a');
    void controller!.request('model', 'session-1', 'model-b');
    void controller!.request('model', 'session-1', 'model-c');
  });
  assert.equal(controller!.overlayByChannel.model['session-1'], 'model-c');
  assert.deepEqual(writes.map(({ value }) => value), ['model-a']);

  await act(async () => {
    writes[0]!.result.resolve({ committed: true, sessionRevision: 1 });
    await Promise.resolve();
  });
  assert.deepEqual(writes.map(({ value }) => value), ['model-a', 'model-c']);

  await act(async () => {
    writes[1]!.result.resolve({ committed: true, sessionRevision: 3 });
    assert.equal(await completion, true);
  });
  assert.equal(controller!.overlayByChannel.model['session-1'], 'model-c');

  await act(async () => render(1, 1));
  assert.equal(controller!.overlayByChannel.model['session-1'], 'model-c');

  await act(async () => render(2, 2));
  assert.equal(controller!.overlayByChannel.model['session-1'], 'model-c');

  await act(async () => render(3, 3));
  assert.equal(controller!.overlayByChannel.model['session-1'], undefined);
});

test('rapid requests drain to the latest requested value', async () => {
  const { controller, writes } = await mountIntentHarness();

  let completion!: Promise<boolean>;
  await act(async () => {
    completion = controller().request('model', 'session-1', 'plan');
    void controller().request('model', 'session-1', 'agent');
  });
  assert.deepEqual(writes.map(({ value }) => value), ['plan']);
  assert.equal(controller().overlayByChannel.model['session-1'], 'agent');

  await act(async () => {
    writes[0]!.result.resolve(true);
    await Promise.resolve();
  });
  assert.deepEqual(writes.map(({ value }) => value), ['plan', 'agent']);

  await act(async () => {
    writes[1]!.result.resolve(true);
    assert.equal(await completion, true);
  });
  assert.equal(controller().overlayByChannel.model['session-1'], 'agent');
});

test('a rejected catalog refresh does not roll back a committed value', async () => {
  const { controller, writes } = await mountIntentHarness({
    refreshCatalog: async () => {
      throw new Error('catalog unavailable');
    },
  });

  let completion!: Promise<boolean>;
  await act(async () => {
    completion = controller().request('model', 'session-1', 'plan');
    writes[0]!.result.resolve(true);
    assert.equal(await completion, true);
  });
  assert.equal(controller().overlayByChannel.model['session-1'], 'plan');
});

test('a newer request still writes after the in-flight write fails', async () => {
  const errors: Array<{ attempted: string; error: unknown }> = [];
  const { controller, writes } = await mountIntentHarness({ errors });

  let completion!: Promise<boolean>;
  await act(async () => {
    completion = controller().request('model', 'session-1', 'plan');
    void controller().request('model', 'session-1', 'agent');
    writes[0]!.result.reject(new Error('first write failed'));
    await Promise.resolve();
  });
  assert.deepEqual(writes.map(({ value }) => value), ['plan', 'agent']);
  assert.deepEqual(errors, []);

  await act(async () => {
    writes[1]!.result.resolve(true);
    assert.equal(await completion, true);
  });
  assert.equal(controller().overlayByChannel.model['session-1'], 'agent');
});

test('clearing a session drops its pending and queued requests', async () => {
  const { controller, writes } = await mountIntentHarness();

  let completion!: Promise<boolean>;
  await act(async () => {
    completion = controller().request('model', 'session-1', 'plan');
    void controller().request('model', 'session-1', 'agent');
    controller().clear('session-1');
    assert.equal(await completion, false);
  });
  assert.equal(controller().overlayByChannel.model['session-1'], undefined);

  await act(async () => {
    writes[0]!.result.resolve(true);
    await Promise.resolve();
  });
  assert.deepEqual(writes.map(({ value }) => value), ['plan']);
  assert.equal(controller().overlayByChannel.model['session-1'], undefined);
});

async function mountIntentHarness(options?: {
  refreshCatalog?: () => Promise<unknown>;
  errors?: Array<{ attempted: string; error: unknown }>;
}) {
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

  const writes: Array<{
    value: string;
    result: ReturnType<typeof deferred<boolean>> & { reject(error: unknown): void };
  }> = [];
  let captured: Controller | undefined;
  await act(async () => {
    root.render(createElement(IntentHarness, {
      capture: (next) => {
        captured = next;
      },
      refreshCatalog: options?.refreshCatalog ?? (async () => {}),
      modelWrite: async (_sessionId, value) => {
        let reject!: (error: unknown) => void;
        const pending = deferred<boolean>();
        const promise = new Promise<boolean>((resolve, rejectPromise) => {
          reject = rejectPromise;
          pending.promise.then(resolve, rejectPromise);
        });
        const result = { ...pending, promise, reject };
        writes.push({ value, result });
        return promise;
      },
      onModelWriteError: (_sessionId, error, attempted) => {
        options?.errors?.push({ attempted, error });
      },
    }));
  });
  return {
    controller: () => {
      assert.ok(captured);
      return captured;
    },
    writes,
  };
}

function IntentHarness({
  capture,
  refreshCatalog,
  modelWrite,
  onModelWriteError,
}: {
  capture(controller: Controller): void;
  refreshCatalog(): Promise<unknown>;
  modelWrite(sessionId: string, value: string): Promise<boolean>;
  onModelWriteError(sessionId: string, error: unknown, attempted: string): void;
}) {
  const controller = useSessionSettingIntent<Channels>({
    catalogRevision: 0,
    refreshCatalog,
    channels: {
      model: { write: modelWrite, onWriteError: onModelWriteError },
      permission: { write: async () => true, onWriteError: () => {} },
    },
  });
  capture(controller);
  return null;
}

function RapidRevisionHarness({
  capture,
  catalogRevision,
  sessionRevision,
  write,
}: {
  capture(controller: Controller): void;
  catalogRevision: number;
  sessionRevision: number;
  write(
    sessionId: string,
    value: string,
  ): Promise<{ committed: boolean; sessionRevision: number }>;
}) {
  const controller = useSessionSettingIntent<Channels>({
    catalogRevision,
    refreshCatalog: async () => {},
    channels: {
      model: {
        write,
        catalogSessionRevision: () => sessionRevision,
        onWriteError: () => {},
      },
      permission: {
        write: async () => true,
        onWriteError: () => {},
      },
    },
  });
  capture(controller);
  return null;
}

function RevisionHarness({
  capture,
  catalogRevision,
  sessionRevision,
}: {
  capture(controller: Controller): void;
  catalogRevision: number;
  sessionRevision: number;
}) {
  const controller = useSessionSettingIntent<Channels>({
    catalogRevision,
    refreshCatalog: async () => {},
    channels: {
      model: {
        write: async () => ({ committed: true, sessionRevision: 2 }),
        catalogSessionRevision: () => sessionRevision,
        onWriteError: () => {},
      },
      permission: {
        write: async () => true,
        onWriteError: () => {},
      },
    },
  });
  capture(controller);
  return null;
}

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
