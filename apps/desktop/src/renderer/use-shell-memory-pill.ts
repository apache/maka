import { useState } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

/**
 * Owns the session-context memory state (issue #1043): the `memoryActive`
 * flag surfaced when xuan's MEMORY.md is injected into the agent's system
 * prompt, plus the fire-and-forget `refreshMemoryActive` that re-reads
 * `window.maka.memory.getState()`.
 *
 * Refresh failures must stay visible (toast) and must preserve the last known
 * pill state - never silently flip to false. The mount recompute is driven by
 * `useAppShellBootstrapSubscriptions`; the Settings-close recompute is driven
 * by `closeSettings`. Both call the returned `refreshMemoryActive`.
 */
export function useShellMemoryPill({ toastApi, uiLocale }: { toastApi: ToastApi; uiLocale: UiLocale }): {
  memoryActive: boolean;
  clearMemoryActive: () => void;
  refreshMemoryActive: (failureContext?: 'load') => Promise<void>;
} {
  const [memoryActive, setMemoryActive] = useState(false);
  const copy = getShellCopy(uiLocale).app;
  async function refreshMemoryActive(failureContext?: 'load') {
    try {
      const next = await window.maka.memory.getState();
      setMemoryActive(next.agentReadEnabled && next.status === 'ok' && next.content.trim().length > 0);
    } catch (error) {
      toastApi.error(
        failureContext === 'load' ? copy.memoryLoadErrorTitle : copy.memoryRefreshErrorTitle,
        localizedShellErrorMessage(error, copy.memoryErrorFallback, uiLocale),
      );
    }
  }
  return {
    memoryActive,
    clearMemoryActive: () => setMemoryActive(false),
    refreshMemoryActive,
  };
}
