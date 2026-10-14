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
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { PlanSessionState } from '@maka/core/plan';
import { AstryxLocaleProvider, ChatSurfaceLayout, LocaleProvider, ToastProvider } from '@maka/ui';
import {
  PlanChatView, PlanExecutionSurface, PlanProvider, PlanServicesProvider,
  type PlanServices,
} from '../../renderer/features/conversation/index.js';
import { createDesktopConversationPlanServices } from '../../renderer/platform/desktop/create-conversation-plan-services.js';
import type { MakaBridge } from '../../preload/bridge-contract.js';

const saved = Object.fromEntries([
  'window', 'document', 'HTMLElement', 'HTMLIFrameElement', 'Event', 'Node', 'CSS',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Plan updates reach proposal and execution readers without rendering their frame or sibling', async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    media, matches: false, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia, scrollTo() {} });
  Object.assign(globalThis, {
    window, document, matchMedia, HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event, Node: window.Node, CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root')!;
  root = createRoot(container);
  let snapshot = planSnapshot(false);
  let notifyPlan: (() => void) | undefined;
  let reads = 0;
  let subscriptions = 0;
  let releases = 0;
  let frameRenders = 0;
  let siblingRenders = 0;
  let siblingMounts = 0;
  const services: PlanServices = {
    getPlanState: async () => { reads += 1; return snapshot; },
    subscribeEvents: () => { subscriptions += 1; return () => { releases += 1; }; },
    subscribePlanChanges: (_id, handler) => {
      subscriptions += 1; notifyPlan = handler;
      return () => { releases += 1; notifyPlan = undefined; };
    },
    requestPlanRevision: async () => ({ ok: true, value: snapshot }),
    approvePlan: async () => ({ ok: true, value: { turnId: 'turn', executionId: 'execution' } }),
    resumePlan: async () => ({ ok: true, value: { turnId: 'turn', executionId: 'execution' } }),
    abandonPlanExecution: async () => ({ ok: true, value: snapshot }),
  };
  function Sibling() {
    siblingRenders += 1;
    useEffect(() => { siblingMounts += 1; }, []);
    return createElement('input', { defaultValue: 'keep this draft' });
  }
  function Frame() {
    frameRenders += 1;
    return createElement(ChatSurfaceLayout, {
      scrollToBottomLabel: 'Scroll to bottom',
      composer: createElement('div', null, createElement(PlanExecutionSurface), createElement(Sibling)),
      children: createElement(PlanChatView, { messages: [], scrollBehavior: 'auto', onNew: () => {} }),
    });
  }
  await act(async () => {
    root!.render(createElement(LocaleProvider, { locale: 'en', children:
      createElement(AstryxLocaleProvider, { children:
        createElement(ToastProvider, { children:
          createElement(PlanServicesProvider, { services, children:
            createElement(PlanProvider, { session: { id: 'session' }, children: createElement(Frame) }),
          }),
        }),
      }),
    }));
  });
  assert.equal(reads, 1, 'two readers must share one Plan query owner');
  assert.equal(subscriptions, 2, 'one event and one Plan-change subscription');
  assert.match(container.textContent ?? '', /Review this plan/);
  const draftNode = container.querySelector('input');
  assert.ok(draftNode);
  draftNode.value = 'edited draft';
  assert.deepEqual([frameRenders, siblingRenders, siblingMounts], [1, 1, 1]);

  snapshot = planSnapshot(true);
  await act(async () => { notifyPlan!(); });
  assert.match(container.textContent ?? '', /1\/2 steps/);
  assert.deepEqual([frameRenders, siblingRenders, siblingMounts], [1, 1, 1]);
  assert.equal(container.querySelector('input'), draftNode);
  assert.equal(draftNode.value, 'edited draft');
  assert.equal(subscriptions, 2, 'snapshot updates do not reinstall subscriptions');
  await act(() => root!.unmount());
  root = undefined;
  assert.equal(releases, 2);
});

test('Plan Desktop adapter preserves the injected bridge methods, including non-enumerable ports', async () => {
  const calls: string[] = [];
  const sessions = new Proxy({}, { get: (_target, method) => {
    if (method === 'getPlanState') return async (id: string) => { calls.push(id); return planSnapshot(false); };
    return undefined;
  } });
  const services = createDesktopConversationPlanServices({ sessions } as MakaBridge);
  assert.equal(services, sessions);
  await services.getPlanState('original-session');
  assert.deepEqual(calls, ['original-session']);
});

function planSnapshot(executing: boolean): PlanSessionState {
  const steps = [1, 2].map((n) => ({ id: `step-${n}`, title: `Step ${n}`, description: `Do step ${n}` }));
  return {
    schemaVersion: 1, sessionId: 'session', storeVersion: executing ? 2 : 1,
    latestProposalId: 'proposal', activeExecutionId: executing ? 'execution' : undefined,
    proposals: [{
      planId: 'plan', proposalId: 'proposal', sessionId: 'session', turnId: 'turn',
      revision: 1, title: 'Review this plan', steps,
      status: executing ? 'approved' : 'pending_approval', submittedAt: 1,
    }],
    executions: executing ? [{
      executionId: 'execution', planId: 'plan', proposalId: 'proposal', sessionId: 'session',
      status: 'active', startedAt: 1, updatedAt: 2,
      steps: steps.map((step, i) => ({ ...step, status: i === 0 ? 'completed' : 'in_progress', updatedAt: 2 })),
    }] : [],
  };
}
