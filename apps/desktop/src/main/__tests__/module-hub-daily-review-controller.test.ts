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
  scheduledTaskSessionLabel,
  type ScheduledTask,
} from '@maka/core/scheduled-task';
import type { SessionSummary } from '@maka/core/session';
import {
  createFakeModuleHubServices,
  type DailyReviewController,
  useDailyReviewController,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const task = {
  id: 'user-created-review',
  presetId: 'daily-review',
  title: 'Daily Review',
  intent: { kind: 'text', body: 'Review ordinary Session history.' },
  schedule: { kind: 'calendar', recurrence: 'daily', anchorAt: Date.now() + 60_000 },
  effect: { kind: 'notify', channel: 'local' },
  status: 'active',
  nextFireAt: Date.now() + 60_000,
  lastFireAt: null,
  fireCount: 0,
  maxFires: null,
  expiresAt: null,
  createdBy: { kind: 'user' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  runs: [],
  lastError: null,
} satisfies ScheduledTask;

function session(input: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'name'>): SessionSummary {
  return {
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'fixture',
    connectionLocked: true,
    model: 'fixture-model',
    permissionMode: 'ask',
    ...input,
  };
}

test('projects the Daily Review preset from ordinary Session and usage services', async () => {
  const { root } = installReactRenderer();
  const hosts: string[] = [];
  const sessions = [
    session({
      id: 'report',
      name: 'Daily Review report',
      labels: [scheduledTaskSessionLabel(task.id)],
      lastMessageAt: Date.now() - 1_000,
      lastMessagePreview: 'Review body',
    }),
    session({
      id: 'ordinary',
      name: 'Ordinary task',
      lastMessageAt: Date.now() - 2_000,
    }),
  ];
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      getDefault: async () => ({ profileId: 'profile-a', hostId: 'host-a' }),
      subscribeChanges: () => () => undefined,
    },
    dailyReview: {
      listSessions: async (host) => {
        hosts.push(`sessions:${host.hostId}`);
        return sessions;
      },
      readUsage: async (_range, host) => {
        hosts.push(`usage:${host.hostId}`);
        return { totalRequests: 7, totalTokens: 1_234, totalCostUsd: 0.25 };
      },
      subscribeChanges: () => () => undefined,
    },
  });
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({ services, tasks: [task] });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller?.task, task);
  const view = await controller!.bridge.load(1);
  assert.deepEqual(hosts, ['sessions:host-a', 'usage:host-a']);
  assert.deepEqual(view.totals, {
    sessionCount: 2,
    totalRequests: 7,
    totalTokens: 1_234,
    totalCostUsd: 0.25,
  });
  assert.deepEqual(view.reports.map((report) => report.sessionId), ['report']);
});

test('invalidates the projection for ordinary Session and Runtime Host changes', async () => {
  const { root } = installReactRenderer();
  let sessionChanged: (() => void) | undefined;
  let hostChanged: (() => void) | undefined;
  let disposed = 0;
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      getDefault: async () => ({ profileId: 'profile-a', hostId: 'host-a' }),
      subscribeChanges: (handler) => {
        hostChanged = () => handler({
          profileId: 'profile-a',
          hostId: 'host-a',
          readiness: 'ready',
          isDefault: true,
        });
        return () => { disposed += 1; };
      },
    },
    dailyReview: {
      listSessions: async () => [],
      readUsage: async () => ({ totalRequests: 0, totalTokens: 0, totalCostUsd: 0 }),
      subscribeChanges: (handler) => {
        sessionChanged = handler;
        return () => { disposed += 1; };
      },
    },
  });
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({ services, tasks: [task] });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller?.revision, 0);
  await act(async () => sessionChanged?.());
  assert.equal(controller?.revision, 1);
  await act(async () => hostChanged?.());
  assert.equal(controller?.revision, 2);
  await act(async () => root.unmount());
  assert.equal(disposed, 2);
});

test('prefers the migrated system task over another Daily Review preset task', async () => {
  const { root } = installReactRenderer();
  const systemTask = {
    ...task,
    id: 'system-daily-review',
    createdBy: { kind: 'system' as const },
  };
  const services = createFakeModuleHubServices();
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({ services, tasks: [task, systemTask] });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  assert.equal(controller?.task, systemTask);
});

test('rejects a projection if the default Runtime Host changes mid-read', async () => {
  const { root } = installReactRenderer();
  const hostA = { profileId: 'profile-a', hostId: 'host-a' };
  const hostB = { profileId: 'profile-b', hostId: 'host-b' };
  let currentHost = hostA;
  const pendingSessions = deferred<SessionSummary[]>();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      getDefault: async () => currentHost,
      subscribeChanges: () => () => undefined,
    },
    dailyReview: {
      listSessions: async () => pendingSessions.promise,
      readUsage: async () => ({ totalRequests: 0, totalTokens: 0, totalCostUsd: 0 }),
      subscribeChanges: () => () => undefined,
    },
  });
  let controller: DailyReviewController | undefined;

  function Probe() {
    controller = useDailyReviewController({ services, tasks: [task] });
    return null;
  }

  await act(async () => root.render(createElement(Probe)));
  const load = controller!.bridge.load(1);
  currentHost = hostB;
  pendingSessions.resolve([]);
  await assert.rejects(load, /default Runtime Host changed/);
});

afterEach(() => cleanupFakeDom());
