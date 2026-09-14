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
import { describe, it, type TestContext } from 'node:test';
import type { ComputerHistoryApplication } from '@maka/core/computer-history';
import type { DailyReviewConfig } from '@maka/core/daily-review';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import { deferred } from '@maka/core/test-only/async-primitives';
import type {
  DesktopRuntimeHostProfileChangedEvent,
  DesktopRuntimeHostProfileSnapshot,
} from '../../preload/bridge-contract.js';
import type {
  ComputerHistoryAnalysisModel,
  ModuleHubRuntimeHostRef,
} from '../../renderer/features/module-hub/index.js';
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

function mockLocalStorage(t: TestContext, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
}

const LOCAL_ANALYSIS_HOST = { profileId: 'local-profile', hostId: 'local-host' };

function analysisConnection(overrides: Partial<ProjectedLlmConnection> = {}): ProjectedLlmConnection {
  return {
    connectionId: 'connection-local',
    slug: 'local-provider',
    name: 'Coproxy',
    providerType: 'openai',
    enabled: true,
    defaultModel: 'old-model',
    enabledModelIds: ['old-model', 'next-model'],
    catalogEntries: [
      { id: 'old-model', displayName: ' Current analysis ', canUseAsChatDefault: true, isDefault: true, supportsVision: false, thinkingLevels: [] },
      { id: 'next-model', displayName: 'Next analysis', canUseAsChatDefault: true, isDefault: false, supportsVision: false, thinkingLevels: [] },
    ],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function analysisFixture() {
  const calls: Call[] = [];
  const state = {
    profiles: {
      defaultProfileId: 'remote',
      entries: [
        {
          profile: { id: 'remote', name: 'Remote', kind: 'remote', rootId: 'remote-root', transport: { kind: 'tls', url: 'https://example.invalid' } },
          enabled: true, isDefault: true, readiness: 'ready', hostId: 'remote-host',
        },
        {
          profile: { id: LOCAL_ANALYSIS_HOST.profileId, name: 'Local', kind: 'local' },
          enabled: true, isDefault: false, readiness: 'ready', hostId: LOCAL_ANALYSIS_HOST.hostId,
        },
      ],
    } as DesktopRuntimeHostProfileSnapshot,
    config: { enabled: true, executeTime: '09:30', modelKey: 'local-provider::old-model' } as DailyReviewConfig,
    connections: [analysisConnection()],
    beforeWrite: async () => {},
    beforeCatalog: async () => {},
  };
  const bridge = {
    runtimeHostProfiles: {
      getDefaultHost: async () => { assert.fail('History must not use the selected/default remote Host'); },
      getSnapshot: async () => {
        calls.push({ name: 'profiles', args: [] });
        return state.profiles;
      },
    },
    dailyReview: {
      getConfig: async (host: ModuleHubRuntimeHostRef) => {
        calls.push({ name: 'config', args: [host] });
        return { ...state.config };
      },
      setConfig: async (patch: Partial<DailyReviewConfig>, host: ModuleHubRuntimeHostRef) => {
        calls.push({ name: 'save', args: [patch, host] });
        await state.beforeWrite();
        state.config = { ...state.config, ...patch };
        return { ...state.config };
      },
    },
    connections: {
      getSnapshot: async (sessionId: string | undefined, host: ModuleHubRuntimeHostRef) => {
        calls.push({ name: 'catalog', args: [sessionId, host] });
        await state.beforeCatalog();
        return { connections: state.connections, defaultConnection: 'local-provider' };
      },
    },
    computerHistory: {
      updateSettings: async () => { assert.fail('Selecting a model must not change History consent'); },
    },
  } as unknown as DesktopModuleHubBridge;
  return { state, calls, bridge, service: createDesktopModuleHubServices(bridge).computerHistory };
}

describe('createDesktopModuleHubServices', () => {
  it('persists history view granularity across adapter recreation without bridge, model, or settings calls', (t) => {
    const key = 'maka-computer-history-granularity-v1';
    const values = new Map<string, string>();
    mockLocalStorage(t, {
      value: {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => { values.set(name, value); },
      },
    });
    const calls: Call[] = [];
    const bridge = new Proxy({} as DesktopModuleHubBridge, {
      get: (_target, domain) => methodRecorder(calls, String(domain)),
    });
    const history = createDesktopModuleHubServices(bridge).computerHistory;

    assert.equal(history.getViewGranularity(), '6h');
    assert.equal(values.size, 0, 'reading the default does not write a preference');
    for (const unknown of ['week', '"day"']) {
      values.set(key, unknown);
      assert.equal(history.getViewGranularity(), '6h');
      assert.equal(values.get(key), unknown, 'reading an unknown value does not overwrite it');
    }
    for (const granularity of ['10min', 'day', '6h'] as const) {
      history.setViewGranularity(granularity);
      assert.deepEqual([...values], [[key, granularity]]);
      assert.equal(history.getViewGranularity(), granularity);
      assert.equal(createDesktopModuleHubServices(bridge).computerHistory.getViewGranularity(), granularity);
    }
    assert.deepEqual(calls, []);
  });

  for (const failure of ['missing', 'access denied', 'operations denied'] as const) {
    it(`keeps history view defaults usable when browser storage is ${failure}`, (t) => {
      const unavailable = () => { throw new Error('Browser storage unavailable'); };
      mockLocalStorage(t, failure === 'access denied' ? { get: unavailable } : {
        value: failure === 'missing' ? undefined : { getItem: unavailable, setItem: unavailable },
      });
      const calls: Call[] = [];
      const bridge = new Proxy({} as DesktopModuleHubBridge, {
        get: (_target, domain) => methodRecorder(calls, String(domain)),
      });
      const history = createDesktopModuleHubServices(bridge).computerHistory;

      assert.equal(history.getViewGranularity(), '6h');
      for (const granularity of ['10min', 'day'] as const) {
        assert.doesNotThrow(() => history.setViewGranularity(granularity));
        assert.equal(history.getViewGranularity(), '6h');
        assert.equal(createDesktopModuleHubServices(bridge).computerHistory.getViewGranularity(), '6h');
      }
      assert.deepEqual(calls, []);
    });
  }

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
    await services.computerHistory.revealSummary('10min-1789273200000');
    await services.computerHistory.updateSettings({ enabled: false });
    assert.equal('requestPermissions' in services.computerHistory, false, 'OS actions belong to Permission Center');
    await services.computerHistory.pause('1h');
    await services.computerHistory.resume();
    await services.computerHistory.deleteEntry('entry');
    await services.computerHistory.retrySummary();
    assert.deepEqual(calls, [
      { name: 'history.status', args: [] },
      { name: 'history.clear', args: ['all'] },
      { name: 'history.detail', args: ['entry'] },
      { name: 'history.revealSummary', args: ['10min-1789273200000'] },
      { name: 'history.updateSettings', args: [{ enabled: false }] },
      { name: 'history.pause', args: ['1h'] },
      { name: 'history.resume', args: [] },
      { name: 'history.deleteEntry', args: ['entry'] },
      { name: 'history.retrySummary', args: [] },
    ]);
    const failure = new Error('Computer History summary could not be revealed');
    history.revealSummary = async () => { throw failure; };
    await assert.rejects(services.computerHistory.revealSummary('10min-1789273200000'), (error) => error === failure);
  });

  it('reads the selection and Host catalog from the ready local Host, never a selected remote', async () => {
    const { state, calls, service } = analysisFixture();
    state.config = { ...state.config, modelKey: ' local-provider::old-model ' };
    const result: ComputerHistoryAnalysisModel = await service.getAnalysisModel();
    assert.deepEqual(result, {
      host: LOCAL_ANALYSIS_HOST,
      modelKey: 'local-provider::old-model',
      defaultModelKey: 'local-provider::old-model',
      models: [
        { key: 'local-provider::old-model', label: 'Current analysis', connectionName: 'Coproxy' },
        { key: 'local-provider::next-model', label: 'Next analysis', connectionName: 'Coproxy' },
      ],
    });
    assert.deepEqual(calls.filter((call) => call.name !== 'profiles'), [
      { name: 'config', args: [LOCAL_ANALYSIS_HOST] },
      { name: 'catalog', args: [undefined, LOCAL_ANALYSIS_HOST] },
    ]);
  });

  it('rejects missing, disabled, unready, and unidentified local Hosts before reading or writing models', async () => {
    for (const condition of ['missing', 'disabled', 'connecting', 'reconnecting', 'unavailable', 'unidentified'] as const) {
      const { state, calls, service } = analysisFixture();
      state.profiles = {
        ...state.profiles,
        entries: state.profiles.entries.flatMap((entry) => {
          if (entry.profile.kind !== 'local') return [entry];
          if (condition === 'missing') return [];
          return [{
            ...entry,
            enabled: condition !== 'disabled',
            readiness: ['connecting', 'reconnecting', 'unavailable'].includes(condition)
              ? condition as 'connecting' | 'reconnecting' | 'unavailable' : 'ready',
            hostId: condition === 'unidentified' ? undefined : entry.hostId,
          }];
        }),
      };
      await assert.rejects(service.getAnalysisModel(), /Local Runtime Host is unavailable/, condition);
      await assert.rejects(service.setAnalysisModel('local-provider::next-model', LOCAL_ANALYSIS_HOST), /Local Runtime Host is unavailable/, condition);
      assert.ok(calls.every((call) => call.name === 'profiles'), condition);
    }
  });

  it('offers only enabled Host catalog entries with safe display names and no invented fallback', async () => {
    const { state, service } = analysisFixture();
    const hostEntries = analysisConnection().catalogEntries;
    state.connections = [
      analysisConnection({
        enabledModelIds: ['old-model', 'not-chat', 'no-entry'],
        catalogEntries: [...hostEntries, { ...hostEntries[1]!, id: 'not-chat', canUseAsChatDefault: false }],
      }),
      analysisConnection({
        slug: 'second-account', name: 'private@example.invalid', providerType: 'openai-codex',
        defaultModel: '', enabledModelIds: ['host-only'],
        catalogEntries: [{ ...hostEntries[1]!, id: 'host-only', displayName: ' ' }],
      }),
      analysisConnection({ slug: 'disabled', enabled: false }),
      analysisConnection({ slug: 'unknown', providerType: 'unknown-provider' as ProjectedLlmConnection['providerType'] }),
      analysisConnection({ slug: 'empty-host-catalog', catalogEntries: [] }),
    ];
    const result = await service.getAnalysisModel();
    assert.deepEqual(result.models, [
      { key: 'local-provider::old-model', label: 'Current analysis', connectionName: 'Coproxy' },
      { key: 'second-account::host-only', label: 'host-only', connectionName: 'OpenAI OAuth' },
    ]);
    assert.equal(JSON.stringify(result).includes('private@example.invalid'), false);
  });

  it('keeps follow-default distinct and recognizes only an actually offerable canonical default', async () => {
    const { state, service } = analysisFixture();
    state.config = { ...state.config, modelKey: ' ' };
    assert.equal((await service.getAnalysisModel()).modelKey, '');
    assert.equal((await service.getAnalysisModel()).defaultModelKey, 'local-provider::old-model');
    for (const connection of [
      analysisConnection({ defaultModel: '' }),
      analysisConnection({ defaultModel: 'removed-model' }),
      analysisConnection({
        catalogEntries: analysisConnection().catalogEntries.map((entry) =>
          entry.id === 'old-model' ? { ...entry, canUseAsChatDefault: false } : entry),
      }),
      analysisConnection({ enabled: false }),
    ]) {
      state.connections = [connection];
      assert.equal((await service.getAnalysisModel()).defaultModelKey, null);
      await assert.rejects(service.setAnalysisModel('', LOCAL_ANALYSIS_HOST), /no longer available/);
    }
    state.connections = [];
    assert.deepEqual(await service.getAnalysisModel(), {
      host: LOCAL_ANALYSIS_HOST, modelKey: '', defaultModelKey: null, models: [],
    });
  });

  it('preserves an unavailable saved key without offering it or accepting it on save', async () => {
    const { state, calls, service } = analysisFixture();
    state.config = { ...state.config, modelKey: 'removed-provider::removed-model' };
    const result = await service.getAnalysisModel();
    assert.equal(result.modelKey, 'removed-provider::removed-model');
    assert.equal(result.models.some((model) => model.key === result.modelKey), false);
    await assert.rejects(service.setAnalysisModel(result.modelKey, result.host), /no longer available/);
    state.connections = [analysisConnection({ enabledModelIds: ['old-model'] })];
    await assert.rejects(service.setAnalysisModel('local-provider::next-model', result.host), /no longer available/);
    assert.equal(calls.some((call) => call.name === 'save'), false);
  });

  it('saves only modelKey to the local Daily Review authority, preserving schedule and History consent', async () => {
    const { state, calls, service } = analysisFixture();
    const snapshot = await service.getAnalysisModel();
    const updated = await service.setAnalysisModel('local-provider::next-model', snapshot.host);
    assert.equal(updated.modelKey, 'local-provider::next-model');
    assert.deepEqual(updated.host, LOCAL_ANALYSIS_HOST);
    assert.deepEqual(state.config, { enabled: true, executeTime: '09:30', modelKey: 'local-provider::next-model' });
    const reset = await service.setAnalysisModel('', snapshot.host);
    assert.equal(reset.modelKey, '');
    assert.equal(reset.defaultModelKey, 'local-provider::old-model');
    assert.deepEqual(calls.filter((call) => call.name === 'save'), [
      { name: 'save', args: [{ modelKey: 'local-provider::next-model' }, LOCAL_ANALYSIS_HOST] },
      { name: 'save', args: [{ modelKey: '' }, LOCAL_ANALYSIS_HOST] },
    ]);
    assert.ok(calls.filter((call) => call.name === 'config').every((call) =>
      (call.args[0] as ModuleHubRuntimeHostRef).profileId === LOCAL_ANALYSIS_HOST.profileId));
    assert.ok(calls.filter((call) => call.name === 'catalog').every((call) =>
      (call.args[1] as ModuleHubRuntimeHostRef).profileId === LOCAL_ANALYSIS_HOST.profileId));
  });

  it('rejects remote and stale snapshot targets and a Host changed during catalog reads', async () => {
    const { state, calls, service } = analysisFixture();
    const snapshot = await service.getAnalysisModel();
    await assert.rejects(service.setAnalysisModel('local-provider::next-model', { profileId: 'remote', hostId: 'remote-host' }), /Host changed/);
    state.profiles = {
      ...state.profiles,
      entries: state.profiles.entries.map((entry) => entry.profile.kind === 'local' ? { ...entry, hostId: 'replacement' } : entry),
    };
    await assert.rejects(service.setAnalysisModel('local-provider::next-model', snapshot.host), /Host changed/);
    const replacement = await service.getAnalysisModel();
    state.beforeCatalog = async () => {
      state.profiles = { ...state.profiles, entries: state.profiles.entries.filter((entry) => entry.profile.kind !== 'local') };
    };
    await assert.rejects(service.setAnalysisModel('local-provider::next-model', replacement.host), /Local Runtime Host is unavailable/);
    assert.equal(calls.some((call) => call.name === 'save'), false);
  });

  it('rejects a stale read if the local Host changes before the snapshot completes', async () => {
    const { state, service } = analysisFixture();
    state.beforeCatalog = async () => {
      state.profiles = {
        ...state.profiles,
        entries: state.profiles.entries.map((entry) => entry.profile.kind === 'local' ? { ...entry, hostId: 'replacement' } : entry),
      };
    };
    await assert.rejects(service.getAnalysisModel(), /Host changed/);
  });

  it('makes returning readers wait through an in-flight save and rejects duplicate saves', { timeout: 2_000 }, async () => {
    const { state, calls, service } = analysisFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    state.beforeWrite = () => { entered.resolve(); return release.promise; };
    const saving = service.setAnalysisModel('local-provider::next-model', LOCAL_ANALYSIS_HOST);
    await assert.rejects(service.setAnalysisModel('', LOCAL_ANALYSIS_HOST), /already in progress/);
    await entered.promise;
    const readsBefore = calls.filter((call) => call.name === 'config').length;
    let settled = false;
    const returning = service.getAnalysisModel().finally(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(calls.filter((call) => call.name === 'config').length, readsBefore);
    release.resolve();
    const [saved, reread] = await Promise.all([saving, returning]);
    assert.equal(saved.modelKey, 'local-provider::next-model');
    assert.equal(reread.modelKey, saved.modelKey);
    assert.equal(calls.filter((call) => call.name === 'save').length, 1);
  });

  it('exposes failed writes while waiting readers recover persisted state and subsequent saves remain usable', { timeout: 2_000 }, async () => {
    const { state, service } = analysisFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const failure = new Error('Model write failed');
    state.beforeWrite = async () => { entered.resolve(); await release.promise; throw failure; };
    const saving = assert.rejects(
      service.setAnalysisModel('local-provider::next-model', LOCAL_ANALYSIS_HOST),
      (error) => error === failure,
    );
    await entered.promise;
    const returning = service.getAnalysisModel();
    release.resolve();
    await saving;
    assert.equal((await returning).modelKey, 'local-provider::old-model');
    state.beforeWrite = async () => {};
    assert.equal((await service.setAnalysisModel('local-provider::next-model', LOCAL_ANALYSIS_HOST)).modelKey, 'local-provider::next-model');
  });

  it('propagates fresh config/catalog failures instead of reporting an absent model or a successful save', async () => {
    const { state, bridge, service } = analysisFixture();
    const failure = new Error('Catalog read failed');
    state.beforeCatalog = async () => { throw failure; };
    await assert.rejects(service.getAnalysisModel(), (error) => error === failure);
    state.beforeCatalog = async () => {};
    state.beforeWrite = async () => {
      state.beforeCatalog = async () => { throw failure; };
    };
    await assert.rejects(service.setAnalysisModel('local-provider::next-model', LOCAL_ANALYSIS_HOST), (error) => error === failure);
    assert.equal(state.config.modelKey, 'local-provider::next-model', 'write can commit even when confirmation fails');
    await assert.rejects(service.getAnalysisModel(), (error) => error === failure);
    state.beforeCatalog = async () => {};
    assert.equal((await service.getAnalysisModel()).modelKey, 'local-provider::next-model');
    bridge.dailyReview.getConfig = async () => { throw failure; };
    await assert.rejects(service.getAnalysisModel(), (error) => error === failure);
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
