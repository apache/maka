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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiLocale } from "@maka/core/ui-locale";
import type {
  BundledSkillCatalogEntry,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  SkillEntry,
  ToastApi,
} from "@maka/ui";
import {
  getShellCopy,
  localizedShellErrorMessage,
} from "../../../locales/shell-copy.js";
import type { ModuleHubRuntimeHostRef } from "../ports.js";
import { useModuleHubServices } from "../services-context.js";
import {
  defaultRuntimeHostDiagnosticTarget,
  defaultRuntimeHostOperationHost,
  isDefaultRuntimeHostCurrent,
  runIfDefaultRuntimeHostCurrent,
  runOnDefaultRuntimeHost,
} from "./default-runtime-host.js";

type SkillsToastApi = Pick<ToastApi, "success" | "error">;

type RefreshOptions = {
  shouldShowError?: () => boolean;
};

export interface SkillsHostModel {
  skills: SkillEntry[];
  managedSkillSources: ManagedSkillSourceEntry[];
  bundledSkillCatalog: BundledSkillCatalogEntry[];
  onRefreshSkills(): Promise<void>;
  onOpenSkill?: (skillId: string) => Promise<void>;
  onUseSkill(skillId: string, skillName: string): void;
  onOpenSkillsFolder?: () => void | Promise<void>;
  onRefreshManagedSkillSources(): Promise<void>;
  onImportManagedSkillSource?: () => Promise<void>;
  onInstallManagedSkill(sourceId: string): Promise<void>;
  onRefreshBundledSkillCatalog(): Promise<void>;
  onInstallBundledSkill(id: string): Promise<void>;
  onPreviewManagedSkillUpdate(
    skillId: string,
  ): Promise<ManagedSkillUpdatePreview | null>;
  onUpdateManagedSkill(
    skillId: string,
    options?: {
      force?: boolean;
      expectedCurrentSha256?: string;
      expectedSourceSha256?: string;
    },
  ): Promise<boolean>;
  onSetSkillEnabled(skillId: string, enabled: boolean): Promise<void>;
  onSetSkillPinned(skillRef: string, pinned: boolean): Promise<void>;
  onDeleteSkill(skillRef: string): Promise<void>;
}

export interface SkillsController {
  host: SkillsHostModel;
  /** Changes only when the current default Host's installed-Skills projection commits. */
  readonly revision: number;
  /** Refreshes every project-scoped Skills projection after a project change. */
  refreshProjectSkills(): Promise<void>;
}

export interface UseSkillsControllerInput {
  uiLocale: UiLocale;
  active: boolean;
  toastApi: SkillsToastApi;
  useSkillInChat(skillId: string, skillName: string): void;
  openSkillsFolder?: () => void | Promise<void>;
}

type SkillsProjection =
  "skills" | "managedSkillSources" | "bundledSkillCatalog";

