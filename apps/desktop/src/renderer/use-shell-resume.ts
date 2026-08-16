import { useState } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import { resumeParkToastCopy } from '@maka/ui';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  info(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

/**
 * Owns the #1223 safe-boundary resume cluster: the in-flight `resumePendingSessionId`
 * guard and the per-session parked-diagnostic descriptions surfaced on the
 * interrupted-turn banner, plus the `resumeInterruptedSession` handler that drives
 * `sessions.resumeLatest`. `activeId` is injected (the handler snapshots it as
 * `sessionId` so a session switch mid-resume settles the ORIGINAL session's pending
 * flag) alongside `toastApi` / `shellCopy` / `uiLocale`. The two state values are
 * returned raw so AppShell's banner JSX keeps its exact `resumePendingSessionId ===
 * activeId` / `resumeParkDescriptionBySession[activeId]` reads; the wiring
 * (`safeResumeAction=` element) stays in AppShell. Pure move — zero behavior change.
 */
export function useShellResume(options: {
  activeId: string | undefined;
  toastApi: ToastApi;
  shellCopy: ReturnType<typeof getShellCopy>['app'];
  uiLocale: UiLocale;
}): {
  resumePendingSessionId: string | null;
  resumeParkDescriptionBySession: Record<string, string>;
  resumeInterruptedSession: () => Promise<void>;
} {
  const { activeId, toastApi, shellCopy, uiLocale } = options;
  const [resumePendingSessionId, setResumePendingSessionId] = useState<string | null>(null);
  const [resumeParkDescriptionBySession, setResumeParkDescriptionBySession] = useState<Record<string, string>>({});

  async function resumeInterruptedSession(): Promise<void> {
    const sessionId = activeId;
    if (!sessionId || resumePendingSessionId !== null) return;
    setResumePendingSessionId(sessionId);
    try {
      const result = await window.maka.sessions.resumeLatest(sessionId);
      if (result.disposition === 'park') {
        const parkCopy = resumeParkToastCopy(result.rejectionReasons);
        setResumeParkDescriptionBySession((current) => ({
          ...current,
          [sessionId]: parkCopy.description,
        }));
        toastApi.error(parkCopy.title, parkCopy.description);
      } else {
        setResumeParkDescriptionBySession((current) => {
          const { [sessionId]: _removed, ...remaining } = current;
          void _removed;
          return remaining;
        });
        toastApi.info(shellCopy.resumeStartedTitle, shellCopy.resumeStartedDescription);
      }
    } catch (error) {
      toastApi.error(
        shellCopy.resumeFailedTitle,
        localizedShellErrorMessage(
          error,
          shellCopy.resumeFailedFallback,
          uiLocale,
        ),
      );
    } finally {
      setResumePendingSessionId((current) => current === sessionId ? null : current);
    }
  }

  return {
    resumePendingSessionId,
    resumeParkDescriptionBySession,
    resumeInterruptedSession,
  };
}
