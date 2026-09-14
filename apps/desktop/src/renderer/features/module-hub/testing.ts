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

import type { ComputerHistoryAnalysisModel, ModuleHubServices } from "./ports.js";
import type { NavSelection } from "@maka/ui";
import type { ModuleHubHostModel } from "./controller/use-module-hub-controller.js";
import type { HistoryDraftHostInput } from "./controller/use-computer-history-draft.js";
export { useComputerHistoryDraft } from "./controller/use-computer-history-draft.js";
export type { HistoryDraftHostInput } from "./controller/use-computer-history-draft.js";
export { ComputerHistoryPage } from "./ui/computer-history-page.js";
export { ComputerHistoryAppIcon } from "./ui/computer-history-app-icon.js";
export { ComputerHistoryDocument } from "./ui/computer-history-document.js";
export { filterHistoryEntries } from "./ui/computer-history-copy.js";
export { ComputerHistorySettingsPage } from "./ui/computer-history-settings-page.js";
export { useComputerHistorySettings, useRecentHistoryApplications } from "./controller/use-computer-history-settings.js";
export { normalizeHistoryExclusion } from "./ui/computer-history-settings-copy.js";
export { useComputerHistoryApplications } from "./controller/use-computer-history-applications.js";
export { useHistorySettingsFocus } from "./ui/use-history-settings-focus.js";
export { useHistoryModelSettingsNavigation } from "./ui/history-model-settings-navigation.js";

export { ModuleHubServicesProvider } from "./services-context.js";
export type { ModuleHubServices } from "./ports.js";
export {
  createModuleHubCommandPort,
  ModuleHubProvider,
  ModuleHubScheduledTasksBoundary,
  ModuleHubSkillCatalogRevisionBoundary,
  type ModuleHubCommands,
} from "./ui/module-hub-provider.js";
export { startModuleHubLifecycle } from "./controller/module-hub-lifecycle.js";
export { resolveModuleHubHostRoute } from "./controller/module-hub-route.js";
export { useComputerHistoryController } from "./controller/use-computer-history-controller.js";
export {
  useModuleHubController,
  type ModuleHubHostModel,
} from "./controller/use-module-hub-controller.js";
export {
  createDailyReviewBridge,
  useDailyReviewController,
  type DailyReviewController,
} from "./controller/use-daily-review-controller.js";
export {
  useKeepSystemAwakeController,
  type KeepSystemAwakeController,
} from "./controller/use-keep-system-awake-controller.js";
export {
  useScheduledTasksController,
  type ScheduledTasksController,
  type ScheduledTasksToastApi,
} from "./controller/use-scheduled-tasks-controller.js";
export type {
  ModuleHubRuntimeHostChangedEvent,
  ModuleHubRuntimeHostRef,
} from "./ports.js";
export {
  useSkillsController,
  type SkillsController,
  type UseSkillsControllerInput,
} from "./controller/use-skills-controller.js";

const noopSubscription = (): (() => void) => () => undefined;
const notConfigured = (operation: string): never => {
  throw new Error(`Fake ${operation} is not configured`);
};

export function createFakeComputerHistoryAnalysisModel(
  overrides: Partial<ComputerHistoryAnalysisModel> = {},
): ComputerHistoryAnalysisModel {
  return {
    host: { profileId: "local", hostId: "local" },
    modelKey: "",
    defaultModelKey: null,
    models: [],
    ...overrides,
  };
}

export function createFakeHistoryDraftHostInput(
  overrides: Partial<HistoryDraftHostInput> = {},
): HistoryDraftHostInput {
  return {
    activeSessionIsLocal: false,
    switchingSession: false,
    obscured: false,
    targetIsLocal: false,
    draftKey: 'unresolved',
    selectLocalTarget: () => undefined,
    composer: { current: null },
    captureSelection: () => () => false,
    selectChat: () => notConfigured("historyDraft.selectChat"),
    startNewSession: () => notConfigured("historyDraft.startNewSession"),
    reportError: () => notConfigured("historyDraft.reportError"),
    ...overrides,
  };
}

