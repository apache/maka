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
import type { PlanProposal, PlanSessionState, PlanStepStatus } from '@maka/core/plan';
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

const mountedRoots: Root[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) await act(() => root.unmount());
  Object.assign(globalThis, originalGlobals);
});

const beforeApproval = planState(['completed', 'pending', 'pending']);
const afterApproval = planState(['completed', 'completed', 'in_progress']);

// A late success must not roll progress back, a late failure must not raise an
// error the panel no longer owns, and the read the panel does own still reports its own.
test('only the newest read of the Session on screen may publish', async () => {
  const harness = await mountPanelFixture();
  const older = harness.planChanged.expect();
  const newer = harness.planChanged.expect();
  await newer.resolve(afterApproval);
  const afterNewer = harness.text();
  await older.resolve(beforeApproval);
  assert.match(afterNewer, /2\/3 steps/);
  assert.equal(harness.text(), afterNewer, 'a superseded success must be discarded');

  const failing = harness.planChanged.expect();
  await harness.planChanged.expect().resolve(beforeApproval);
  await failing.reject(new Error('Plan projection is unavailable'));
  assert.match(harness.text(), /1\/3 steps/);
  assert.equal(harness.error(), undefined, 'a superseded failure must stay silent');

  await harness.planChanged.expect().reject(new Error('Plan projection is unavailable'));
  assert.match(harness.text(), /1\/3 steps/, 'the last known projection is kept');
  assert.match(harness.error() ?? '', /The plan action failed/);
});

// A read started for a Session the panel has left cannot land, whether the panel
// switched Sessions or closed.
test('a read started for a Session the panel has left cannot publish', async () => {
  const switched = await mountPanelFixture();
  const abandoned = switched.planChanged.expect();
  await switched.switchSession('session-2', beforeApproval);
  await abandoned.resolve(afterApproval);
  assert.match(switched.text(), /1\/3 steps/, 'the previous Session read must be discarded');

  const closed = await mountPanelFixture();
  const pending = closed.planChanged.expect();
  await closed.switchSession(undefined);
  assert.equal(closed.state(), undefined);
  await pending.resolve(afterApproval);
  assert.equal(closed.state(), undefined, 'a read for a closed panel must be discarded');
  assert.equal(closed.error(), undefined);
});

// An action that settles after a Session switch refreshes nothing, reports nothing
// and leaves no pending behind: its effects belong to the Session that started it.
test('an action that settles after a Session switch owns no panel state', async () => {
  const accepted = await mountPanelFixture();
  const approval = accepted.approve.expect();
  const { done } = await accepted.begin(() => accepted.controller().approve(accepted.proposal()));
  assert.equal(accepted.pending(), true);

  // The Session on screen carries its own, newer projection: publishing the read
  // the left Session's action would start over it is what the guard prevents.
  await accepted.switchSession('session-2', afterApproval);
  assert.equal(accepted.pending(), false, 'the left Session must not leave pending behind');
  assert.match(accepted.text(), /2\/3 steps/);
  await approval.resolve({ ok: true, value: { turnId: 'turn-1' } });
  await done;
  assert.match(accepted.text(), /2\/3 steps/, 'a stale action must not publish the old read');
  assert.equal(accepted.error(), undefined);

  // A refusal that arrives late is the left Session's news, not this one's.
  const refused = await mountPanelFixture();
  const failing = refused.approve.expect();
  const failingFlight = await refused.begin(() =>
    refused.controller().approve(refused.proposal()),
  );
  await refused.switchSession('session-2', beforeApproval);
  await failing.resolve({ ok: false, error: { code: 'plan_conflict', message: 'stale' } });
  await failingFlight.done;
  assert.equal(refused.error(), undefined, 'a stale refusal must not raise an error');
  assert.match(refused.text(), /1\/3 steps/);
  assert.equal(refused.pending(), false);
});

// The confirmation stays open across a Session switch; confirming it afterwards
// must not apply the abandon to the Session that replaced the one the user saw.
test('a confirmation that outlives a Session switch does not run the action', async () => {
  const harness = await mountPanelFixture();
  const abandoning = await harness.begin(() =>
    harness.controller().abandon('execution-1', 'Ship the plan request'),
  );

  await harness.switchSession('session-2', beforeApproval);
  await harness.confirmAbandon();
  await abandoning.done;

  assert.deepEqual(
    harness.abandons(),
    [],
    'the confirmed abandon must not be re-bound to the Session on screen',
  );
  assert.match(harness.text(), /1\/3 steps/);
  assert.equal(harness.pending(), false);
  assert.equal(harness.error(), undefined);
});

