import { useRef, useState } from 'react';
import type { StoredMessage } from '@maka/core';
import { useAppShellSessionUiState } from './app-shell-session-ui-state';
import { useAppShellSessionList } from './use-app-shell-session-list';
import { createBootstrapSelectionLease } from './bootstrap-selection-lease';
import {
  clearNewTaskReloadIntent,
  markNewTaskReloadIntent,
  readNewTaskReloadIntent,
  sessionCreatedSinceNewTaskIntent,
} from './new-task-reload-intent';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function useAppShellSessionWorkspace(toastApi: ToastApi) {
  const sessionList = useAppShellSessionList(toastApi);
  const sessionUi = useAppShellSessionUiState();
  const [activeId, setActiveIdState] = useState<string | undefined>();
  const activeIdRef = useRef<string | undefined>(undefined);
  const selectionRevisionRef = useRef(0);
  const bootstrapSelectionLeaseRef = useRef<ReturnType<typeof createBootstrapSelectionLease> | null>(null);
  const reloadAwareSelectionLeaseRef = useRef<ReturnType<typeof createBootstrapSelectionLease> | null>(null);
  const newTaskReloadIntentRef = useRef(readNewTaskReloadIntent());
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [messageLoadPending, setMessageLoadPending] = useState(false);
  const messageRetryPendingRef = useRef<Set<string>>(new Set());
  const stopPendingRef = useRef<Set<string>>(new Set());

  function setActiveId(next: string | undefined): void {
    selectionRevisionRef.current += 1;
    // Clear here, not in the read effect: a layout-effect clear would wipe an
    // optimistic first message before the first paint.
    if (!next) {
      setMessageLoadPending(false);
    } else if (next !== activeIdRef.current) {
      setMessages([]);
      setMessageLoadPending(true);
    }
    activeIdRef.current = next;
    if (next) clearNewTaskReloadIntent();
    setActiveIdState(next);
  }

  if (!bootstrapSelectionLeaseRef.current) {
    bootstrapSelectionLeaseRef.current = createBootstrapSelectionLease({
      readActiveId: () => activeIdRef.current,
      readSelectionRevision: () => selectionRevisionRef.current,
      select: setActiveId,
    });
  }
  if (!reloadAwareSelectionLeaseRef.current) {
    reloadAwareSelectionLeaseRef.current = {
      reconcile(nextSessions): boolean {
        const intent = newTaskReloadIntentRef.current;
        if (!intent) return bootstrapSelectionLeaseRef.current!.reconcile(nextSessions);

        const created = sessionCreatedSinceNewTaskIntent(intent, nextSessions);
        if (!created) return false;

        // The persisted Session catalog is the authority that survives renderer
        // replacement. Once it contains a Session created after this explicit
        // new-task surface began, take the user to it and retire the lease.
        newTaskReloadIntentRef.current = undefined;
        clearNewTaskReloadIntent();
        bootstrapSelectionLeaseRef.current!.release();
        setActiveId(created.id);
        return true;
      },
      release(): void {
        // While a reload intent is unresolved, later bootstrap snapshots may be
        // the first to contain an in-flight Session creation.
        if (!newTaskReloadIntentRef.current) bootstrapSelectionLeaseRef.current!.release();
      },
    };
  }

  function startNewSession(): void {
    markNewTaskReloadIntent(sessionList.sessionsRef.current.map(({ id }) => id));
    newTaskReloadIntentRef.current = readNewTaskReloadIntent();
    setActiveId(undefined);
    setMessages([]);
  }

  function clearOwnedSessionState(sessionId: string): void {
    messageRetryPendingRef.current.delete(sessionId);
    stopPendingRef.current.delete(sessionId);
    sessionUi.clearSessionUiState(sessionId);
  }

  return {
    ...sessionList,
    activeId,
    activeIdRef,
    bootstrapSelectionLease: reloadAwareSelectionLeaseRef.current,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    messages,
    setMessages,
    messageLoadPending,
    setMessageLoadPending,
    messageRetryPendingRef,
    stopPendingRef,
    sessionUiController: sessionUi.controller,
    liveTurnBySessionRef: sessionUi.liveTurnBySessionRef,
    sessionEventHealthBySessionRef: sessionUi.sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: sessionUi.setMessageLoadErrorBySession,
    setMessageRetryPendingBySession: sessionUi.setMessageRetryPendingBySession,
    setStopPendingBySession: sessionUi.setStopPendingBySession,
    setLiveTurnBySession: sessionUi.setLiveTurnBySession,
    setShellRunUpdatesBySession: sessionUi.setShellRunUpdatesBySession,
    setInteractionBySession: sessionUi.setInteractionBySession,
    setSessionEventHealthBySession: sessionUi.setSessionEventHealthBySession,
    setPendingPermissionModeBySession: sessionUi.setPendingPermissionModeBySession,
    setPendingSessionModelBySession: sessionUi.setPendingSessionModelBySession,
    confirmLiveTurn: sessionUi.confirmLiveTurn,
    clearTurnTransientState: sessionUi.clearTurnTransientState,
  };
}
