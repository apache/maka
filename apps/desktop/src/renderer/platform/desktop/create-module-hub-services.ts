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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type {
  ModuleHubClipboardService,
  ModuleHubServices,
} from '../../features/module-hub/index.js';

type DesktopModuleHubSettingsBridge = Partial<
  Pick<MakaBridge['settings'], 'getClient' | 'updateClient' | 'subscribeClientChanged'>
>;

export type DesktopModuleHubBridge = Pick<
  MakaBridge,
  'dailyReview' | 'runtimeHostProfiles' | 'scheduledTasks' | 'skills'
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
    clipboard: {
      writeText(text) {
        const clipboard = dependencies.clipboard ?? navigator.clipboard;
        return clipboard.writeText(text);
      },
    },
  };
}
