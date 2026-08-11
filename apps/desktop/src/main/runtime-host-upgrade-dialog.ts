import type { UiLocale } from '@maka/core';
import { dialog } from 'electron';
import type {
  RuntimeHostRestartDecision,
  RuntimeHostUpgradePrompts,
  RuntimeHostWaitDecision,
} from './runtime-host-desktop-manager.js';
import { whileAwaitingPerson } from './startup-step.js';
import { buildRuntimeHostUpgradeDialogOptions } from './runtime-host-upgrade-copy.js';

export function createRuntimeHostUpgradePrompts(
  resolveLocale: () => Promise<UiLocale>,
): RuntimeHostUpgradePrompts {
  return {
    restartable: async (conflict): Promise<RuntimeHostRestartDecision> => {
      const { response } = await whileAwaitingPerson(
        dialog.showMessageBox(
          buildRuntimeHostUpgradeDialogOptions(conflict, true, await resolveLocale()),
        ),
      );
      if (response === 0) return 'restart';
      if (response === 1) return 'wait';
      return 'cancel';
    },
    waitOnly: async (conflict): Promise<RuntimeHostWaitDecision> => {
      const { response } = await whileAwaitingPerson(
        dialog.showMessageBox(
          buildRuntimeHostUpgradeDialogOptions(conflict, false, await resolveLocale()),
        ),
      );
      return response === 0 ? 'wait' : 'cancel';
    },
  };
}
