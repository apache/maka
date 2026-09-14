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

import { deferred, type Deferred } from '@maka/core/test-only/async-primitives';
import type { PlanSessionState, PlanStepStatus } from '@maka/core/plan';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  PlanExecutionPanel,
  usePlanModeState,
  type PlanModeState,
} from '../../renderer/plan-mode-panel.js';

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

test('a running Plan refreshes the panel from the change notification alone', async () => {
  const harness = await mountPanelFixture();

  assert.match(harness.text(), /0\/3 steps/);

  // The Host publishes one of these per committed `update_plan`, while the
  // execution is still active and before any Turn terminal event.
  harness.planChanged.expect().resolve(planState(['completed', 'in_progress', 'pending']));
  await harness.flush();

  assert.match(harness.text(), /1\/3 steps/);
  assert.equal(harness.sessionEvents, 0, 'no session event was needed to refresh');
});

test('a slower earlier read does not put stale progress back on the panel', async () => {
  const harness = await mountPanelFixture();
  const older = harness.planChanged.expect();
  const newer = harness.planChanged.expect();

  // The newer read returns first and paints 2/3; the older one lands afterwards.
  newer.resolve(planState(['completed', 'completed', 'in_progress']));
  await harness.flush();
  assert.match(harness.text(), /2\/3 steps/);

  older.resolve(planState(['in_progress', 'pending', 'pending']));
  await harness.flush();
  assert.match(harness.text(), /2\/3 steps/, 'the stale response must be discarded');
});

test('a response for the Session the user left cannot land on the new one', async () => {
  const harness = await mountPanelFixture();
  const abandoned = harness.planChanged.expect();

  await harness.switchSession('session-2', planState(['completed', 'pending', 'pending']));
  assert.match(harness.text(), /1\/3 steps/);

  abandoned.resolve(planState(['pending', 'pending', 'pending']));
  await harness.flush();
  assert.match(harness.text(), /1\/3 steps/, 'the previous Session read must be discarded');
});

interface PanelFixture {
  readonly sessionEvents: number;
  text(): string;
  planChanged: { expect(): Deferred<PlanSessionState> };
  flush(): Promise<void>;
  switchSession(sessionId: string, state: PlanSessionState): Promise<void>;
}

async function mountPanelFixture(): Promise<PanelFixture> {
  const pendingReads = new Map<string, Deferred<PlanSessionState>[]>();
  const stagedStates = new Map<string, PlanSessionState>();
  let sessionEvents = 0;
  let sessionId = 'session-1';
  let planChangedHandler: (() => void) | undefined;
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
        getPlanState: async (requestedSessionId: string) => {
          const queued = pendingReads.get(requestedSessionId)?.shift();
          if (queued) return await queued.promise;
          const state = stagedStates.get(requestedSessionId);
          if (!state) throw new Error(`no Plan state staged for ${requestedSessionId}`);
          return state;
        },
        subscribeEvents: (_requestedSessionId: string, handler: (event: SessionEvent) => void) => {
          void handler;
          return () => {};
        },
        subscribePlanChanges: (_requestedSessionId: string, handler: () => void) => {
          planChangedHandler = handler;
          return () => {};
        },
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
    const planMode = usePlanModeState({ id: sessionId } as SessionSummary);
    controller = planMode;
    return createElement(PlanExecutionPanel, { planMode });
  }
  const rendered = () =>
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, {
          children: createElement(Harness),
        }),
      }),
    }) as ReactNode;

  stagedStates.set('session-1', planState(['pending', 'pending', 'pending']));
  await act(async () => {
    root.render(rendered());
  });
  await act(async () => {});
  assert.ok(controller);

  return {
    get sessionEvents() {
      return sessionEvents;
    },
    text: () => container.textContent ?? '',
    planChanged: {
      expect: () => {
        const pending = deferred<PlanSessionState>();
        const queued = pendingReads.get(sessionId) ?? [];
        queued.push(pending);
        pendingReads.set(sessionId, queued);
        assert.ok(planChangedHandler, 'the panel did not subscribe to Plan changes');
        planChangedHandler();
        return pending;
      },
    },
    flush: async () => {
      await act(async () => {});
    },
    switchSession: async (nextSessionId, state) => {
      sessionId = nextSessionId;
      stagedStates.set(nextSessionId, state);
      await act(async () => {
        root.render(rendered());
      });
      await act(async () => {});
    },
  };
}

function planState(statuses: PlanStepStatus[]): PlanSessionState {
  const steps = statuses.map((status, index) => ({
    id: `step-${index + 1}`,
    title: `Step ${index + 1}`,
    description: `Do step ${index + 1}.`,
    status,
    updatedAt: 2,
  }));
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    storeVersion: 3,
    proposals: [
      {
        planId: 'plan-1',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        revision: 1,
        title: 'Ship the plan request',
        steps: steps.map((step) => ({
          id: step.id,
          title: step.title,
          description: step.description,
        })),
        status: 'approved',
        submittedAt: 1,
      },
    ],
    executions: [
      {
        executionId: 'execution-1',
        planId: 'plan-1',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        status: 'active',
        steps,
        startedAt: 1,
        updatedAt: 2,
      },
    ],
    latestProposalId: 'proposal-1',
    activeExecutionId: 'execution-1',
  };
}
