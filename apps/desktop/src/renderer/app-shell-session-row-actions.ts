import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { revisionFamilySessionIds } from '@maka/core/session-revisions';

type RefBox<T> = { current: T };

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  confirm(options: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

export interface AppShellSessionRowActions {
  flagSession(sessionId: string, flagged: boolean): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export function createAppShellSessionRowActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  clearSessionRendererState: (sessionId: string) => void;
  pendingSessionRowActionsRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<SessionSummary[]>;
  sessionsRef: RefBox<SessionSummary[]>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessages: (messages: StoredMessage[]) => void;
  toastApi: ToastApi;
}): AppShellSessionRowActions {
  const {
    uiLocale,
    activeIdRef,
    clearSessionRendererState,
    pendingSessionRowActionsRef,
    refreshSessions,
    sessionsRef,
    setActiveId,
    setMessages,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).sessionRowActions;

  async function runSessionRowAction(
    sessionId: string,
    actionId: 'flag' | 'archive' | 'rename' | 'delete',
    errorTitle: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const sessionPrefix = `${sessionId}:`;
    if (Array.from(pendingSessionRowActionsRef.current).some((key) => key.startsWith(sessionPrefix))) return;
    const key = `${sessionId}:${actionId}`;
    pendingSessionRowActionsRef.current.add(key);
    try {
      await action();
    } catch (error) {
      toastApi.error(errorTitle, localizedShellErrorMessage(error, copy.actionFallback, uiLocale));
    } finally {
      pendingSessionRowActionsRef.current.delete(key);
    }
  }

  async function flagSession(sessionId: string, flagged: boolean) {
    return runSessionRowAction(sessionId, 'flag', flagged ? copy.flagFailedTitle : copy.unflagFailedTitle, async () => {
      const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
      await window.maka.sessions.setFlagged(sessionId, flagged, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function archiveSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'archive', copy.archiveFailedTitle, async () => {
      const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
      await window.maka.sessions.archive(sessionId, { revisionFamily: true });
      if (activeIdRef.current && familyIds.includes(activeIdRef.current)) {
        setActiveId(undefined);
        setMessages([]);
      }
      for (const id of familyIds) clearSessionRendererState(id);
      await refreshSessions();
    });
  }

  async function unarchiveSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'archive', copy.unarchiveFailedTitle, async () => {
      const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
      await window.maka.sessions.unarchive(sessionId, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function renameSession(sessionId: string, name: string) {
    return runSessionRowAction(sessionId, 'rename', copy.renameFailedTitle, async () => {
      const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
      await window.maka.sessions.rename(sessionId, name, { revisionFamily: true });
      await refreshSessions();
    });
  }

  async function deleteSession(sessionId: string) {
    return runSessionRowAction(sessionId, 'delete', copy.deleteFailedTitle, async () => {
      const session = sessionsRef.current.find((entry) => entry.id === sessionId);
      const name = session?.name ?? copy.currentConversation;
      const ok = await toastApi.confirm({
        title: copy.deleteTitle(name),
        description: copy.deleteDescription,
        confirmLabel: copy.deleteLabel,
        cancelLabel: copy.cancelLabel,
        destructive: true,
      });
      if (!ok) return;
      const familyIds = revisionFamilySessionIds(sessionsRef.current, sessionId);
      await window.maka.sessions.remove(sessionId, { revisionFamily: true });
      if (activeIdRef.current && familyIds.includes(activeIdRef.current)) {
        setActiveId(undefined);
        setMessages([]);
      }
      for (const id of familyIds) clearSessionRendererState(id);
      await refreshSessions();
      toastApi.success(copy.deletedTitle(name));
    });
  }

  return {
    flagSession,
    archiveSession,
    unarchiveSession,
    renameSession,
    deleteSession,
  };
}
