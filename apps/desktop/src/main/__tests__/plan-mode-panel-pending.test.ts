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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { PlanSessionState } from '@maka/core/plan';
import type { SessionSummary } from '@maka/core/session';
import type { PlanControlIpcResult } from '../../shared/plan-mode-ipc.js';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { usePlanModeState, type PlanModeState } from '../../renderer/plan-mode-panel.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  CSS: globalThis.CSS,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('plan controls stay pending until the bridge promise settles', async () => {
  const planState = { storeVersion: 1 } as unknown as PlanSessionState;
  const revision = deferred<PlanControlIpcResult<PlanSessionState>>();
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, {
    matchMedia,
    scrollTo() {},
    maka: {
      sessions: {
        getPlanState: async () => planState,
        subscribeEvents: () => () => {},
        subscribePlanChanges: () => () => {},
        requestPlanRevision: () => revision.promise,
      },
    },
  });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  let controller: PlanModeState | undefined;
  function Harness() {
    controller = usePlanModeState({ id: 'session-1' } as SessionSummary);
    return null;
  }
  await act(async () => {
    root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, { children: createElement(Harness) }),
      }),
    }));
  });
  assert.equal(controller?.pending, false);

  let inFlight!: Promise<void>;
  await act(async () => {
    inFlight = controller!.requestRevision('proposal-1');
  });
  assert.equal(controller?.pending, true, 'pending must hold while the bridge call is unsettled');

  revision.resolve({ ok: true, value: planState });
  await act(async () => {
    await inFlight;
  });
  assert.equal(controller?.pending, false);
});