// Retrying the same approval after the execution advanced replays the input the
// first attempt was opened with — the Turn id and store version the Host keys its
// receipt by — or it reaches the Host as a second approval instead of a replay.
test('an approval retry after the plan advanced replays the persisted input', async () => {
  const harness = await mountPanelFixture();
  const first = harness.approve.expect();
  const firstFlight = await harness.begin(() => harness.controller().approve(harness.proposal()));
  const attempt = harness.approvals()[0];
  assert.ok(attempt);
  await first.resolve({ ok: false, error: { code: 'plan_conflict', message: 'stale' } });
  await firstFlight.done;

  await harness.planChanged
    .expect()
    .resolve(planState(['in_progress', 'completed', 'pending'], { storeVersion: 4 }));
  assert.equal(harness.state()?.storeVersion, 4);
  await harness.begin(() => harness.controller().approve(harness.proposal()));

  const retry = harness.approvals()[1];
  assert.ok(retry);
  assert.equal(retry.turnId, attempt.turnId, 'the retry must replay the original Turn');
  assert.equal(retry.expectedStoreVersion, attempt.expectedStoreVersion);
  assert.equal(retry.expectedRevision, attempt.expectedRevision);
});

// The response of a superseded attempt must not retire the record a newer request
// stored, or that request loses the Turn id its own receipt is keyed by.
test('a late response does not retire the retry of a newer request', async () => {
  const harness = await mountPanelFixture();
  const superseded = harness.approve.expect();
  const supersededFlight = await harness.begin(() =>
    harness.controller().approve(harness.proposal()),
  );
  const firstAttempt = harness.approvals()[0];
  assert.ok(firstAttempt);

  await harness.planChanged
    .expect()
    .resolve(planState(['pending', 'pending', 'pending'], { proposalId: 'proposal-2', revision: 2 }));
  const newer = harness.approve.expect();
  const newerFlight = await harness.begin(() => harness.controller().approve(harness.proposal()));
  const newerAttempt = harness.approvals()[1];
  assert.ok(newerAttempt);
  assert.notEqual(newerAttempt.turnId, firstAttempt.turnId);

  await superseded.resolve({ ok: true, value: { turnId: firstAttempt.turnId } });
  await supersededFlight.done;
  await harness.begin(() => harness.controller().approve(harness.proposal()));

  const retried = harness.approvals()[2];
  assert.ok(retried);
  assert.equal(retried.turnId, newerAttempt.turnId);
  assert.equal(retried.expectedRevision, 2);

  await newer.resolve({ ok: true, value: { turnId: newerAttempt.turnId } });
  await newerFlight.done;
});

/** A bridge promise the test settles inside `act`, so React flushes the update. */
interface Settleable<T> {
  resolve(value: T): Promise<void>;
  reject(cause: unknown): Promise<void>;
}

interface ApprovalCall {
  proposalId: string;
  expectedRevision: number;
  expectedStoreVersion: number;
  turnId: string;
}

type PlanControlIpcResult = { ok: true; value: unknown } | { ok: false; error: unknown };

