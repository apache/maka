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
import type { ScheduledTask } from '@maka/core/scheduled-task';
import type { NavSelection, ToastInput } from '@maka/ui';
import {
  createFakeModuleHubServices,
  ModuleHubServicesProvider,
  useScheduledTasksController,
  type ModuleHubServices,
  type ScheduledTasksController,
  type ScheduledTasksToastApi,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
function task(id: string, title = id): ScheduledTask {
  return {
    id,
    title,
    intent: { kind: 'text', body: 'run' },
    schedule: { kind: 'once', runAt: 1 },
    effect: { kind: 'notify', channel: 'local' },
    status: 'active',
    nextFireAt: 1,
    lastFireAt: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'user' },
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    lastError: null,
  };
}

type ToastRecord =
  | {
      kind: 'success' | 'error';
      title: string;
      detail?: string;
      profileId?: string;
    }
  | { kind: 'toast'; input: ToastInput };

function toastRecorder(
  records: ToastRecord[],
  confirm: () => Promise<boolean> = async () => true,
): ScheduledTasksToastApi {
  return {
    success(title, detail) {
      records.push({ kind: 'success', title, detail });
      return 'success';
    },
    error(title, detail, _diagnosticDetails, diagnosticTarget) {
      records.push({
        kind: 'error',
        title,
        detail,
        ...(diagnosticTarget && 'profileId' in diagnosticTarget
          ? { profileId: diagnosticTarget.profileId }
          : {}),
      });
      return 'error';
    },
    toast(input) {
      records.push({ kind: 'toast', input });
      return 'toast';
    },
    confirm,
  };
}

let latest: ScheduledTasksController | undefined;

function Probe(props: {
  selection: NavSelection;
  selectModule: (selection: NavSelection) => void;
  toastApi: ScheduledTasksToastApi;
}) {
  latest = useScheduledTasksController({
    uiLocale: 'en',
    toastApi: props.toastApi,
    selection: props.selection,
    selectModule: props.selectModule,
  });
  return null;
}

function renderController(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: ModuleHubServices,
  props: Parameters<typeof Probe>[0],
) {
  root.render(
    createElement(
      ModuleHubServicesProvider,
      { services },
      createElement(Probe, props),
    ),
  );
}

function controller(): ScheduledTasksController {
  assert.ok(latest);
  return latest;
}

const activeSelection: NavSelection = {
  section: 'automations',
  module: 'scheduled-tasks',
};

test('Scheduled Tasks read uses generation and current-default-Host fences', async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const hostA = { profileId: 'profile-a', hostId: 'host-a' };
  const hostB = { profileId: 'profile-b', hostId: 'host-b' };
  let currentHost = hostA;
  const first = deferred<ScheduledTask[]>();
  const oldHost = deferred<ScheduledTask[]>();
  let reads = 0;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => currentHost,
    },
    scheduledTasks: {
      ...defaults.scheduledTasks,
      list: async () => {
        reads += 1;
        if (reads === 1) return first.promise;
        if (reads === 3) return oldHost.promise;
        return [task(`current-${currentHost.hostId}`)];
      },
    },
  });
  await act(async () =>
    renderController(root, services, {
      selection: activeSelection,
      selectModule: () => undefined,
      toastApi: toastRecorder(records),
    }),
  );

  const stale = controller().refresh();
  await act(async () => controller().refresh());
  assert.deepEqual(
    controller().scheduledTasks.map(({ id }) => id),
    ['current-host-a'],
  );
  await act(async () => {
    first.resolve([task('same-host-stale')]);
    await stale;
  });
  assert.deepEqual(
    controller().scheduledTasks.map(({ id }) => id),
    ['current-host-a'],
  );

  const pendingOldHost = controller().refresh();
  currentHost = hostB;
  await act(async () => {
    oldHost.resolve([task('old-host')]);
    await pendingOldHost;
  });
  assert.deepEqual(
    controller().scheduledTasks.map(({ id }) => id),
    ['current-host-a'],
  );
  assert.deepEqual(records, []);
});

test('stale Scheduled Task refresh errors do not outlive a newer generation', async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const host = { profileId: 'profile-a', hostId: 'host-a' };
  const staleHostRecheck = deferred<typeof host>();
  let hostReads = 0;
  let reads = 0;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => {
        hostReads += 1;
        return hostReads === 2 ? staleHostRecheck.promise : host;
      },
    },
    scheduledTasks: {
      ...defaults.scheduledTasks,
      list: async () => {
        reads += 1;
        if (reads === 1) throw new Error('stale refresh failed');
        return [task('fresh')];
      },
    },
  });
  await act(async () =>
    renderController(root, services, {
      selection: activeSelection,
      selectModule: () => undefined,
      toastApi: toastRecorder(records),
    }),
  );

  const staleRefresh = controller().refresh();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(hostReads, 2);

  await act(async () => controller().refresh());
  assert.deepEqual(
    controller().scheduledTasks.map(({ id }) => id),
    ['fresh'],
  );

  staleHostRecheck.resolve(host);
  await act(async () => staleRefresh);
  assert.deepEqual(records, []);
});

