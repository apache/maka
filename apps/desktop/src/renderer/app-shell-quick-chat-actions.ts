import type { QuickChatMode, UiLocale } from '@maka/core';
import { saveGlobalInputHistoryEntry } from '@maka/ui';
import type { NavSelection } from '@maka/ui';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { showSessionWorkspaceUnavailableToast } from './session-workspace-errors.js';

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

export interface AppShellQuickChatActions {
  /**
   * Open an empty session in a non-default mode (#1433). Text and
   * Skills belong to the Composer, which creates its own session on
   * first send; this is for entry points that pick the mode before any
   * text exists, such as the command palette's Deep Research.
   */
  handleQuickChatSubmit(mode?: QuickChatMode): Promise<boolean>;
  /** Start a new expert-team session (from the composer "+" menu). */
  handleExpertTeamStart(teamId: string, prompt?: string): Promise<boolean>;
}

export function createAppShellQuickChatActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  captureComposerImportOwner: () => ComposerImportOwner;
  composerRef: RefBox<ComposerFocusHandle | null>;
  isShellSurfaceOwnerActive: (owner: ComposerImportOwner) => boolean;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  quickChatPendingRef: RefBox<boolean>;
  refreshOnboarding: () => void;
  refreshSessions: () => Promise<unknown>;
  setQuickChatPending: (pending: boolean) => void;
  toastApi: ToastApi;
}): AppShellQuickChatActions {
  const {
    uiLocale,
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    quickChatPendingRef,
    refreshOnboarding,
    refreshSessions,
    setQuickChatPending,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).chatActions;

  async function handleQuickChatSubmit(mode?: QuickChatMode): Promise<boolean> {
    if (quickChatPendingRef.current) return false;
    const owner = captureComposerImportOwner();
    quickChatPendingRef.current = true;
    setQuickChatPending(true);
    try {
      const result = await window.maka.quickChat.start({ mode });
      if (result.ok) {
        if (isShellSurfaceOwnerActive(owner)) {
          openSessionInChat(result.sessionId);
        }
        await refreshSessions();
        if (activeIdRef.current === result.sessionId) {
          composerRef.current?.focus();
        }
        // Best-effort: mark onboarding completed. Failure must not
        // turn a successful chat into a failure — backfill covers it.
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
          toastApi.error(
            copy.quickChatFailedTitle,
            uiLocale === 'zh' ? result.message : copy.quickChatFailedFallback,
          );
        }
        return false;
      }
    } catch (error) {
      if (isShellSurfaceOwnerActive(owner)) {
        toastApi.error(
          copy.quickChatFailedTitle,
          localizedShellErrorMessage(error, copy.quickChatFailedFallback, uiLocale),
        );
      }
      return false;
    } finally {
      quickChatPendingRef.current = false;
      setQuickChatPending(false);
    }
  }

  async function handleExpertTeamStart(teamId: string, prompt?: string): Promise<boolean> {
    if (quickChatPendingRef.current) return false;
    const owner = captureComposerImportOwner();
    quickChatPendingRef.current = true;
    setQuickChatPending(true);
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
      quickChatPendingRef.current = false;
      setQuickChatPending(false);
    }
  }

  return { handleQuickChatSubmit, handleExpertTeamStart };
}
