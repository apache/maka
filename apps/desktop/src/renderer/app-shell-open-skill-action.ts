import type { UiLocale } from '@maka/core/ui-locale';
import { openSkillFailureCopy } from './app-shell-copy';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function createOpenSkillAction(deps: {
  uiLocale: UiLocale;
  isSkillsSurfaceActive: () => boolean;
  toastApi: ToastApi;
}): (skillId: string) => Promise<void> {
  const { uiLocale, isSkillsSurfaceActive, toastApi } = deps;
  const copy = getShellCopy(uiLocale).skillActions;

  async function openSkill(skillId: string) {
    try {
      const result = await window.maka.skills.open(skillId, 'file');
      if (!result.ok) {
        if (isSkillsSurfaceActive())
          toastApi.error(copy.openFailedTitle, openSkillFailureCopy(result.reason, uiLocale));
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(copy.openFailedTitle, localizedShellErrorMessage(error, copy.openFallback, uiLocale));
      }
    }
  }

  return openSkill;
}
