import { useRef, useState } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import { normalizeSessionSummaryForDisplay } from './session-status-presentation';
import {
  applyLocalSessionRead,
  applySessionReadOverrides,
  createSessionListRefresher,
  type SessionListRefresher,
  type SessionReadBoundaries,
} from './session-read-state';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function useAppShellSessionList(toastApi: ToastApi) {
  const uiLocale = useUiLocale();
  const uiLocaleRef = useRef(uiLocale);
  uiLocaleRef.current = uiLocale;
  const [sessions, setSessionsState] = useState<DesktopSessionSummary[]>([]);
  const [authoritativeSessionIds, setAuthoritativeSessionIds] =
    useState<ReadonlySet<string> | null>(null);
  const sessionsRef = useRef<DesktopSessionSummary[]>([]);
  const sessionReadBoundariesRef = useRef<SessionReadBoundaries>({});
  const refresherRef = useRef<SessionListRefresher<DesktopSessionSummary> | null>(null);

  function commitSessions(next: DesktopSessionSummary[]): void {
    sessionsRef.current = next;
    setSessionsState(next);
  }

  function setSessions(
    updater: (current: DesktopSessionSummary[]) => DesktopSessionSummary[],
  ): void {
    setSessionsState((current) => {
      const next = updater(current);
      sessionsRef.current = next;
      return next;
    });
  }

  if (!refresherRef.current) {
    refresherRef.current = createSessionListRefresher({
      listSessions: () => window.maka.sessions.list(),
      readBoundaries: () => sessionReadBoundariesRef.current,
      currentSessions: () => sessionsRef.current,
      commitSessions: (next) => {
        const normalized = next.map(normalizeSessionSummaryForDisplay);
        commitSessions(normalized);
        setAuthoritativeSessionIds(new Set(normalized.map(({ id }) => id)));
      },
      onError: (error) => {
        const locale = uiLocaleRef.current;
        const copy = getDesktopConversationCopy(locale).actions;
        toastApi.error(
          copy.refreshSessionsFailedTitle,
          localizedShellErrorMessage(error, copy.refreshSessionsFailedFallback, locale),
        );
      },
    });
  }

  async function refreshSessions(): Promise<DesktopSessionSummary[]> {
    return refresherRef.current!.refresh();
  }

  function seedSessions(
    snapshotSessions: readonly DesktopSessionSummary[],
  ): DesktopSessionSummary[] {
    const next = applySessionReadOverrides([...snapshotSessions], sessionReadBoundariesRef.current)
      .map(normalizeSessionSummaryForDisplay);
    commitSessions(next);
    return next;
  }

  function upsertSessionSummary(session: DesktopSessionSummary): void {
    setSessions((current) => [
      normalizeSessionSummaryForDisplay(session),
      ...current.filter((entry) => entry.id !== session.id),
    ]);
  }

  function markSessionReadLocally(sessionId: string, readMessages: readonly StoredMessage[]): void {
    setSessions((current) => applyLocalSessionRead(
      sessionReadBoundariesRef.current,
      current,
      sessionId,
      readMessages,
    ));
  }

  return {
    sessions,
    authoritativeSessionIds,
    sessionsRef,
    setSessions,
    refreshSessions,
    seedSessions,
    upsertSessionSummary,
    markSessionReadLocally,
  };
}
