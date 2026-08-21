import { useRef, useState } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { useAppShellSessionUiState } from './app-shell-session-ui-state';
import { useAppShellSessionList } from './use-app-shell-session-list';
import { createBootstrapSelectionLease } from './bootstrap-selection-lease';
import {
  clearNewTaskReloadIntent,
  hasNewTaskReloadIntent,
  markNewTaskReloadIntent,
} from './new-task-reload-intent';
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function useAppShellSessionWorkspace(toastApi: ToastApi) {
  const [activeId, setActiveIdState] = useState<string | undefined>();
  const activeIdRef = useRef<string | undefined>(undefined);
  const sessionUi = useAppShellSessionUiState();
  const sessionList = useAppShellSessionList(toastApi, {
    activeIdRef,
    liveTurnBySessionRef: sessionUi.liveTurnBySessionRef,
    clearTurnTransientStateIfCurrent: sessionUi.clearTurnTransientStateIfCurrent,
  });
  const selectionRevisionRef = useRef(0);
  const bootstrapSelectionLeaseRef = useRef<ReturnType<typeof createBootstrapSelectionLease> | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const transcriptRangeRef = useRef<DesktopTranscriptRangeController | undefined>(undefined);
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
    if (hasNewTaskReloadIntent()) bootstrapSelectionLeaseRef.current.release();
  }

  function startNewSession(): void {
    markNewTaskReloadIntent();
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
    bootstrapSelectionLease: bootstrapSelectionLeaseRef.current,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    messages,
    setMessages,
    transcriptRangeRef,
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
  };
}
