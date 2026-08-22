import type { Dispatch, SetStateAction } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import type {
  BundledSkillCatalogEntry,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  SkillEntry,
} from '@maka/ui';
import { openSkillFailureCopy } from './app-shell-copy';
import { createOpenSkillAction } from './app-shell-open-skill-action';
import {
  defaultRuntimeHostDiagnosticTarget,
  runIfDefaultRuntimeHostCurrent,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { profileId: string },
  ): void;
};

type RefBox<T> = { current: T };

export interface AppShellSkillActions {
  refreshSkills(options?: { shouldShowError?: () => boolean }): Promise<void>;
  refreshManagedSkillSources(options?: { shouldShowError?: () => boolean }): Promise<void>;
  refreshBundledSkillCatalog(options?: { shouldShowError?: () => boolean }): Promise<void>;
  importManagedSkillSource(): Promise<void>;
  installManagedSkill(sourceId: string): Promise<void>;
  installBundledSkill(id: string): Promise<void>;
  previewManagedSkillUpdate(skillId: string): Promise<ManagedSkillUpdatePreview | null>;
  updateManagedSkill(
    skillId: string,
    options?: {
      force?: boolean;
      expectedCurrentSha256?: string;
      expectedSourceSha256?: string;
    },
  ): Promise<boolean>;
  setSkillEnabled(skillId: string, enabled: boolean): Promise<void>;
  setSkillPinned(skillRef: string, pinned: boolean): Promise<void>;
  deleteSkill(skillRef: string): Promise<void>;
  openSkill(skillId: string): Promise<void>;
}

