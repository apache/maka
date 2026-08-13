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
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

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
  setSkills: Dispatch<SetStateAction<SkillEntry[]>>;
  setManagedSkillSources: Dispatch<SetStateAction<ManagedSkillSourceEntry[]>>;
  setBundledSkillCatalog: Dispatch<SetStateAction<BundledSkillCatalogEntry[]>>;
  toastApi: ToastApi;
}): AppShellSkillActions {
  const { uiLocale, isSkillsSurfaceActive, setBundledSkillCatalog, setManagedSkillSources, setSkills, toastApi } = deps;
  const copy = getShellCopy(uiLocale).skillActions;
  const openSkill = createOpenSkillAction({
    uiLocale,
    isSkillsSurfaceActive,
    toastApi,
  });

  async function refreshSkills(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.list();
      setSkills(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error(
          copy.refreshSkillsFailedTitle,
          localizedShellErrorMessage(error, copy.refreshSkillsFallback, uiLocale),
        );
      }
    }
  }

  async function refreshManagedSkillSources(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.sources.list();
      setManagedSkillSources(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error(
          copy.refreshSourcesFailedTitle,
          localizedShellErrorMessage(error, copy.refreshSourcesFallback, uiLocale),
        );
      }
    }
  }

  async function refreshBundledSkillCatalog(options: { shouldShowError?: () => boolean } = {}) {
    try {
      const next = await window.maka.skills.catalog.list();
      setBundledSkillCatalog(next);
    } catch (error) {
      if (options.shouldShowError?.() ?? true) {
        toastApi.error(
          copy.refreshBundledFailedTitle,
          localizedShellErrorMessage(error, copy.refreshBundledFallback, uiLocale),
        );
      }
    }
  }

  async function installBundledSkill(id: string) {
    try {
      const result = await window.maka.skills.catalog.install(id);
      if (!result.ok) {
        if (isSkillsSurfaceActive())
          toastApi.error(copy.installBundledFailedTitle, copy.installFailures[result.reason]);
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
        toastApi.error(
          copy.installBundledFailedTitle,
          localizedShellErrorMessage(error, copy.installBundledFallback, uiLocale),
        );
      }
    }
  }

  async function importManagedSkillSource() {
    try {
      const result = await window.maka.skills.sources.importLocalFile();
      if (!result.ok) {
        if (result.reason !== 'cancelled' && isSkillsSurfaceActive()) {
          toastApi.error(copy.importSourceFailedTitle, copy.sourceFailures[result.reason]);
        }
        return;
      }
      await refreshManagedSkillSources({
        shouldShowError: isSkillsSurfaceActive,
      });
      if (isSkillsSurfaceActive()) toastApi.success(copy.importedSourceTitle, result.source.name);
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(
          copy.importSourceFailedTitle,
          localizedShellErrorMessage(error, copy.importSourceFallback, uiLocale),
        );
      }
    }
  }

  async function installManagedSkill(sourceId: string) {
    try {
      const result = await window.maka.skills.installManaged(sourceId);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error(copy.installFailedTitle, copy.installFailures[result.reason]);
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      await refreshManagedSkillSources({
        shouldShowError: isSkillsSurfaceActive,
      });
      if (isSkillsSurfaceActive()) toastApi.success(copy.installedTitle, copy.installedDescription(result.skill.id));
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(copy.installFailedTitle, localizedShellErrorMessage(error, copy.installFallback, uiLocale));
      }
    }
  }

  async function previewManagedSkillUpdate(skillId: string): Promise<ManagedSkillUpdatePreview | null> {
    try {
      const result = await window.maka.skills.previewUpdate(skillId);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error(copy.previewFailedTitle, copy.previewFailures[result.reason]);
        return null;
      }
      return result.preview;
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(copy.previewFailedTitle, localizedShellErrorMessage(error, copy.previewFallback, uiLocale));
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
      const result = await window.maka.skills.updateManaged(skillId, options);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error(copy.updateFailedTitle, copy.updateFailures[result.reason]);
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
        toastApi.error(copy.updateFailedTitle, localizedShellErrorMessage(error, copy.updateFallback, uiLocale));
      }
      return false;
    }
  }

  async function setSkillEnabled(skillId: string, enabled: boolean) {
    try {
      const result = await window.maka.skills.setEnabled(skillId, enabled);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error(copy.toggleFailedTitle, copy.runtimeFailures[result.reason]);
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(enabled ? copy.enabledTitle : copy.disabledTitle, copy.runtimeDescription(result.skill.name));
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(copy.toggleFailedTitle, localizedShellErrorMessage(error, copy.toggleFallback, uiLocale));
      }
    }
  }

  async function setSkillPinned(skillRef: string, pinned: boolean) {
    try {
      const result = await window.maka.skills.setPinned(skillRef, pinned);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error(copy.toggleFailedTitle, copy.runtimeFailures[result.reason]);
        return;
      }
      await refreshSkills({ shouldShowError: isSkillsSurfaceActive });
      if (isSkillsSurfaceActive()) {
        toastApi.success(pinned ? copy.pinnedTitle : copy.unpinnedTitle, result.skill.name);
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(copy.toggleFailedTitle, localizedShellErrorMessage(error, copy.toggleFallback, uiLocale));
      }
    }
  }

  async function deleteSkill(skillRef: string) {
    try {
      const result = await window.maka.skills.delete(skillRef);
      if (!result.ok) {
        if (isSkillsSurfaceActive()) toastApi.error(copy.deleteFailedTitle, copy.deleteFailures[result.reason]);
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
        toastApi.error(copy.deleteFailedTitle, localizedShellErrorMessage(error, copy.deleteFallback, uiLocale));
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
