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
import type { ComputerHistoryApplication } from '@maka/core/computer-history';
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
  it('forwards application metadata batches locally without changing native names or missing icons', async () => {
    const bundleIds = Object.freeze(['com.example.editor', 'com.example.uninstalled']);
    const applications: readonly ComputerHistoryApplication[] = Object.freeze([
      { bundleIdentifier: bundleIds[0]!, name: 'Local Editor', iconDataUrl: 'data:image/png;base64,cG5n' },
      { bundleIdentifier: bundleIds[1]!, name: 'Removed App', iconDataUrl: null },
    ]);
    const calls: (readonly string[])[] = [];
    const services = createDesktopModuleHubServices({
      computerHistory: {
        applications: async (ids: readonly string[]) => {
          calls.push(ids);
          return applications;
        },
      },
      runtimeHostProfiles: {
        getDefaultHost: async () => { assert.fail('Application metadata must not use the default Host'); },
        getSnapshot: async () => { assert.fail('Application metadata must not resolve a remote Host'); },
      },
    } as unknown as DesktopModuleHubBridge);

    assert.equal(await services.computerHistory.applications(bundleIds), applications);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], bundleIds);
  });

  it('propagates application metadata errors instead of returning fallback brands', async () => {
    const failure = new Error('Local application metadata unavailable');
    const services = createDesktopModuleHubServices({
      computerHistory: {
        applications: async () => { throw failure; },
      },
    } as unknown as DesktopModuleHubBridge);
    await assert.rejects(services.computerHistory.applications(['com.example.editor']), (error) => error === failure);
  });

  it('keeps history operations local and status/clear usable after a failed timeline', async () => {
    const calls: Call[] = [];
    const history = Object.assign(methodRecorder(calls, 'history'), {
      timeline: async () => { throw new Error('Malformed history'); },
    });
    const bridge = {
      computerHistory: history,
      runtimeHostProfiles: {
        getDefaultHost: async () => { throw new Error('Must not route history through default Host'); },
      },
    } as unknown as DesktopModuleHubBridge;
    const services = createDesktopModuleHubServices(bridge);
    await assert.rejects(services.computerHistory.timeline(30), /Malformed history/);
    await services.computerHistory.status();
    await services.computerHistory.clear('all');
    await services.computerHistory.detail('entry');
    await services.computerHistory.updateSettings({ enabled: false });
    await services.computerHistory.requestPermissions();
    await services.computerHistory.pause('1h');
    await services.computerHistory.resume();
    await services.computerHistory.deleteEntry('entry');
    await services.computerHistory.retrySummary();
    assert.deepEqual(calls, [
      { name: 'history.status', args: [] },
      { name: 'history.clear', args: ['all'] },
      { name: 'history.detail', args: ['entry'] },
      { name: 'history.updateSettings', args: [{ enabled: false }] },
      { name: 'history.requestPermissions', args: [] },
      { name: 'history.pause', args: ['1h'] },
      { name: 'history.resume', args: [] },
      { name: 'history.deleteEntry', args: ['entry'] },
      { name: 'history.retrySummary', args: [] },
    ]);
  });

  it('reads the analysis model from the ready local Host, never a selected remote', async () => {
    const modelKey = ' provider::local-model ';
    let readiness = 'ready';
    const targets: unknown[] = [];
    const services = createDesktopModuleHubServices({
      runtimeHostProfiles: {
        getDefaultHost: async () => { throw new Error('Must not use the default'); },
        getSnapshot: async () => ({
          entries: [
            { profile: { id: 'remote', kind: 'remote' }, readiness: 'ready', hostId: 'remote-host' },
            { profile: { id: 'local-profile', kind: 'local' }, readiness, hostId: 'local-host' },
          ],
        }),
      },
      dailyReview: {
        getConfig: async (target: unknown) => {
          targets.push(target);
          return { modelKey };
        },
      },
      connections: {
        getSnapshot: async () => { assert.fail('An explicit model does not require the default catalog'); },
      },
    } as unknown as DesktopModuleHubBridge);
    assert.equal(await services.computerHistory.getAnalysisModel(), 'provider::local-model');
    readiness = 'unavailable';
    await assert.rejects(services.computerHistory.getAnalysisModel(), /Local Runtime Host is unavailable/);
    assert.deepEqual(targets, [
      { profileId: 'local-profile', hostId: 'local-host' },
    ]);
  });

  it('resolves an empty analysis key through the canonical local default, not the selected remote', async () => {
    const calls: Call[] = [];
    const localTarget = { profileId: 'local-profile', hostId: 'local-host' };
    const services = createDesktopModuleHubServices({
      runtimeHostProfiles: {
        getDefaultHost: async () => { assert.fail('Selected remote is not the history model authority'); },
        getSnapshot: async () => ({
          defaultProfileId: 'remote',
          entries: [
            { profile: { id: 'remote', kind: 'remote' }, readiness: 'ready', hostId: 'remote-host', isDefault: true },
            { profile: { id: 'local-profile', kind: 'local' }, readiness: 'ready', hostId: 'local-host', isDefault: false },
          ],
        }),
      },
      dailyReview: {
        getConfig: async (target: unknown) => { calls.push({ name: 'config', args: [target] }); return { modelKey: ' ' }; },
      },
      connections: {
        getSnapshot: async (sessionId: unknown, target: unknown) => {
          calls.push({ name: 'catalog', args: [sessionId, target] });
          return {
            connections: [
              { slug: 'non-default', defaultModel: '' },
              { slug: 'local-provider', defaultModel: 'local-model' },
            ],
          };
        },
      },
    } as unknown as DesktopModuleHubBridge);
    assert.equal(await services.computerHistory.getAnalysisModel(), 'local-provider::local-model');
    assert.deepEqual(calls, [
      { name: 'config', args: [localTarget] },
      { name: 'catalog', args: [undefined, localTarget] },
    ]);
  });

  it('returns no analysis model only when the local catalog has no canonical default target', async () => {
    let connections: { slug: string; defaultModel: string; enabledModelIds?: string[] }[] = [];
    const services = createDesktopModuleHubServices({
      runtimeHostProfiles: {
        getSnapshot: async () => ({ entries: [{ profile: { id: 'local', kind: 'local' }, readiness: 'ready', hostId: 'local-host' }] }),
      },
      dailyReview: { getConfig: async () => ({ modelKey: '' }) },
      connections: { getSnapshot: async () => ({ connections }) },
    } as unknown as DesktopModuleHubBridge);
    assert.equal(await services.computerHistory.getAnalysisModel(), null);
    connections = [{ slug: 'configured', defaultModel: '', enabledModelIds: ['available-but-not-default'] }];
    assert.equal(await services.computerHistory.getAnalysisModel(), null, 'an available model is not an implicit default');
  });

  it('propagates local default catalog read failure instead of reporting an unconfigured model', async () => {
    const failure = new Error('Local connection catalog unavailable');
    const services = createDesktopModuleHubServices({
      runtimeHostProfiles: {
        getSnapshot: async () => ({ entries: [{ profile: { id: 'local', kind: 'local' }, readiness: 'ready', hostId: 'local-host' }] }),
      },
      dailyReview: { getConfig: async () => ({ modelKey: '' }) },
      connections: { getSnapshot: async () => { throw failure; } },
    } as unknown as DesktopModuleHubBridge);
    await assert.rejects(services.computerHistory.getAnalysisModel(), (error) => error === failure);
  });

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
