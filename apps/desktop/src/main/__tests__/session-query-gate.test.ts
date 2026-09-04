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
import { deferred } from '@maka/core/test-only/async-primitives';
import type { PlanSessionState } from '@maka/core/plan';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider, ToastProvider } from '@maka/ui';
import { act, createElement } from 'react';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
import {
  ComposerMentionsProvider,
  useComposerMentionsContext,
} from '../../renderer/composer-mentions.js';
import {
  usePlanModeState,
  type PlanModeState,
} from '../../renderer/plan-mode-panel.js';
import { createSessionCatalogController } from '../../renderer/session-catalog-state.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('query blocking pauses, resumes, and fences automatic Skills and Plan reads', async () => {
  const { root } = installReactRenderer();
  const session = { id: 'session', isArchived: false } as SessionSummary;
  const catalog = createSessionCatalogController();
  catalog.commitSessions([{ ...session, isArchived: true } as DesktopSessionSummary]);
  const firstSkillQuery = deferred<never[]>();
  const firstPlanQuery = deferred<PlanSessionState>();
  const stalePlanState = {
    schemaVersion: 1,
    sessionId: session.id,
    storeVersion: 1,
    proposals: [],
    executions: [],
  } satisfies PlanSessionState;
  const freshPlanState = { ...stalePlanState, storeVersion: 2 } satisfies PlanSessionState;
  let skillQueries = 0;
  let planQueries = 0;
  let revisionRequests = 0;
  let planState: PlanSessionState | undefined;
  let planMode: PlanModeState | undefined;
  let skillsUnavailable = false;

  (globalThis.window as unknown as { maka: unknown }).maka = {
    skills: {
      listInvocable: async () => {
        skillQueries += 1;
        return skillQueries === 1 ? firstSkillQuery.promise : [];
      },
    },
    sessions: {
      getPlanState: async () => {
        planQueries += 1;
        return planQueries === 1 ? firstPlanQuery.promise : freshPlanState;
      },
      requestPlanRevision: async () => {
        revisionRequests += 1;
      },
      subscribeChanges: () => () => undefined,
      subscribeEvents: () => () => undefined,
      subscribePlanChanges: () => () => undefined,
    },
    mcp: { subscribeChanges: () => () => undefined },
  };

  function QueryProbe() {
    const plan = usePlanModeState(session, catalog);
    planMode = plan;
    planState = plan.state;
    skillsUnavailable = useComposerMentionsContext()?.mentionSkillsUnavailable ?? false;
    return null;
  }

  await act(async () => {
    root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(ToastProvider, {
        children: createElement(ComposerMentionsProvider, {
          skillCatalogRevision: 0,
          sessionId: session.id,
          automaticQueryGate: catalog,
          children: createElement(QueryProbe),
        }),
      }),
    }));
    await Promise.resolve();
  });

  assert.deepEqual([skillQueries, planQueries], [0, 0]);

  await act(async () => {
    catalog.commitSessions([session as DesktopSessionSummary]);
    await Promise.resolve();
  });

  let lease!: ReturnType<typeof catalog.acquireAutomaticQueryBlock>;
  let overlappingLease!: ReturnType<typeof catalog.acquireAutomaticQueryBlock>;
  await act(async () => {
    lease = catalog.acquireAutomaticQueryBlock([session.id]);
    overlappingLease = catalog.acquireAutomaticQueryBlock([session.id]);
    firstSkillQuery.reject(new Error('session archived'));
    firstPlanQuery.resolve(stalePlanState);
    await Promise.resolve();
  });

  assert.equal(planState, undefined);
  assert.equal(skillsUnavailable, false);

  await act(async () => {
    lease.release();
    await Promise.resolve();
  });
  assert.deepEqual([skillQueries, planQueries], [1, 1]);

  await act(async () => {
    overlappingLease.release();
    await Promise.resolve();
  });
  assert.deepEqual([skillQueries, planQueries], [2, 2]);
  assert.deepEqual(planState, freshPlanState);

  let mutationLease!: ReturnType<typeof catalog.acquireAutomaticQueryBlock>;
  await act(async () => {
    mutationLease = catalog.acquireAutomaticQueryBlock([session.id]);
    await planMode?.requestRevision('proposal');
  });
  assert.equal(revisionRequests, 1);
  assert.equal(planQueries, 3);

  await act(async () => {
    mutationLease.release();
    await Promise.resolve();
  });
  assert.deepEqual([skillQueries, planQueries], [3, 4]);
});

test('query block membership is part of the catalog snapshot', () => {
  const catalog = createSessionCatalogController();
  let notifications = 0;
  const unsubscribe = catalog.subscribe(() => {
    notifications += 1;
  });

  const first = catalog.acquireAutomaticQueryBlock(['session']);
  assert.equal(catalog.getState().automaticQueryBlockedSessionIds.has('session'), true);
  assert.equal(notifications, 1);

  const nested = catalog.acquireAutomaticQueryBlock(['session']);
  first.release();
  assert.equal(catalog.getState().automaticQueryBlockedSessionIds.has('session'), true);
  assert.equal(notifications, 1);

  nested.release();
  assert.equal(catalog.getState().automaticQueryBlockedSessionIds.has('session'), false);
  assert.equal(notifications, 2);
  unsubscribe();
});