export function createAppShellSkillActions(deps: {
  uiLocale: UiLocale;
  isSkillsSurfaceActive: () => boolean;
  refreshGenerationsRef: RefBox<{
    skills: number;
    managedSkillSources: number;
    bundledSkillCatalog: number;
  }>;
  setSkills: Dispatch<SetStateAction<SkillEntry[]>>;
  setManagedSkillSources: Dispatch<SetStateAction<ManagedSkillSourceEntry[]>>;
  setBundledSkillCatalog: Dispatch<SetStateAction<BundledSkillCatalogEntry[]>>;
  toastApi: ToastApi;
}): AppShellSkillActions {
  const {
    uiLocale,
    isSkillsSurfaceActive,
    refreshGenerationsRef,
    setBundledSkillCatalog,
    setManagedSkillSources,
    setSkills,
    toastApi: baseToastApi,
  } = deps;
  const toastApi = {
    success: (title: string, description?: string) =>
      baseToastApi.success(title, description),
    error: (title: string, description?: string, diagnosticTarget?: { profileId: string }) =>
      baseToastApi.error(title, description, undefined, diagnosticTarget),
  };
  const reportRuntimeHostError = (title: string, fallback: string, error: unknown) =>
    toastApi.error(
      title,
      localizedShellErrorMessage(error, fallback, uiLocale),
      defaultRuntimeHostDiagnosticTarget(error),
    );
  const copy = getShellCopy(uiLocale).skillActions;
  const openSkill = createOpenSkillAction({
    uiLocale,
    isSkillsSurfaceActive,
    toastApi,
  });

  async function refreshSkills(options: { shouldShowError?: () => boolean } = {}) {
    const generation = ++refreshGenerationsRef.current.skills;
    try {
      const next = await runOnDefaultRuntimeHost((host) => window.maka.skills.list(host));
      await runIfDefaultRuntimeHostCurrent(next.host, () => {
        if (generation === refreshGenerationsRef.current.skills) setSkills(next.value);
      });
    } catch (error) {
      if (generation !== refreshGenerationsRef.current.skills) return;
      if (options.shouldShowError?.() ?? true) {
        reportRuntimeHostError(copy.refreshSkillsFailedTitle, copy.refreshSkillsFallback, error);
      }
    }
  }

  async function refreshManagedSkillSources(options: { shouldShowError?: () => boolean } = {}) {
    const generation = ++refreshGenerationsRef.current.managedSkillSources;
    try {
      const next = await runOnDefaultRuntimeHost((host) => window.maka.skills.sources.list(host));
      await runIfDefaultRuntimeHostCurrent(next.host, () => {
        if (generation === refreshGenerationsRef.current.managedSkillSources) {
          setManagedSkillSources(next.value);
        }
      });
    } catch (error) {
      if (generation !== refreshGenerationsRef.current.managedSkillSources) return;
      if (options.shouldShowError?.() ?? true) {
        reportRuntimeHostError(copy.refreshSourcesFailedTitle, copy.refreshSourcesFallback, error);
      }
    }
  }

  async function refreshBundledSkillCatalog(options: { shouldShowError?: () => boolean } = {}) {
    const generation = ++refreshGenerationsRef.current.bundledSkillCatalog;
    try {
      const next = await runOnDefaultRuntimeHost((host) => window.maka.skills.catalog.list(host));
      await runIfDefaultRuntimeHostCurrent(next.host, () => {
        if (generation === refreshGenerationsRef.current.bundledSkillCatalog) {
          setBundledSkillCatalog(next.value);
        }
      });
    } catch (error) {
      if (generation !== refreshGenerationsRef.current.bundledSkillCatalog) return;
      if (options.shouldShowError?.() ?? true) {
        reportRuntimeHostError(copy.refreshBundledFailedTitle, copy.refreshBundledFallback, error);
      }
    }
  }

  async function installBundledSkill(id: string) {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.catalog.install(id, host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive())
          toastApi.error(
            copy.installBundledFailedTitle,
            copy.installFailures[result.reason],
            diagnosticTarget,
          );
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      await refreshBundledSkillCatalog({
        shouldShowError: isSkillsSurfaceActive,
      });
      if (isSkillsSurfaceActive())
        toastApi.success(copy.installedBundledTitle, copy.installedDescription(result.skill.id));
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.installBundledFailedTitle, copy.installBundledFallback, error);
      }
    }
  }

  async function importManagedSkillSource() {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.sources.importLocalFile(host),
      );
      if (!result.ok) {
        if (result.reason !== 'cancelled' && isSkillsSurfaceActive()) {
          toastApi.error(
            copy.importSourceFailedTitle,
            copy.sourceFailures[result.reason],
            diagnosticTarget,
          );
        }
        return;
      }
      await refreshManagedSkillSources({
        shouldShowError: isSkillsSurfaceActive,
      });
      if (isSkillsSurfaceActive()) toastApi.success(copy.importedSourceTitle, result.source.name);
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.importSourceFailedTitle, copy.importSourceFallback, error);
      }
    }
  }

  async function installManagedSkill(sourceId: string) {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.installManaged(sourceId, host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.installFailedTitle, copy.installFailures[result.reason], diagnosticTarget);
        }
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      await refreshManagedSkillSources({
        shouldShowError: isSkillsSurfaceActive,
      });
      if (isSkillsSurfaceActive()) toastApi.success(copy.installedTitle, copy.installedDescription(result.skill.id));
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.installFailedTitle, copy.installFallback, error);
      }
    }
  }

  async function previewManagedSkillUpdate(skillId: string): Promise<ManagedSkillUpdatePreview | null> {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.previewUpdate(skillId, host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.previewFailedTitle, copy.previewFailures[result.reason], diagnosticTarget);
        }
        return null;
      }
      return result.preview;
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.previewFailedTitle, copy.previewFallback, error);
      }
      return null;
    }
  }

  async function updateManagedSkill(
    skillId: string,
    options: {
      force?: boolean;
      expectedCurrentSha256?: string;
      expectedSourceSha256?: string;
    } = {},
  ): Promise<boolean> {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.updateManaged(skillId, options, host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.updateFailedTitle, copy.updateFailures[result.reason], diagnosticTarget);
        }
        return false;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(
          options.force ? copy.forceUpdatedTitle : copy.updatedTitle,
          copy.updatedDescription(result.skill.id),
        );
      }
      return true;
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.updateFailedTitle, copy.updateFallback, error);
      }
      return false;
    }
  }

  async function setSkillEnabled(skillId: string, enabled: boolean) {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.setEnabled(skillId, enabled, host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.toggleFailedTitle, copy.runtimeFailures[result.reason], diagnosticTarget);
        }
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(enabled ? copy.enabledTitle : copy.disabledTitle, copy.runtimeDescription(result.skill.name));
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.toggleFailedTitle, copy.toggleFallback, error);
      }
    }
  }

  async function setSkillPinned(skillRef: string, pinned: boolean) {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.setPinned(skillRef, pinned, host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.toggleFailedTitle, copy.runtimeFailures[result.reason], diagnosticTarget);
        }
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(pinned ? copy.pinnedTitle : copy.unpinnedTitle, result.skill.name);
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.toggleFailedTitle, copy.toggleFallback, error);
      }
    }
  }

  async function deleteSkill(skillRef: string) {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.delete(skillRef, host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive()) {
          toastApi.error(copy.deleteFailedTitle, copy.deleteFailures[result.reason], diagnosticTarget);
        }
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      // A deleted bundled skill must reappear as installable under 内置, so
      // refresh the catalog's installed flags after removal.
      await refreshBundledSkillCatalog({
        shouldShowError: isSkillsSurfaceActive,
      });
      // The ref is scope-qualified (`user:agents:gh-cli`); the toast shows the
      // bare skill id, which is what the row itself is labelled with.
      const displayId = skillRef.slice(skillRef.lastIndexOf(':') + 1);
      if (isSkillsSurfaceActive()) toastApi.success(copy.deletedTitle, copy.deletedDescription(displayId));
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        reportRuntimeHostError(copy.deleteFailedTitle, copy.deleteFallback, error);
      }
    }
  }

  return {
    refreshSkills,
    refreshManagedSkillSources,
    refreshBundledSkillCatalog,
    importManagedSkillSource,
    installManagedSkill,
    installBundledSkill,
    previewManagedSkillUpdate,
    updateManagedSkill,
    setSkillEnabled,
    setSkillPinned,
    deleteSkill,
    openSkill,
  };
}
