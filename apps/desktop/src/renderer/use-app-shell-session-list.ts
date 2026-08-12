import { useRef, useState } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
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

type ToastApi = {
  error(title: string, description?: string): void;
};

export function useAppShellSessionList(toastApi: ToastApi) {
  const uiLocale = useUiLocale();
  const uiLocaleRef = useRef(uiLocale);
  uiLocaleRef.current = uiLocale;
  const [sessions, setSessionsState] = useState<SessionSummary[]>([]);
  const [authoritativeSessionIds, setAuthoritativeSessionIds] =
    useState<ReadonlySet<string> | null>(null);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const sessionReadBoundariesRef = useRef<SessionReadBoundaries>({});
  const refresherRef = useRef<SessionListRefresher | null>(null);

  function commitSessions(next: SessionSummary[]): void {
    sessionsRef.current = next;
    setSessionsState(next);
  }

  function setSessions(updater: (current: SessionSummary[]) => SessionSummary[]): void {
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

  async function refreshSessions(): Promise<SessionSummary[]> {
    return refresherRef.current!.refresh();
  }

  function seedSessions(snapshotSessions: readonly SessionSummary[]): SessionSummary[] {
    const next = applySessionReadOverrides([...snapshotSessions], sessionReadBoundariesRef.current)
      .map(normalizeSessionSummaryForDisplay);
    commitSessions(next);
    return next;
  }

  function upsertSessionSummary(session: SessionSummary): void {
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

  function clearSessions(): void {
    sessionReadBoundariesRef.current = {};
    commitSessions([]);
    setAuthoritativeSessionIds(new Set());
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
    clearSessions,
  };
}
