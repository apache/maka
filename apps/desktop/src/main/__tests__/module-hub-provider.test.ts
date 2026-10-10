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
import { act, createElement, Fragment, StrictMode } from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import { LocaleProvider, ToastProvider } from '@maka/ui';
import {
  createModuleHubCommandPort,
  ModuleHubProvider,
  ModuleHubScheduledTasksBoundary,
  ModuleHubSkillCatalogRevisionBoundary,
  ModuleHubServicesProvider,
  createFakeModuleHubServices,
  type ModuleHubCommands,
  type ModuleHubServices,
  useModuleHubController,
} from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

function task(id: string): ScheduledTask {
  return {
    id,
    title: id,
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

afterEach(() => cleanupFakeDom());

function scheduledTasksHarness(): {
  services: ModuleHubServices;
  emit(tasks: ScheduledTask[]): void;
} {
  const defaults = createFakeModuleHubServices();
  let handler: (() => void) | undefined;
  let scheduledTasks: ScheduledTask[] = [];
  return {
    services: createFakeModuleHubServices({
      scheduledTasks: {
        ...defaults.scheduledTasks,
        list: async () => scheduledTasks,
        subscribeChanges(next) {
          handler = () =>
            next({
              type: 'scheduled_tasks_changed',
              reason: 'test',
              ts: 1,
            });
          return () => {
            handler = undefined;
          };
        },
      },
    }),
    emit(tasks) {
      scheduledTasks = tasks;
      assert.ok(handler);
      handler();
    },
  };
}

test('controller scoping removes shell-wide work from Module Hub updates', async () => {
  const { root } = installReactRenderer();
  const legacy = scheduledTasksHarness();
  const scoped = scheduledTasksHarness();
  const commandPort = createModuleHubCommandPort();
  const renders = {
    legacyShell: 0,
    legacyUnrelated: 0,
    legacyReader: 0,
    scopedShell: 0,
    scopedUnrelated: 0,
    scopedReader: 0,
    scopedSkillReader: 0,
  };
  let legacyObservedTasks: readonly ScheduledTask[] = [];
  let scopedObservedTasks: readonly ScheduledTask[] = [];
  let scopedObservedSkillRevision = -1;
  const controllerInput = {
    selection: { section: 'sessions' } as const,
    selectModule: () => undefined,
    clientPathsAccessible: false,
    useSkillInChat: () => undefined,
    openSession: () => undefined,
    appendComposerText: () => undefined,
    captureActiveComposerClaim: () => undefined,
  };

  function LegacyUnrelatedProbe() {
    renders.legacyUnrelated += 1;
    return null;
  }

  function ScopedUnrelatedProbe() {
    renders.scopedUnrelated += 1;
    return null;
  }

  function LegacyScheduledTasksProbe(props: {
    scheduledTasks: readonly ScheduledTask[];
  }) {
    renders.legacyReader += 1;
    legacyObservedTasks = props.scheduledTasks;
    return null;
  }

  function ScopedScheduledTasksProbe(props: {
    scheduledTasks: readonly ScheduledTask[];
  }) {
    renders.scopedReader += 1;
    scopedObservedTasks = props.scheduledTasks;
    return null;
  }

  function ScopedSkillCatalogProbe(props: { skillCatalogRevision: number }) {
    renders.scopedSkillReader += 1;
    scopedObservedSkillRevision = props.skillCatalogRevision;
    return null;
  }

  function LegacyShellReplica() {
    renders.legacyShell += 1;
    const controller = useModuleHubController(controllerInput);
    return createElement(
      Fragment,
      null,
      createElement(LegacyUnrelatedProbe),
      createElement(LegacyScheduledTasksProbe, {
        scheduledTasks: controller.selectors.scheduledTasks,
      }),
    );
  }

  function ScopedShellReplica() {
    renders.scopedShell += 1;
    return createElement(
      ModuleHubProvider,
      {
        ...controllerInput,
        commandPort,
      },
      createElement(
        Fragment,
        null,
        createElement(ScopedUnrelatedProbe),
        createElement(ModuleHubScheduledTasksBoundary, {
          render: (scheduledTasks) =>
            createElement(ScopedScheduledTasksProbe, { scheduledTasks }),
        }),
        createElement(ModuleHubSkillCatalogRevisionBoundary, {
          render: (skillCatalogRevision) =>
            createElement(ScopedSkillCatalogProbe, { skillCatalogRevision }),
        }),
      ),
    );
  }

  await act(async () => {
    const app = createElement(
      Fragment,
      null,
      createElement(
        ModuleHubServicesProvider,
        { services: legacy.services },
        createElement(LegacyShellReplica),
      ),
      createElement(
        ModuleHubServicesProvider,
        { services: scoped.services },
        createElement(ScopedShellReplica),
      ),
    );
    root.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ToastProvider, { children: app }),
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  const baseline = { ...renders };

  await act(async () => {
    legacy.emit([task('legacy-task')]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(renders, {
    legacyShell: baseline.legacyShell + 1,
    legacyUnrelated: baseline.legacyUnrelated + 1,
    legacyReader: baseline.legacyReader + 1,
    scopedShell: baseline.scopedShell,
    scopedUnrelated: baseline.scopedUnrelated,
    scopedReader: baseline.scopedReader,
    scopedSkillReader: baseline.scopedSkillReader,
  });
  assert.deepEqual(
    legacyObservedTasks.map(({ id }) => id),
    ['legacy-task'],
  );

  const afterLegacy = { ...renders };
  await act(async () => {
    scoped.emit([task('scoped-task')]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(renders, {
    legacyShell: afterLegacy.legacyShell,
    legacyUnrelated: afterLegacy.legacyUnrelated,
    legacyReader: afterLegacy.legacyReader,
    scopedShell: afterLegacy.scopedShell,
    scopedUnrelated: afterLegacy.scopedUnrelated,
    scopedReader: afterLegacy.scopedReader + 1,
    scopedSkillReader: afterLegacy.scopedSkillReader,
  });
  assert.deepEqual(
    scopedObservedTasks.map(({ id }) => id),
    ['scoped-task'],
  );

  const afterScheduledTasks = { ...renders };
  const previousSkillRevision = scopedObservedSkillRevision;
  await act(async () => {
    await commandPort.refreshProjectSkills();
  });
  assert.deepEqual(renders, {
    legacyShell: afterScheduledTasks.legacyShell,
    legacyUnrelated: afterScheduledTasks.legacyUnrelated,
    legacyReader: afterScheduledTasks.legacyReader,
    scopedShell: afterScheduledTasks.scopedShell,
    scopedUnrelated: afterScheduledTasks.scopedUnrelated,
    scopedReader: afterScheduledTasks.scopedReader,
    scopedSkillReader: afterScheduledTasks.scopedSkillReader + 1,
  });
  assert.equal(scopedObservedSkillRevision, previousSkillRevision + 1);
});

test('command port keeps the newest controller through stale cleanup', async () => {
  const calls: string[] = [];
  const commands = (name: string): ModuleHubCommands => ({
    refreshProjectSkills: async () => {
      calls.push(`${name}:refresh`);
    },
    openScheduledTaskCreate: () => calls.push(`${name}:create`),
    copyTodayDailyReview: async () => {
      calls.push(`${name}:copy`);
    },
    pasteTodayDailyReview: async () => {
      calls.push(`${name}:paste`);
    },
    saveTodayDailyReview: async () => {
      calls.push(`${name}:save`);
    },
  });
  const port = createModuleHubCommandPort();
  const disconnectFirst = port.connect(commands('first'));
  const disconnectSecond = port.connect(commands('second'));

  disconnectFirst();
  await port.refreshProjectSkills();
  port.openScheduledTaskCreate();
  assert.deepEqual(calls, ['second:refresh', 'second:create']);

  disconnectSecond();
  await port.copyTodayDailyReview();
  assert.deepEqual(calls, ['second:refresh', 'second:create']);
});

for (const capabilityTiming of ['at mount', 'before', 'after'] as const) {
  test(`Skills locations load when local path capability arrives ${capabilityTiming} deferred startup`, async () => {
    const { root } = installReactRenderer();
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    globalThis.requestAnimationFrame = (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
    let current: ReturnType<typeof useModuleHubController> | undefined;
    let locationReads = 0;
    let skillReads = 0;
    function skills() {
      assert.ok(current);
      return current.host.skills;
    }
    const defaults = createFakeModuleHubServices();
    const services = createFakeModuleHubServices({
      skills: {
        ...defaults.skills,
        list: async () => { skillReads += 1; return []; },
        listLocations: async () => {
          locationReads += 1;
          return {
            contextIds: { workspace: `workspace-${locationReads}` },
            locations: [{
              ref: 'workspace:legacy', scope: 'workspace', source: 'legacy',
              path: `/workspace-${locationReads}/skills`, status: 'available', skillCount: 0,
            }],
          };
        },
      },
    });
    function Probe({ clientPathsAccessible }: { clientPathsAccessible: boolean }) {
      current = useModuleHubController({
        selection: { section: 'extensions', module: 'skills' },
        selectModule: () => undefined,
        clientPathsAccessible,
        useSkillInChat: () => undefined,
        openSession: () => undefined,
        appendComposerText: () => undefined,
        captureActiveComposerClaim: () => undefined,
      });
      return null;
    }
    async function render(clientPathsAccessible: boolean): Promise<void> {
      await act(async () => root.render(createElement(StrictMode, null, createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ToastProvider, {
          children: createElement(ModuleHubServicesProvider, { services },
            createElement(Probe, { clientPathsAccessible })),
        }),
      }))));
    }

    await render(capabilityTiming === 'at mount');
    assert.equal(skillReads, 0);
    assert.equal(locationReads, 0);
    if (capabilityTiming === 'before') {
      await render(true);
      assert.equal(skillReads, 0);
      assert.equal(locationReads, 0);
    }
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame(0);
    });
    assert.equal(skillReads, 1);
    if (capabilityTiming === 'after') {
      assert.equal(locationReads, 0);
      assert.deepEqual(skills().skillLocations, []);
      await render(true);
    }
    assert.equal(locationReads, 1);
    assert.equal(skills().skillLocations[0]?.path, '/workspace-1/skills');
    assert.equal(typeof skills().onOpenSkillLocation, 'function');
    await render(false);
    assert.equal(locationReads, 1);
    assert.deepEqual(skills().skillLocations, []);
    assert.equal(skills().onOpenSkillLocation, undefined);
    await render(true);
    assert.equal(locationReads, 2);
    assert.equal(skills().skillLocations[0]?.path, '/workspace-2/skills');
    assert.equal(skillReads, 1);
  });
}