/** Owns the three Skills projections, their Host fences, and every Skills mutation. */
export function useSkillsController(
  input: UseSkillsControllerInput,
): SkillsController {
  const services = useModuleHubServices();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [revision, setRevision] = useState(0);
  const [managedSkillSources, setManagedSkillSources] = useState<
    ManagedSkillSourceEntry[]
  >([]);
  const [bundledSkillCatalog, setBundledSkillCatalog] = useState<
    BundledSkillCatalogEntry[]
  >([]);
  const generationsRef = useRef<Record<SkillsProjection, number>>({
    skills: 0,
    managedSkillSources: 0,
    bundledSkillCatalog: 0,
  });
  const mountedRef = useRef(true);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationsRef.current.skills += 1;
      generationsRef.current.managedSkillSources += 1;
      generationsRef.current.bundledSkillCatalog += 1;
    };
  }, []);

  const isSkillsSurfaceActive = useCallback(
    () => mountedRef.current && inputRef.current.active,
    [],
  );

  const isOperationHostCurrent = useCallback(
    async (error: unknown): Promise<boolean> => {
      if (!mountedRef.current) return false;
      const host = defaultRuntimeHostOperationHost(error);
      if (!host) return mountedRef.current;
      const current = await isDefaultRuntimeHostCurrent(
        services.runtimeHosts,
        host,
      );
      return mountedRef.current && current;
    },
    [services.runtimeHosts],
  );

  const shouldReportRefreshError = useCallback(
    async (options: RefreshOptions, error: unknown): Promise<boolean> => {
      const shouldShowError = options.shouldShowError;
      if (shouldShowError && !shouldShowError()) return false;
      if (!(await isOperationHostCurrent(error))) return false;
      return shouldShowError?.() ?? true;
    },
    [isOperationHostCurrent],
  );

  const reportRuntimeHostError = useCallback(
    (title: string, fallback: string, error: unknown): void => {
      const current = inputRef.current;
      current.toastApi.error(
        title,
        localizedShellErrorMessage(error, fallback, current.uiLocale),
        undefined,
        defaultRuntimeHostDiagnosticTarget(error),
      );
    },
    [],
  );

  const refreshSkills = useCallback(
    async (options: RefreshOptions = {}): Promise<void> => {
      const generation = ++generationsRef.current.skills;
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.list(host),
        );
        await runIfDefaultRuntimeHostCurrent(
          services.runtimeHosts,
          next.host,
          () => {
            if (
              mountedRef.current &&
              generation === generationsRef.current.skills
            ) {
              setSkills(next.value);
              setRevision((current) => current + 1);
            }
          },
        );
      } catch (error) {
        if (!mountedRef.current || generation !== generationsRef.current.skills)
          return;
        const shouldReport = await shouldReportRefreshError(options, error);
        if (
          mountedRef.current &&
          generation === generationsRef.current.skills &&
          shouldReport
        ) {
          reportRuntimeHostError(
            copy.refreshSkillsFailedTitle,
            copy.refreshSkillsFallback,
            error,
          );
        }
      }
    },
    [
      isOperationHostCurrent,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportRefreshError,
    ],
  );

  const refreshManagedSkillSources = useCallback(
    async (options: RefreshOptions = {}): Promise<void> => {
      const generation = ++generationsRef.current.managedSkillSources;
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.listManagedSources(host),
        );
        await runIfDefaultRuntimeHostCurrent(
          services.runtimeHosts,
          next.host,
          () => {
            if (
              mountedRef.current &&
              generation === generationsRef.current.managedSkillSources
            ) {
              setManagedSkillSources(next.value);
            }
          },
        );
      } catch (error) {
        if (
          !mountedRef.current ||
          generation !== generationsRef.current.managedSkillSources
        ) {
          return;
        }
        const shouldReport = await shouldReportRefreshError(options, error);
        if (
          mountedRef.current &&
          generation === generationsRef.current.managedSkillSources &&
          shouldReport
        ) {
          reportRuntimeHostError(
            copy.refreshSourcesFailedTitle,
            copy.refreshSourcesFallback,
            error,
          );
        }
      }
    },
    [
      isOperationHostCurrent,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportRefreshError,
    ],
  );

  const refreshBundledSkillCatalog = useCallback(
    async (options: RefreshOptions = {}): Promise<void> => {
      const generation = ++generationsRef.current.bundledSkillCatalog;
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.listBundledCatalog(host),
        );
        await runIfDefaultRuntimeHostCurrent(
          services.runtimeHosts,
          next.host,
          () => {
            if (
              mountedRef.current &&
              generation === generationsRef.current.bundledSkillCatalog
            ) {
              setBundledSkillCatalog(next.value);
            }
          },
        );
      } catch (error) {
        if (
          !mountedRef.current ||
          generation !== generationsRef.current.bundledSkillCatalog
        ) {
          return;
        }
        const shouldReport = await shouldReportRefreshError(options, error);
        if (
          mountedRef.current &&
          generation === generationsRef.current.bundledSkillCatalog &&
          shouldReport
        ) {
          reportRuntimeHostError(
            copy.refreshBundledFailedTitle,
            copy.refreshBundledFallback,
            error,
          );
        }
      }
    },
    [
      isOperationHostCurrent,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportRefreshError,
    ],
  );

  const shouldReportMutation = useCallback(
    async (host: ModuleHubRuntimeHostRef): Promise<boolean> => {
      if (!isSkillsSurfaceActive()) return false;
      let activeAfterHostCheck = false;
      const current = await runIfDefaultRuntimeHostCurrent(
        services.runtimeHosts,
        host,
        () => {
          activeAfterHostCheck = isSkillsSurfaceActive();
        },
      );
      return current && activeAfterHostCheck;
    },
    [isSkillsSurfaceActive, services.runtimeHosts],
  );

  const shouldReportOperationError = useCallback(
    async (error: unknown): Promise<boolean> => {
      if (!isSkillsSurfaceActive()) return false;
      if (!(await isOperationHostCurrent(error))) return false;
      return isSkillsSurfaceActive();
    },
    [isOperationHostCurrent, isSkillsSurfaceActive],
  );

  const importManagedSkillSource = useCallback(async (): Promise<void> => {
    const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
    try {
      const next = await runOnDefaultRuntimeHost(
        services.runtimeHosts,
        (host) => services.skills.importManagedSource(host),
      );
      if (!next.value.ok) {
        if (
          next.value.reason !== "cancelled" &&
          (await shouldReportMutation(next.host))
        ) {
          inputRef.current.toastApi.error(
            copy.importSourceFailedTitle,
            copy.sourceFailures[next.value.reason],
            undefined,
            next.diagnosticTarget,
          );
        }
        return;
      }
      await refreshManagedSkillSources({
        shouldShowError: isSkillsSurfaceActive,
      });
      if (await shouldReportMutation(next.host)) {
        inputRef.current.toastApi.success(
          copy.importedSourceTitle,
          next.value.source.name,
        );
      }
    } catch (error) {
      if (await shouldReportOperationError(error)) {
        reportRuntimeHostError(
          copy.importSourceFailedTitle,
          copy.importSourceFallback,
          error,
        );
      }
    }
  }, [
    isSkillsSurfaceActive,
    refreshManagedSkillSources,
    reportRuntimeHostError,
    services.runtimeHosts,
    services.skills,
    shouldReportOperationError,
    shouldReportMutation,
  ]);

  const installManagedSkill = useCallback(
    async (sourceId: string): Promise<void> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.installManaged(sourceId, host),
        );
        if (!next.value.ok) {
          if (await shouldReportMutation(next.host)) {
            inputRef.current.toastApi.error(
              copy.installFailedTitle,
              copy.installFailures[next.value.reason],
              undefined,
              next.diagnosticTarget,
            );
          }
          return;
        }
        await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
        await refreshManagedSkillSources({
          shouldShowError: isSkillsSurfaceActive,
        });
        if (await shouldReportMutation(next.host)) {
          inputRef.current.toastApi.success(
            copy.installedTitle,
            copy.installedDescription(next.value.skill.id),
          );
        }
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.installFailedTitle,
            copy.installFallback,
            error,
          );
        }
      }
    },
    [
      isSkillsSurfaceActive,
      refreshManagedSkillSources,
      refreshSkills,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const installBundledSkill = useCallback(
    async (id: string): Promise<void> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.installBundled(id, host),
        );
        if (!next.value.ok) {
          if (await shouldReportMutation(next.host)) {
            inputRef.current.toastApi.error(
              copy.installBundledFailedTitle,
              copy.installFailures[next.value.reason],
              undefined,
              next.diagnosticTarget,
            );
          }
          return;
        }
        await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
        await refreshBundledSkillCatalog({
          shouldShowError: isSkillsSurfaceActive,
        });
        if (await shouldReportMutation(next.host)) {
          inputRef.current.toastApi.success(
            copy.installedBundledTitle,
            copy.installedDescription(next.value.skill.id),
          );
        }
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.installBundledFailedTitle,
            copy.installBundledFallback,
            error,
          );
        }
      }
    },
    [
      isSkillsSurfaceActive,
      refreshBundledSkillCatalog,
      refreshSkills,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const previewManagedSkillUpdate = useCallback(
    async (skillId: string): Promise<ManagedSkillUpdatePreview | null> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.previewUpdate(skillId, host),
        );
        if (!next.value.ok) {
          if (await shouldReportMutation(next.host)) {
            inputRef.current.toastApi.error(
              copy.previewFailedTitle,
              copy.previewFailures[next.value.reason],
              undefined,
              next.diagnosticTarget,
            );
          }
          return null;
        }
        return (await shouldReportMutation(next.host))
          ? next.value.preview
          : null;
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.previewFailedTitle,
            copy.previewFallback,
            error,
          );
        }
        return null;
      }
    },
    [
      isSkillsSurfaceActive,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const updateManagedSkill = useCallback(
    async (
      skillId: string,
      options: {
        force?: boolean;
        expectedCurrentSha256?: string;
        expectedSourceSha256?: string;
      } = {},
    ): Promise<boolean> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.updateManaged(skillId, options, host),
        );
        if (!next.value.ok) {
          if (await shouldReportMutation(next.host)) {
            inputRef.current.toastApi.error(
              copy.updateFailedTitle,
              copy.updateFailures[next.value.reason],
              undefined,
              next.diagnosticTarget,
            );
          }
          return false;
        }
        await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
        if (await shouldReportMutation(next.host)) {
          inputRef.current.toastApi.success(
            options.force ? copy.forceUpdatedTitle : copy.updatedTitle,
            copy.updatedDescription(next.value.skill.id),
          );
        }
        return true;
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.updateFailedTitle,
            copy.updateFallback,
            error,
          );
        }
        return false;
      }
    },
    [
      isSkillsSurfaceActive,
      refreshSkills,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const setSkillEnabled = useCallback(
    async (skillId: string, enabled: boolean): Promise<void> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.setEnabled(skillId, enabled, host),
        );
        if (!next.value.ok) {
          if (await shouldReportMutation(next.host)) {
            inputRef.current.toastApi.error(
              copy.toggleFailedTitle,
              copy.runtimeFailures[next.value.reason],
              undefined,
              next.diagnosticTarget,
            );
          }
          return;
        }
        await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
        if (await shouldReportMutation(next.host)) {
          inputRef.current.toastApi.success(
            enabled ? copy.enabledTitle : copy.disabledTitle,
            copy.runtimeDescription(next.value.skill.name),
          );
        }
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.toggleFailedTitle,
            copy.toggleFallback,
            error,
          );
        }
      }
    },
    [
      isSkillsSurfaceActive,
      refreshSkills,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const setSkillPinned = useCallback(
    async (skillRef: string, pinned: boolean): Promise<void> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.setPinned(skillRef, pinned, host),
        );
        if (!next.value.ok) {
          if (await shouldReportMutation(next.host)) {
            inputRef.current.toastApi.error(
              copy.toggleFailedTitle,
              copy.runtimeFailures[next.value.reason],
              undefined,
              next.diagnosticTarget,
            );
          }
          return;
        }
        await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
        if (await shouldReportMutation(next.host)) {
          inputRef.current.toastApi.success(
            pinned ? copy.pinnedTitle : copy.unpinnedTitle,
            next.value.skill.name,
          );
        }
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.toggleFailedTitle,
            copy.toggleFallback,
            error,
          );
        }
      }
    },
    [
      isSkillsSurfaceActive,
      refreshSkills,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const deleteSkill = useCallback(
    async (skillRef: string): Promise<void> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.delete(skillRef, host),
        );
        if (!next.value.ok) {
          if (await shouldReportMutation(next.host)) {
            inputRef.current.toastApi.error(
              copy.deleteFailedTitle,
              copy.deleteFailures[next.value.reason],
              undefined,
              next.diagnosticTarget,
            );
          }
          return;
        }
        await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
        await refreshBundledSkillCatalog({
          shouldShowError: isSkillsSurfaceActive,
        });
        if (await shouldReportMutation(next.host)) {
          const displayId = skillRef.slice(skillRef.lastIndexOf(":") + 1);
          inputRef.current.toastApi.success(
            copy.deletedTitle,
            copy.deletedDescription(displayId),
          );
        }
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.deleteFailedTitle,
            copy.deleteFallback,
            error,
          );
        }
      }
    },
    [
      isSkillsSurfaceActive,
      refreshBundledSkillCatalog,
      refreshSkills,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const openSkill = useCallback(
    async (skillId: string): Promise<void> => {
      const copy = getShellCopy(inputRef.current.uiLocale).skillActions;
      try {
        const next = await runOnDefaultRuntimeHost(
          services.runtimeHosts,
          (host) => services.skills.open(skillId, "file", host),
        );
        if (!next.value.ok && (await shouldReportMutation(next.host))) {
          inputRef.current.toastApi.error(
            copy.openFailedTitle,
            copy.openFailures[next.value.reason],
            undefined,
            next.diagnosticTarget,
          );
        }
      } catch (error) {
        if (await shouldReportOperationError(error)) {
          reportRuntimeHostError(
            copy.openFailedTitle,
            copy.openFallback,
            error,
          );
        }
      }
    },
    [
      isSkillsSurfaceActive,
      reportRuntimeHostError,
      services.runtimeHosts,
      services.skills,
      shouldReportOperationError,
      shouldReportMutation,
    ],
  );

  const refreshProjectSkills = useCallback(async (): Promise<void> => {
    await Promise.all([
      refreshSkills(),
      refreshManagedSkillSources(),
      refreshBundledSkillCatalog(),
    ]);
  }, [refreshBundledSkillCatalog, refreshManagedSkillSources, refreshSkills]);

  const host = useMemo<SkillsHostModel>(
    () => ({
      skills,
      managedSkillSources,
      bundledSkillCatalog,
      onRefreshSkills: refreshSkills,
      onUseSkill: input.useSkillInChat,
      ...(input.openSkillsFolder
        ? {
            onOpenSkill: openSkill,
            onOpenSkillsFolder: input.openSkillsFolder,
            onImportManagedSkillSource: importManagedSkillSource,
          }
        : {}),
      onRefreshManagedSkillSources: refreshManagedSkillSources,
      onInstallManagedSkill: installManagedSkill,
      onRefreshBundledSkillCatalog: refreshBundledSkillCatalog,
      onInstallBundledSkill: installBundledSkill,
      onPreviewManagedSkillUpdate: previewManagedSkillUpdate,
      onUpdateManagedSkill: updateManagedSkill,
      onSetSkillEnabled: setSkillEnabled,
      onSetSkillPinned: setSkillPinned,
      onDeleteSkill: deleteSkill,
    }),
    [
      bundledSkillCatalog,
      deleteSkill,
      importManagedSkillSource,
      input.openSkillsFolder,
      input.useSkillInChat,
      installBundledSkill,
      installManagedSkill,
      managedSkillSources,
      openSkill,
      previewManagedSkillUpdate,
      refreshBundledSkillCatalog,
      refreshManagedSkillSources,
      refreshSkills,
      setSkillEnabled,
      setSkillPinned,
      skills,
      updateManagedSkill,
    ],
  );

  return useMemo(
    () => ({ host, revision, refreshProjectSkills }),
    [host, refreshProjectSkills, revision],
  );
}
