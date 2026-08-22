import type { UiLocale } from '@maka/core/ui-locale';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type {
  RuntimeHostRestartDecision,
  RuntimeHostUpgradePrompts,
  RuntimeHostWaitDecision,
} from './runtime-host-desktop-manager.js';
import { buildRuntimeHostUpgradeDialogOptions } from './runtime-host-upgrade-copy.js';

export function createRuntimeHostUpgradePrompts(
  resolveLocale: () => Promise<UiLocale>,
  showDialog: (
    options: MessageBoxOptions,
    locale: UiLocale,
  ) => Promise<MessageBoxReturnValue>,
): RuntimeHostUpgradePrompts {
  return {
    restartable: async (conflict): Promise<RuntimeHostRestartDecision> => {
      const locale = await resolveLocale();
      const { response } = await showDialog(
        buildRuntimeHostUpgradeDialogOptions(conflict, true, locale),
        locale,
      );
      if (response === 0) return 'restart';
      if (response === 1) return 'wait';
      return 'cancel';
    },
    waitOnly: async (conflict): Promise<RuntimeHostWaitDecision> => {
      const locale = await resolveLocale();
      const { response } = await showDialog(
        buildRuntimeHostUpgradeDialogOptions(conflict, false, locale),
        locale,
      );
      return response === 0 ? 'wait' : 'cancel';
    },
  };
}