async function mountPanelFixture() {
  const pendingReads = new Map<string, Deferred<PlanSessionState>[]>();
  const pendingApprovals: Deferred<PlanControlIpcResult>[] = [];
  const approvals: ApprovalCall[] = [];
  const abandons: Array<{ sessionId: string; executionId: string }> = [];
  const stagedStates = new Map<string, PlanSessionState>();
  let sessionId: string | undefined = 'session-1';
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
        approvePlan: async (_requestedSessionId: string, input: ApprovalCall) => {
          approvals.push(input);
          const queued = pendingApprovals.shift();
          if (queued) return await queued.promise;
          return { ok: true, value: { turnId: input.turnId } };
        },
        abandonPlanExecution: async (requestedSessionId: string, executionId: string) => {
          abandons.push({ sessionId: requestedSessionId, executionId });
          return { ok: true, value: undefined };
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
  // linkedom has no `HTMLDialogElement.showModal`, which the shared `AlertDialog`
  // behind `confirm` calls when it opens and closes.
  const elementPrototype = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  elementPrototype.showModal = function showModal(this: Element) {
    this.setAttribute('open', '');
  };
  elementPrototype.close = function close(this: Element) {
    this.removeAttribute('open');
  };

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  let controller: PlanModeState | undefined;
  function Harness() {
    const session = sessionId ? ({ id: sessionId } as SessionSummary) : undefined;
    const planMode = usePlanModeState(session);
    controller = planMode;
    return createElement(PlanExecutionPanel, { planMode });
  }
  const rendered = () =>
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, { children: createElement(Harness) }),
      }),
    }) as ReactNode;

  stagedStates.set('session-1', beforeApproval);
  await act(async () => {
    root.render(rendered());
  });
  assert.ok(controller);

  // A bridge promise settles outside React's own event handling, and the
  // confirmation moves between phases on an animation frame, so both are wrapped
  // in `act` with a turn of the event loop.
  const settleable = <T,>(pending: Deferred<T>, onResolve?: (value: T) => void): Settleable<T> => ({
    resolve: async (value) => {
      await act(async () => {
        onResolve?.(value);
        pending.resolve(value);
      });
    },
    reject: async (cause) => {
      await act(async () => pending.reject(cause));
    },
  });
  const nextFrame = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  return {
    text: () => container.textContent ?? '',
    state: () => controller?.state,
    error: () => controller?.error,
    pending: () => controller?.pending ?? false,
    controller: () => {
      assert.ok(controller);
      return controller;
    },
    proposal: () => {
      const proposal = controller?.state?.proposals[0];
      assert.ok(proposal, 'the fixture Session has no Plan proposal');
      return proposal;
    },
    planChanged: {
      expect: () => {
        const pending = deferred<PlanSessionState>();
        const readSessionId = sessionId;
        assert.ok(readSessionId && planChangedHandler, 'no Session is being read');
        const queued = pendingReads.get(readSessionId);
        if (queued) queued.push(pending);
        else pendingReads.set(readSessionId, [pending]);
        planChangedHandler();
        // The read this settles becomes the projection later reads see, so a
        // refresh triggered by an action reads forward, not back.
        return settleable(pending, (state) => stagedStates.set(readSessionId, state));
      },
    },
    approve: {
      expect: () => {
        const pending = deferred<PlanControlIpcResult>();
        pendingApprovals.push(pending);
        return settleable(pending);
      },
    },
    approvals: () => approvals,
    abandons: () => abandons,
    begin: async (action: () => Promise<void>) => {
      let started!: Promise<void>;
      await act(async () => {
        started = action();
      });
      return { done: started };
    },
    confirmAbandon: async () => {
      await nextFrame();
      const modal = container.querySelector('.maka-confirm-modal');
      assert.ok(modal, 'the abandon confirmation did not open');
      const action = [...modal.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Abandon plan'),
      );
      assert.ok(action, 'the abandon confirmation has no action button');
      await act(async () => {
        (action as HTMLElement).click();
      });
      await nextFrame();
    },
    switchSession: async (nextSessionId: string | undefined, state?: PlanSessionState) => {
      sessionId = nextSessionId;
      if (nextSessionId && state) stagedStates.set(nextSessionId, state);
      await act(async () => {
        root.render(rendered());
      });
    },
  };
}

function planState(
  statuses: PlanStepStatus[],
  overrides: { storeVersion?: number; proposalId?: string; revision?: number } = {},
): PlanSessionState {
  const sessionId = 'session-1';
  const proposalId = overrides.proposalId ?? 'proposal-1';
  const steps = statuses.map((status, index) => ({
    id: `step-${index + 1}`,
    title: `Step ${index + 1}`,
    description: `Do step ${index + 1}.`,
    status,
    updatedAt: 2,
  }));
  return {
    schemaVersion: 1,
    sessionId,
    storeVersion: overrides.storeVersion ?? 3,
    proposals: [
      {
        planId: 'plan-1',
        proposalId,
        sessionId,
        turnId: 'turn-1',
        revision: overrides.revision ?? 1,
        title: 'Ship the plan request',
        steps: steps.map(({ id, title, description }) => ({ id, title, description })),
        status: 'approved',
        submittedAt: 1,
      },
    ],
    executions: [
      {
        executionId: 'execution-1',
        planId: 'plan-1',
        proposalId,
        sessionId,
        status: 'active',
        steps,
        startedAt: 1,
        updatedAt: 2,
      },
    ],
    latestProposalId: proposalId,
    activeExecutionId: 'execution-1',
  };
}
