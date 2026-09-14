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

import { offerableCatalogEntries, providerDefaultsOf, providerMenuLabel } from '@maka/core/llm-connections';
import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type {
  ComputerHistoryAnalysisModel,
  ModuleHubClipboardService,
  ModuleHubRuntimeHostRef,
  ModuleHubServices,
} from '../../features/module-hub/index.js';

type DesktopModuleHubSettingsBridge = Partial<
  Pick<MakaBridge['settings'], 'getClient' | 'updateClient' | 'subscribeClientChanged'>
>;

export type DesktopModuleHubBridge = Pick<
  MakaBridge,
  'computerHistory' | 'connections' | 'dailyReview' | 'runtimeHostProfiles' | 'scheduledTasks' | 'skills'
> & {
  /** Optional at runtime so a renderer can coexist with an older preload. */
  readonly settings?: DesktopModuleHubSettingsBridge;
};

export interface DesktopModuleHubServiceDependencies {
  readonly clipboard?: ModuleHubClipboardService;
}

/** The only Desktop-to-Module-Hub adapter. */
export function createDesktopModuleHubServices(
  bridge: DesktopModuleHubBridge = window.maka,
  dependencies: DesktopModuleHubServiceDependencies = {},
): ModuleHubServices {
  const getClientSettings = bridge.settings?.getClient;
  const updateClientSettings = bridge.settings?.updateClient;
  const subscribeClientSettings = bridge.settings?.subscribeClientChanged;
  const clientSettingsSupported =
    typeof getClientSettings === 'function' &&
    typeof updateClientSettings === 'function';
  let analysisModelWrite: Promise<ComputerHistoryAnalysisModel> | undefined;

  async function localAnalysisHost(
    expected?: ModuleHubRuntimeHostRef,
  ): Promise<ModuleHubRuntimeHostRef> {
    const snapshot = await bridge.runtimeHostProfiles.getSnapshot();
    const local = snapshot.entries.find((entry) => entry.profile.kind === 'local');
    if (!local?.enabled || local.readiness !== 'ready' || !local.hostId) {
      throw new Error('Local Runtime Host is unavailable');
    }
    if (expected && (
      expected.profileId !== local.profile.id || expected.hostId !== local.hostId
    )) {
      throw new Error('Local analysis Host changed; refresh the model selection');
    }
    return { profileId: local.profile.id, hostId: local.hostId };
  }

  // Saves use this helper directly; the public reader waits for the save itself.
  async function readAnalysisModel(
    expected?: ModuleHubRuntimeHostRef,
  ): Promise<ComputerHistoryAnalysisModel> {
    const getConfig = bridge.dailyReview.getConfig;
    if (!getConfig) throw new Error('Daily Review configuration is unavailable');
    const host = await localAnalysisHost(expected);
    const [config, catalog] = await Promise.all([
      getConfig.call(bridge.dailyReview, host),
      bridge.connections.getSnapshot(undefined, host),
    ]);
    await localAnalysisHost(host);
    const models = new Map<string, ComputerHistoryAnalysisModel['models'][number]>();
    let defaultModelKey: string | null = null;
    for (const connection of catalog.connections) {
      const provider = providerDefaultsOf(connection.providerType);
      if (!provider) continue;
      const providerLabel = providerMenuLabel(connection.providerType) ?? connection.providerType;
      // Match chat choices: API names are user-facing; OAuth names can identify accounts.
      const connectionName = provider.authKind === 'oauth_token'
        ? providerLabel : connection.name.trim() || providerLabel;
      for (const entry of offerableCatalogEntries(connection)) {
        const key = `${connection.slug}::${entry.id}`;
        models.set(key, {
          key,
          label: entry.displayName?.trim() || entry.id,
          connectionName,
        });
        if (entry.id === connection.defaultModel.trim()) defaultModelKey = key;
      }
    }
    return { host, modelKey: config.modelKey.trim(), defaultModelKey, models: [...models.values()] };
  }

  return {
    runtimeHosts: {
      getDefault: () => bridge.runtimeHostProfiles.getDefaultHost(),
      subscribeChanges: (handler) =>
        bridge.runtimeHostProfiles.subscribeChanges((event) =>
          handler({
            profileId: event.profileId,
            readiness: event.readiness,
            hostId: event.hostId,
            isDefault: event.isDefault,
            removed: event.removed,
          }),
        ),
    },
    skills: {
      list: (host) => bridge.skills.list(host),
      listManagedSources: (host) => bridge.skills.sources.list(host),
      listBundledCatalog: (host) => bridge.skills.catalog.list(host),
      importManagedSource: (host) => bridge.skills.sources.importLocalFile(host),
      installManaged: (sourceId, host) =>
        bridge.skills.installManaged(sourceId, host),
      installBundled: (id, host) => bridge.skills.catalog.install(id, host),
      previewUpdate: (skillId, host) =>
        bridge.skills.previewUpdate(skillId, host),
      updateManaged: (skillId, options, host) =>
        bridge.skills.updateManaged(skillId, options, host),
      setEnabled: (skillId, enabled, host) =>
        bridge.skills.setEnabled(skillId, enabled, host),
      setPinned: (skillRef, pinned, host) =>
        bridge.skills.setPinned(skillRef, pinned, host),
      delete: (skillRef, host) => bridge.skills.delete(skillRef, host),
      open: (skillId, target, host) => bridge.skills.open(skillId, target, host),
    },
    scheduledTasks: bridge.scheduledTasks,
    clientSettings: {
      supported: clientSettingsSupported,
      async getKeepSystemAwake() {
        if (!getClientSettings) {
          throw new Error('Client settings are unavailable');
        }
        const settings = await getClientSettings.call(bridge.settings);
        return settings.system.keepSystemAwake;
      },
      async setKeepSystemAwake(next) {
        if (!updateClientSettings) {
          throw new Error('Client settings are unavailable');
        }
        const result = await updateClientSettings.call(bridge.settings, {
          system: { keepSystemAwake: next },
        });
        return result.settings.system.keepSystemAwake;
      },
      subscribeChanges(handler) {
        if (!subscribeClientSettings) return () => undefined;
        return subscribeClientSettings.call(bridge.settings, handler);
      },
    },
    dailyReview: {
      day: (offsetDays, daySpan, host) =>
        bridge.dailyReview.day(offsetDays, daySpan, host),
      runOnce: (input) => {
        const runOnce = bridge.dailyReview.runOnce;
        if (!runOnce) throw new Error('Daily Review run is unavailable');
        return runOnce(input);
      },
      listArchives: () => {
        const listArchives = bridge.dailyReview.listArchives;
        if (!listArchives) throw new Error('Daily Review history is unavailable');
        return listArchives();
      },
      getArchive: (archiveId) => {
        const getArchive = bridge.dailyReview.getArchive;
        if (!getArchive) throw new Error('Daily Review history is unavailable');
        return getArchive(archiveId);
      },
      saveMarkdownToFile: (input) =>
        bridge.dailyReview.saveMarkdownToFile(input),
    },
    computerHistory: {
      getViewGranularity: () => {
        try {
          const value = localStorage.getItem('maka-computer-history-granularity-v1');
          return value === '10min' || value === 'day' ? value : '6h';
        } catch {
          return '6h';
        }
      },
      setViewGranularity: (value) => {
        try {
          localStorage.setItem('maka-computer-history-granularity-v1', value);
        } catch {
          // Browsing stays usable when client preference storage is unavailable.
        }
      },
      status: () => bridge.computerHistory.status(),
      timeline: (days) => bridge.computerHistory.timeline(days),
      applications: (bundleIds) => bridge.computerHistory.applications(bundleIds),
      detail: (id) => bridge.computerHistory.detail(id),
      revealSummary: (id) => bridge.computerHistory.revealSummary(id),
      updateSettings: (patch) => bridge.computerHistory.updateSettings(patch),
      pause: (duration) => bridge.computerHistory.pause(duration),
      resume: () => bridge.computerHistory.resume(),
      clear: (scope) => bridge.computerHistory.clear(scope),
      deleteEntry: (id) => bridge.computerHistory.deleteEntry(id),
      retrySummary: () => bridge.computerHistory.retrySummary(),
      async getAnalysisModel() {
        while (analysisModelWrite) {
          // A failed save still requires a fresh read of the retained selection.
          await analysisModelWrite.catch(() => undefined);
        }
        return readAnalysisModel();
      },
      async setAnalysisModel(modelKey, host) {
        if (analysisModelWrite) throw new Error('An analysis model update is already in progress');
        const target = { profileId: host.profileId, hostId: host.hostId };
        const key = modelKey.trim();
        const write = Promise.resolve().then(async () => {
          const setConfig = bridge.dailyReview.setConfig;
          if (!setConfig) throw new Error('Daily Review configuration is unavailable');
          const current = await readAnalysisModel(target);
          const selectedKey = key || current.defaultModelKey;
          if (!current.models.some((model) => model.key === selectedKey)) {
            throw new Error('The selected analysis model is no longer available');
          }
          await setConfig.call(bridge.dailyReview, { modelKey: key }, current.host);
          return readAnalysisModel(target);
        });
        analysisModelWrite = write;
        try {
          return await write;
        } finally {
          analysisModelWrite = undefined;
        }
      },
    },
    clipboard: {
      writeText(text) {
        const clipboard = dependencies.clipboard ?? navigator.clipboard;
        return clipboard.writeText(text);
      },
    },
  };
}
