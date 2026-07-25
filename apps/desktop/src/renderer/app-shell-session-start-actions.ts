import type { QuickChatMode, UiLocale } from '@maka/core';
import { saveGlobalInputHistoryEntry } from '@maka/ui';
import type { NavSelection } from '@maka/ui';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
};

type RefBox<T> = { current: T };

type ComposerFocusHandle = {
  focus(): void;
};

type ToastApi = {
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
};

export interface AppShellSessionStartActions {
  /**
   * Open an empty session in a non-default mode (#1433). Text and
   * Skills belong to the Composer, which creates its own session on
   * first send; this is for entry points that pick the mode before any
   * text exists, such as the command palette's Deep Research.
   */
  startModeSession(mode: QuickChatMode): Promise<boolean>;
  /** Start a new expert-team session (from the composer "+" menu). */
  handleExpertTeamStart(teamId: string, prompt?: string): Promise<boolean>;
}

export function createAppShellSessionStartActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  captureComposerImportOwner: () => ComposerImportOwner;
  composerRef: RefBox<ComposerFocusHandle | null>;
  isShellSurfaceOwnerActive: (owner: ComposerImportOwner) => boolean;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  sessionStartPendingRef: RefBox<boolean>;
  refreshOnboarding: () => void;
  refreshSessions: () => Promise<unknown>;
  toastApi: ToastApi;
}): AppShellSessionStartActions {
  const {
    uiLocale,
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    sessionStartPendingRef,
    refreshOnboarding,
    refreshSessions,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).chatActions;

  async function startModeSession(mode: QuickChatMode): Promise<boolean> {
    if (sessionStartPendingRef.current) return false;
    const owner = captureComposerImportOwner();
    sessionStartPendingRef.current = true;
    try {
      // #1433: the one session-creation channel. Main derives the
      // permission boundary, name and labels from `mode`.
      const session = await window.maka.sessions.create({ mode });
      if (isShellSurfaceOwnerActive(owner)) {
        openSessionInChat(session.id);
      }
      await refreshSessions();
      if (activeIdRef.current === session.id) {
        composerRef.current?.focus();
      }
      // Best-effort: mark onboarding completed. Failure must not
      // turn a successful chat into a failure — backfill covers it.
      void window.maka.onboarding.setMilestone('initial_onboarding', 'completed').catch(() => {});
      return true;
    } catch (error) {
      // `sessions:create` rejects rather than returning a reason code, so
      // the two cases the old `quickChat:start` union spelled out are
      // recovered here: an unusable workspace gets its own toast, and any
      // readiness failure re-pulls the onboarding snapshot so the hero can
      // state what is missing.
      if (isSessionWorkspaceUnavailableError(error)) {
        if (isShellSurfaceOwnerActive(owner)) {
          showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
        }
        return false;
      }
      refreshOnboarding();
      if (isShellSurfaceOwnerActive(owner)) {
        toastApi.error(
          copy.sessionStartFailedTitle,
          localizedShellErrorMessage(error, copy.sessionStartFailedFallback, uiLocale),
        );
      }
      return false;
    } finally {
      sessionStartPendingRef.current = false;
    }
  }

  async function handleExpertTeamStart(teamId: string, prompt?: string): Promise<boolean> {
    if (sessionStartPendingRef.current) return false;
    const owner = captureComposerImportOwner();
    sessionStartPendingRef.current = true;
    try {
      const result = await window.maka.expertTeam.start({
        teamId,
        prompt: prompt ?? '',
      });
      if (result.ok) {
        if (prompt && prompt.trim()) saveGlobalInputHistoryEntry(prompt);
        if (isShellSurfaceOwnerActive(owner)) {
          openSessionInChat(result.sessionId);
        }
        await refreshSessions();
        if (activeIdRef.current === result.sessionId) {
          composerRef.current?.focus();
        }
        void window.maka.onboarding.setMilestone('initial_onboarding', 'completed').catch(() => {});
        return true;
      } else if (result.reason === 'setup_required') {
        refreshOnboarding();
        return false;
      } else if (result.reason === 'workspace_unavailable') {
        if (isShellSurfaceOwnerActive(owner)) {
          showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
        }
        return false;
      } else {
        await refreshSessions();
        if (isShellSurfaceOwnerActive(owner)) {
          const description =
            result.reason === 'unknown_team'
              ? copy.expertTeamNotFound
              : uiLocale === 'zh'
                ? result.message
                : copy.expertTeamFailedFallback;
          toastApi.error(copy.expertTeamFailedTitle, description);
        }
        return false;
      }
    } catch (error) {
      if (isShellSurfaceOwnerActive(owner)) {
        toastApi.error(
          copy.expertTeamFailedTitle,
          localizedShellErrorMessage(error, copy.expertTeamFailedFallback, uiLocale),
        );
      }
      return false;
    } finally {
      sessionStartPendingRef.current = false;
    }
  }

  return { startModeSession, handleExpertTeamStart };
}