/** Environment-free Host model for route composition tests and Storybook. */
export function createFakeModuleHubHostModel(
  selection: NavSelection,
  overrides: Partial<ModuleHubHostModel> = {},
): ModuleHubHostModel {
  return {
    selection,
    selectModule: () => undefined,
    skills: {
      skills: [],
      managedSkillSources: [],
      bundledSkillCatalog: [],
      onRefreshSkills: async () => undefined,
      onUseSkill: () => undefined,
      onRefreshManagedSkillSources: async () => undefined,
      onImportManagedSkillSource: async () => undefined,
      onInstallManagedSkill: async () => undefined,
      onRefreshBundledSkillCatalog: async () => undefined,
      onInstallBundledSkill: async () => undefined,
      onPreviewManagedSkillUpdate: async () => null,
      onUpdateManagedSkill: async () => false,
      onSetSkillEnabled: async () => undefined,
      onSetSkillPinned: async () => undefined,
      onDeleteSkill: async () => undefined,
    },
    scheduledTasks: {
      scheduledTasks: [],
      createRequestNonce: 0,
      openCreate: () => undefined,
      handleCreateRequest: () => undefined,
      refresh: async () => undefined,
      refreshSurface: async () => undefined,
      create: async () => false,
      update: async () => false,
      toggle: async () => undefined,
      triggerNow: async () => undefined,
      snooze: async () => undefined,
      clearRunHistory: async () => undefined,
      delete: async () => undefined,
    },
    keepSystemAwake: {
      supported: false,
      keepSystemAwake: undefined,
      setKeepSystemAwake: async () => undefined,
    },
    dailyReview: {
      bridge: {
        fetchDay: async () => notConfigured("dailyReview.fetchDay"),
      },
      copyMarkdown: async () => undefined,
      appendMarkdown: () => undefined,
      saveMarkdown: async () => undefined,
      copyToday: async () => undefined,
      pasteToday: async () => undefined,
      saveToday: async () => undefined,
    },
    openSession: () => undefined,
    createHistoryDraft: () => notConfigured("createHistoryDraft"),
    ...overrides,
  };
}

/** Environment-free Module Hub defaults for focused tests and Storybook. */
export function createFakeModuleHubServices(
  overrides: Partial<ModuleHubServices> = {},
): ModuleHubServices {
  return {
    runtimeHosts: {
      getDefault: async () => ({ profileId: "local", hostId: "local" }),
      subscribeChanges: noopSubscription,
    },
    skills: {
      list: async () => [],
      listManagedSources: async () => [],
      listBundledCatalog: async () => [],
      importManagedSource: async () =>
        notConfigured("skills.importManagedSource"),
      installManaged: async () => notConfigured("skills.installManaged"),
      installBundled: async () => notConfigured("skills.installBundled"),
      previewUpdate: async () => notConfigured("skills.previewUpdate"),
      updateManaged: async () => notConfigured("skills.updateManaged"),
      setEnabled: async () => notConfigured("skills.setEnabled"),
      setPinned: async () => notConfigured("skills.setPinned"),
      delete: async () => notConfigured("skills.delete"),
      open: async () => notConfigured("skills.open"),
    },
    scheduledTasks: {
      list: async () => [],
      create: async () => notConfigured("scheduledTasks.create"),
      update: async () => notConfigured("scheduledTasks.update"),
      setEnabled: async () => notConfigured("scheduledTasks.setEnabled"),
      triggerNow: async () => notConfigured("scheduledTasks.triggerNow"),
      snooze: async () => notConfigured("scheduledTasks.snooze"),
      clearRunHistory: async () =>
        notConfigured("scheduledTasks.clearRunHistory"),
      delete: async () => notConfigured("scheduledTasks.delete"),
      subscribeChanges: noopSubscription,
      subscribeDue: noopSubscription,
    },
    clientSettings: {
      supported: true,
      getKeepSystemAwake: async () => false,
      setKeepSystemAwake: async (next) => next,
      subscribeChanges: noopSubscription,
    },
    dailyReview: {
      day: async () => notConfigured("dailyReview.day"),
      runOnce: async () => notConfigured("dailyReview.runOnce"),
      listArchives: async () => [],
      getArchive: async () => null,
      saveMarkdownToFile: async () =>
        notConfigured("dailyReview.saveMarkdownToFile"),
    },
    computerHistory: {
      status: async () => notConfigured("computerHistory.status"),
      timeline: async () => notConfigured("computerHistory.timeline"),
      applications: async () => notConfigured("computerHistory.applications"),
      detail: async () => notConfigured("computerHistory.detail"),
      revealSummary: async () => notConfigured("computerHistory.revealSummary"),
      updateSettings: async () => notConfigured("computerHistory.updateSettings"),
      requestPermissions: async () => notConfigured("computerHistory.requestPermissions"),
      pause: async () => notConfigured("computerHistory.pause"),
      resume: async () => notConfigured("computerHistory.resume"),
      clear: async () => notConfigured("computerHistory.clear"),
      deleteEntry: async () => notConfigured("computerHistory.deleteEntry"),
      retrySummary: async () => notConfigured("computerHistory.retrySummary"),
      getAnalysisModel: async () => notConfigured("computerHistory.getAnalysisModel"),
      setAnalysisModel: async () => notConfigured("computerHistory.setAnalysisModel"),
    },
    clipboard: {
      writeText: async () => undefined,
    },
    ...overrides,
  };
}
