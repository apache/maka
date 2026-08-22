import type { UiLocale } from '@maka/core/ui-locale';
import { openSkillFailureCopy } from './app-shell-copy';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(title: string, description?: string, diagnosticTarget?: { profileId: string }): void;
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
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.open(skillId, 'file', host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive())
          toastApi.error(
            copy.openFailedTitle,
            openSkillFailureCopy(result.reason, uiLocale),
            diagnosticTarget,
          );
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(
          copy.openFailedTitle,
          localizedShellErrorMessage(error, copy.openFallback, uiLocale),
          defaultRuntimeHostDiagnosticTarget(error),
        );
      }
    }
  }

  return openSkill;
}
