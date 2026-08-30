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
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import type { ModuleHubServices } from '../../features/module-hub/index.js';

type DesktopModuleHubSettingsBridge = Partial<
  Pick<MakaBridge['settings'], 'getClient' | 'updateClient' | 'subscribeClientChanged' | 'usageStats'>
>;

export type DesktopModuleHubBridge = Pick<
  MakaBridge,
  'artifacts' | 'runtimeHostProfiles' | 'scheduledTasks' | 'sessions' | 'skills'
> & {
  /** Optional at runtime while a loaded renderer still has an older preload. */
  readonly contract?: MakaBridge['contract'];
  /** Optional at runtime so a renderer can coexist with an older preload. */
  readonly settings?: DesktopModuleHubSettingsBridge;
};

/** The only Desktop-to-Module-Hub adapter. */
export function createDesktopModuleHubServices(
  bridge: DesktopModuleHubBridge = window.maka,
): ModuleHubServices {
  const getClientSettings = bridge.settings?.getClient;
  const updateClientSettings = bridge.settings?.updateClient;
  const subscribeClientSettings = bridge.settings?.subscribeClientChanged;
  const readUsageStats = bridge.settings?.usageStats;
  const clientSettingsSupported =
    typeof getClientSettings === 'function' &&
    typeof updateClientSettings === 'function';
  const dailyReviewSupported = bridge.contract?.version === 2;

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
    scheduledTasks: {
      list: (host) => bridge.scheduledTasks.list(host),
      create: (input, host) => bridge.scheduledTasks.create(input, host),
      update: (id, patch, host) =>
        bridge.scheduledTasks.update(id, patch, host),
      setEnabled: (id, enabled, host) =>
        bridge.scheduledTasks.setEnabled(id, enabled, host),
      triggerNow: (id, host, intentBody) =>
        bridge.scheduledTasks.triggerNow(id, host, intentBody),
      snooze: (id, host) => bridge.scheduledTasks.snooze(id, host),
      clearRunHistory: (id, host) =>
        bridge.scheduledTasks.clearRunHistory(id, host),
      delete: (id, host) => bridge.scheduledTasks.delete(id, host),
      subscribeChanges: (handler) =>
        bridge.scheduledTasks.subscribeChanges(handler),
      subscribeDue: (handler) => bridge.scheduledTasks.subscribeDue(handler),
    },
    dailyReview: {
      supported: dailyReviewSupported,
      async listSessions(host) {
        if (!dailyReviewSupported) {
          throw new Error('Daily Review requires a newer Desktop bridge');
        }
        const catalog = await bridge.sessions.listWithCoverage();
        if (!catalog.completeHostIds.includes(host.hostId)) {
          throw new Error('The Runtime Host Session catalog is unavailable');
        }
        return collapseSessionRevisions(
          catalog.sessions.filter((session) => session.runtimeHostId === host.hostId),
        );
      },
      listArtifacts: (sessionId) => bridge.artifacts.list(sessionId),
      async readUsage(range, host) {
        if (!dailyReviewSupported) {
          throw new Error('Daily Review requires a newer Desktop bridge');
        }
        if (!readUsageStats) throw new Error('Usage statistics are unavailable');
        const stats = await readUsageStats.call(bridge.settings, range, host);
        return {
          totalRequests: stats.summary.totalRequests,
          totalTokens: stats.summary.totalTokens,
          totalCostUsd: stats.summary.totalCostUsd,
        };
      },
      subscribeChanges(handler) {
        const unsubscribeSessions = bridge.sessions.subscribeChanges(() => handler());
        const unsubscribeArtifacts = bridge.artifacts.subscribeChanges(() => handler());
        return () => {
          unsubscribeSessions();
          unsubscribeArtifacts();
        };
      },
    },
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
  };
}
