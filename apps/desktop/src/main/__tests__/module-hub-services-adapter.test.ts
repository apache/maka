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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { DesktopRuntimeHostProfileChangedEvent } from '../../preload/bridge-contract.js';
import type { ModuleHubRuntimeHostRef } from '../../renderer/features/module-hub/testing.js';
import {
  createDesktopModuleHubServices,
  type DesktopModuleHubBridge,
} from '../../renderer/platform/desktop/create-module-hub-services.js';

type Call = { name: string; args: unknown[] };

function methodRecorder(calls: Call[], prefix: string) {
  return new Proxy(
    {} as Record<PropertyKey, unknown>,
    {
      get: (target, property) =>
        Reflect.has(target, property)
          ? Reflect.get(target, property)
          : (...args: unknown[]) => {
              calls.push({ name: `${prefix}.${String(property)}`, args });
              return Promise.resolve(undefined);
            },
    },
  );
}

describe('createDesktopModuleHubServices', () => {
  it('maps host-scoped Skills, Scheduled Tasks, Daily Review, and clipboard operations', async () => {
    const calls: Call[] = [];
    const host: ModuleHubRuntimeHostRef = {
      profileId: 'remote-a',
      hostId: 'host-a',
    };
    const bridge = {
      runtimeHostProfiles: {
        getDefaultHost: async () => host,
        subscribeChanges: () => () => undefined,
      },
      skills: Object.assign(methodRecorder(calls, 'skills'), {
        sources: methodRecorder(calls, 'skills.sources'),
        catalog: methodRecorder(calls, 'skills.catalog'),
      }),
      scheduledTasks: methodRecorder(calls, 'scheduledTasks'),
      dailyReview: methodRecorder(calls, 'dailyReview'),
    } as unknown as DesktopModuleHubBridge;
    const clipboard = {
      async writeText(text: string) {
        calls.push({ name: 'clipboard.writeText', args: [text] });
      },
    };
    const services = createDesktopModuleHubServices(bridge, { clipboard });

    assert.deepEqual(await services.runtimeHosts.getDefault(), host);
    await services.skills.list(host);
    await services.skills.listManagedSources(host);
    await services.skills.listBundledCatalog(host);
    await services.skills.importManagedSource(host);
    await services.skills.installManaged('managed', host);
    await services.skills.installBundled('bundled', host);
    await services.skills.previewUpdate('skill', host);
    await services.skills.updateManaged('skill', { force: true }, host);
    await services.skills.setEnabled('skill', true, host);
    await services.skills.setPinned('user:skill', false, host);
    await services.skills.delete('user:skill', host);
    await services.skills.open('skill', 'directory', host);

    const createInput = { title: 'Task' } as Parameters<
      typeof services.scheduledTasks.create
    >[0];
    const updateInput = { title: 'Renamed' } as Parameters<
      typeof services.scheduledTasks.update
    >[1];
    await services.scheduledTasks.list(host);
    await services.scheduledTasks.create(createInput, host);
    await services.scheduledTasks.update('task', updateInput, host);
    await services.scheduledTasks.setEnabled('task', true, host);
    await services.scheduledTasks.triggerNow('task', host);
    await services.scheduledTasks.snooze('task', host);
    await services.scheduledTasks.clearRunHistory('task', host);
    await services.scheduledTasks.delete('task', host);

    await services.dailyReview.day(0, 7, host);
    await services.dailyReview.runOnce({ range: 7, offsetDays: -1 });
    await services.dailyReview.listArchives();
    await services.dailyReview.getArchive('archive');
    await services.dailyReview.saveMarkdownToFile({
      markdown: '# Review',
      defaultName: 'review.md',
    });
    await services.clipboard.writeText('review');

    assert.deepEqual(calls, [
      { name: 'skills.list', args: [host] },
      { name: 'skills.sources.list', args: [host] },
      { name: 'skills.catalog.list', args: [host] },
      { name: 'skills.sources.importLocalFile', args: [host] },
      { name: 'skills.installManaged', args: ['managed', host] },
      { name: 'skills.catalog.install', args: ['bundled', host] },
      { name: 'skills.previewUpdate', args: ['skill', host] },
      { name: 'skills.updateManaged', args: ['skill', { force: true }, host] },
      { name: 'skills.setEnabled', args: ['skill', true, host] },
      { name: 'skills.setPinned', args: ['user:skill', false, host] },
      { name: 'skills.delete', args: ['user:skill', host] },
      { name: 'skills.open', args: ['skill', 'directory', host] },
      { name: 'scheduledTasks.list', args: [host] },
      { name: 'scheduledTasks.create', args: [createInput, host] },
      { name: 'scheduledTasks.update', args: ['task', updateInput, host] },
      { name: 'scheduledTasks.setEnabled', args: ['task', true, host] },
      { name: 'scheduledTasks.triggerNow', args: ['task', host] },
      { name: 'scheduledTasks.snooze', args: ['task', host] },
      { name: 'scheduledTasks.clearRunHistory', args: ['task', host] },
      { name: 'scheduledTasks.delete', args: ['task', host] },
      { name: 'dailyReview.day', args: [0, 7, host] },
      { name: 'dailyReview.runOnce', args: [{ range: 7, offsetDays: -1 }] },
      { name: 'dailyReview.listArchives', args: [] },
      { name: 'dailyReview.getArchive', args: ['archive'] },
      {
        name: 'dailyReview.saveMarkdownToFile',
        args: [{ markdown: '# Review', defaultName: 'review.md' }],
      },
      { name: 'clipboard.writeText', args: ['review'] },
    ]);
  });

  it('forwards subscriptions, narrows Runtime Host events, and preserves disposers', () => {
    let hostHandler:
      | ((event: DesktopRuntimeHostProfileChangedEvent) => void)
      | undefined;
    let scheduledChangeHandler: ((event: never) => void) | undefined;
    let scheduledDueHandler: ((task: never) => void) | undefined;
    let disposed = 0;
    const subscribe = <T>(assign: (handler: (value: T) => void) => void) =>
      (handler: (value: T) => void) => {
        assign(handler);
        return () => {
          disposed += 1;
        };
      };
    const bridge = {
      runtimeHostProfiles: {
        getDefaultHost: async () => ({ profileId: 'local', hostId: 'local' }),
        subscribeChanges: subscribe<DesktopRuntimeHostProfileChangedEvent>(
          (handler) => {
            hostHandler = handler;
          },
        ),
      },
      skills: Object.assign(methodRecorder([], 'skills'), {
        sources: methodRecorder([], 'skills.sources'),
        catalog: methodRecorder([], 'skills.catalog'),
      }),
      scheduledTasks: Object.assign(methodRecorder([], 'scheduledTasks'), {
        subscribeChanges: subscribe((handler) => {
          scheduledChangeHandler = handler;
        }),
        subscribeDue: subscribe((handler) => {
          scheduledDueHandler = handler;
        }),
      }),
      dailyReview: methodRecorder([], 'dailyReview'),
    } as unknown as DesktopModuleHubBridge;
    const services = createDesktopModuleHubServices(bridge, {
      clipboard: { writeText: async () => undefined },
    });
    const hostEvents: unknown[] = [];
    const taskEvents: unknown[] = [];
    const dueEvents: unknown[] = [];
    const unsubscribers = [
      services.runtimeHosts.subscribeChanges((event) => hostEvents.push(event)),
      services.scheduledTasks.subscribeChanges((event) => taskEvents.push(event)),
      services.scheduledTasks.subscribeDue((event) => dueEvents.push(event)),
    ];
    const hostEvent: DesktopRuntimeHostProfileChangedEvent = {
      epoch: '2',
      profileId: 'remote-a',
      profileName: 'Remote',
      profileKind: 'remote',
      profileAccess: 'owner',
      readiness: 'ready',
      hostId: 'host-a',
      isDefault: true,
    };
    const changeEvent = {
      type: 'scheduled_tasks_changed' as const,
      reason: 'updated',
      taskId: 'task',
      ts: 2,
    };
    const dueEvent = { id: 'task', title: 'Task' };
    hostHandler?.(hostEvent);
    scheduledChangeHandler?.(changeEvent as never);
    scheduledDueHandler?.(dueEvent as never);
    for (const unsubscribe of unsubscribers) unsubscribe();

    assert.deepEqual(hostEvents, [
      {
        profileId: 'remote-a',
        readiness: 'ready',
        hostId: 'host-a',
        isDefault: true,
        removed: undefined,
      },
    ]);
    assert.deepEqual(taskEvents, [changeEvent]);
    assert.deepEqual(dueEvents, [dueEvent]);
    assert.equal(disposed, 3);
  });

  it('maps keep-awake settings and safely gates an older preload', async () => {
    let changed: (() => void) | undefined;
    let disposed = 0;
    const updates: unknown[] = [];
    const base = {
      runtimeHostProfiles: {
        getDefaultHost: async () => ({ profileId: 'local', hostId: 'local' }),
        subscribeChanges: () => () => undefined,
      },
      skills: Object.assign(methodRecorder([], 'skills'), {
        sources: methodRecorder([], 'skills.sources'),
        catalog: methodRecorder([], 'skills.catalog'),
      }),
      scheduledTasks: methodRecorder([], 'scheduledTasks'),
      dailyReview: methodRecorder([], 'dailyReview'),
    };
    const services = createDesktopModuleHubServices(
      {
        ...base,
        settings: {
          getClient: async () => ({
            system: { keepSystemAwake: true },
          }),
          updateClient: async (patch: unknown) => {
            updates.push(patch);
            return { settings: { system: { keepSystemAwake: false } } };
          },
          subscribeClientChanged(handler: () => void) {
            changed = handler;
            return () => {
              disposed += 1;
            };
          },
        },
      } as unknown as DesktopModuleHubBridge,
      { clipboard: { writeText: async () => undefined } },
    );
    assert.equal(services.clientSettings.supported, true);
    assert.equal(await services.clientSettings.getKeepSystemAwake(), true);
    assert.equal(await services.clientSettings.setKeepSystemAwake(false), false);
    let notifications = 0;
    const unsubscribe = services.clientSettings.subscribeChanges(() => {
      notifications += 1;
    });
    changed?.();
    unsubscribe();
    assert.deepEqual(updates, [{ system: { keepSystemAwake: false } }]);
    assert.equal(notifications, 1);
    assert.equal(disposed, 1);

    const oldPreload = createDesktopModuleHubServices(
      base as unknown as DesktopModuleHubBridge,
      { clipboard: { writeText: async () => undefined } },
    );
    assert.equal(oldPreload.clientSettings.supported, false);
    oldPreload.clientSettings.subscribeChanges(() => undefined)();
    await assert.rejects(
      oldPreload.clientSettings.getKeepSystemAwake(),
      /Client settings are unavailable/,
    );
    await assert.rejects(
      oldPreload.clientSettings.setKeepSystemAwake(true),
      /Client settings are unavailable/,
    );
  });
});