test('Scheduled Task mutations recheck their Host after the refresh', async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const hostA = { profileId: 'profile-a', hostId: 'host-a' };
  const hostB = { profileId: 'profile-b', hostId: 'host-b' };
  let currentHost = hostA;
  let reads = 0;
  const pendingRefresh = deferred<ScheduledTask[]>();
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    runtimeHosts: {
      ...defaults.runtimeHosts,
      getDefault: async () => currentHost,
    },
    scheduledTasks: {
      ...defaults.scheduledTasks,
      create: async () => task('created-on-host-a'),
      list: async () => {
        reads += 1;
        return pendingRefresh.promise;
      },
    },
  });
  await act(async () =>
    renderController(root, services, {
      selection: activeSelection,
      selectModule: () => undefined,
      toastApi: toastRecorder(records),
    }),
  );

  const mutation = controller().create({
    title: 'Created on Host A',
    intentBody: 'run',
    schedule: { kind: 'once', runAt: 1 },
    effect: { kind: 'notify', channel: 'local' },
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(reads, 1);

  currentHost = hostB;
  pendingRefresh.resolve([task('old-host-task')]);
  let result = true;
  await act(async () => {
    result = await mutation;
  });

  assert.equal(result, false);
  assert.deepEqual(controller().scheduledTasks, []);
  assert.deepEqual(records, []);
});

test('mutations keep titles current, preserve refreshes, and fence confirm continuation', async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const calls: string[] = [];
  const confirmResult = deferred<boolean>();
  const defaults = createFakeModuleHubServices();
  let listed = [task('task-a', 'Latest title')];
  const services = createFakeModuleHubServices({
    scheduledTasks: {
      ...defaults.scheduledTasks,
      list: async () => {
        calls.push('list');
        return listed;
      },
      triggerNow: async (id) => {
        calls.push(`trigger:${id}`);
        return listed[0]!;
      },
      delete: async (id) => {
        calls.push(`delete:${id}`);
      },
      create: async () => {
        throw new Error('SCHEDULED_TASK_INCOGNITO_ACTIVE');
      },
    },
  });
  const activeProps = {
    selection: activeSelection,
    selectModule: () => undefined,
    toastApi: toastRecorder(records, () => confirmResult.promise),
  };
  await act(async () => renderController(root, services, activeProps));
  await act(async () => controller().refresh());
  await act(async () => controller().triggerNow('task-a'));
  assert.deepEqual(calls, ['list', 'trigger:task-a', 'list']);
  assert.ok(
    records.some(
      (record) => record.kind === 'success' && record.detail === 'Latest title',
    ),
  );

  await act(async () =>
    controller().create({
      title: 'Blocked',
      intentBody: 'run',
      schedule: { kind: 'once', runAt: 1 },
      effect: { kind: 'notify', channel: 'local' },
    }),
  );
  assert.ok(
    records.some(
      (record) =>
        record.kind === 'error' &&
        record.detail?.toLowerCase().includes('incognito'),
    ),
  );

  const deletion = controller().delete('task-a');
  await act(async () =>
    renderController(root, services, {
      ...activeProps,
      selection: { section: 'extensions', module: 'skills' },
    }),
  );
  confirmResult.resolve(true);
  await act(async () => deletion);
  assert.equal(calls.includes('delete:task-a'), false);

  const errorsBefore = records.filter(({ kind }) => kind === 'error').length;
  services.scheduledTasks.list = async () => {
    throw new Error('late refresh');
  };
  await act(async () => controller().refreshSurface());
  assert.equal(
    records.filter(({ kind }) => kind === 'error').length,
    errorsBefore,
  );
});

test('a destructive confirmation cannot continue after controller unmount', async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const confirmResult = deferred<boolean>();
  const deleted: string[] = [];
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    scheduledTasks: {
      ...defaults.scheduledTasks,
      delete: async (id) => {
        deleted.push(id);
      },
    },
  });
  await act(async () =>
    renderController(root, services, {
      selection: activeSelection,
      selectModule: () => undefined,
      toastApi: toastRecorder(records, () => confirmResult.promise),
    }),
  );

  const deletion = controller().delete('task-a');
  await act(async () => root.unmount());
  confirmResult.resolve(true);
  await act(async () => deletion);

  assert.deepEqual(deleted, []);
  assert.deepEqual(records, []);
});

test('subscriptions refresh, due navigation action is live, disposers run, and nonce resets', async () => {
  const { root } = installReactRenderer();
  const records: ToastRecord[] = [];
  const selections: NavSelection[] = [];
  let changeHandler:
    | Parameters<ModuleHubServices['scheduledTasks']['subscribeChanges']>[0]
    | undefined;
  let dueHandler:
    ((task: Pick<ScheduledTask, 'id' | 'title'>) => void) | undefined;
  let disposals = 0;
  let reads = 0;
  const defaults = createFakeModuleHubServices();
  const services = createFakeModuleHubServices({
    scheduledTasks: {
      ...defaults.scheduledTasks,
      list: async () => {
        reads += 1;
        return [];
      },
      subscribeChanges(handler) {
        changeHandler = handler;
        return () => {
          disposals += 1;
        };
      },
      subscribeDue(handler) {
        dueHandler = handler;
        return () => {
          disposals += 1;
        };
      },
    },
  });
  await act(async () =>
    renderController(root, services, {
      selection: activeSelection,
      selectModule: (selection) => selections.push(selection),
      toastApi: toastRecorder(records),
    }),
  );

  await act(async () => {
    changeHandler?.({
      type: 'scheduled_tasks_changed',
      reason: 'updated',
      ts: 1,
    });
    dueHandler?.({ id: 'due', title: 'Due task' });
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(reads, 2);
  const dueToast = records.find(
    (record): record is Extract<ToastRecord, { kind: 'toast' }> =>
      record.kind === 'toast',
  );
  assert.equal(dueToast?.input.description, 'Due task');
  dueToast?.input.action?.onClick();
  assert.deepEqual(selections.at(-1), activeSelection);

  act(() => controller().openCreate());
  assert.equal(controller().createRequestNonce, 1);
  assert.deepEqual(selections.at(-1), activeSelection);
  act(() => controller().handleCreateRequest());
  assert.equal(controller().createRequestNonce, 0);

  act(() => root.unmount());
  assert.equal(disposals, 2);
});

afterEach(() => {
  latest = undefined;
  cleanupFakeDom();
});
