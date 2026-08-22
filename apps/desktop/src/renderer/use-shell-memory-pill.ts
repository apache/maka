import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ): void;
};

/**
 * Owns the memory indicator for the active Session's Runtime Host. With no
 * active Session it reads the default Host instead.
 *
 * Refresh failures must stay visible (toast) and must preserve the last known
 * pill state - never silently flip to false. A Session change resets stale
 * state and starts a fresh read; Settings close and Host changes can request
 * the same refresh explicitly.
 */
export function useShellMemoryPill({
  toastApi,
  uiLocale,
  sessionId,
}: {
  toastApi: ToastApi;
  uiLocale: UiLocale;
  sessionId?: string;
}): {
  memoryActive: boolean;
  refreshMemoryActive: (failureContext?: 'load') => Promise<void>;
} {
  const [memoryActive, setMemoryActive] = useState(false);
  const refreshSequence = useRef(0);
  const copy = getShellCopy(uiLocale).app;
  async function refreshMemoryActive(failureContext?: 'load') {
    const sequence = ++refreshSequence.current;
    try {
      const next = sessionId
        ? await window.maka.memory.getState(sessionId)
        : (
            await runOnDefaultRuntimeHost((host) =>
              window.maka.memory.getState(undefined, host),
            )
          ).value;
      if (refreshSequence.current !== sequence) return;
      setMemoryActive(next.agentReadEnabled && next.status === 'ok' && next.content.trim().length > 0);
    } catch (error) {
      if (refreshSequence.current !== sequence) return;
      toastApi.error(
        failureContext === 'load' ? copy.memoryLoadErrorTitle : copy.memoryRefreshErrorTitle,
        localizedShellErrorMessage(error, copy.memoryErrorFallback, uiLocale),
        undefined,
        sessionId ? { sessionId } : defaultRuntimeHostDiagnosticTarget(error),
      );
    }
  }
  useEffect(() => {
    setMemoryActive(false);
    void refreshMemoryActive('load');
    return () => {
      refreshSequence.current += 1;
    };
  }, [sessionId]);
  return {
    memoryActive,
    refreshMemoryActive,
  };
}
