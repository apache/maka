import type { SessionStartMode } from '@maka/core/explore-agent';
import type { UiLocale } from '@maka/core/ui-locale';
import type { NavSelection } from '@maka/ui';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  isNoRealConnectionError,
  noRealConnectionReasonFromError,
  noRealConnectionSetupDescription,
} from './model-connection-errors.js';
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
};

export interface AppShellSessionStartActions {
  /**
   * Open an empty session in a non-default mode (#1433). Text and
   * Skills belong to the Composer, which creates its own session on
   * first send; this is for entry points that pick the mode before any
   * text exists, such as the command palette's Deep Research.
   */
  startModeSession(mode: SessionStartMode): Promise<boolean>;
}

export function createAppShellSessionStartActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  captureComposerImportOwner: () => ComposerImportOwner;
  composerRef: RefBox<ComposerFocusHandle | null>;
  isShellSurfaceOwnerActive: (owner: ComposerImportOwner) => boolean;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  newChatProjectId: string | null | undefined;
  sessionStartPendingRef: RefBox<boolean>;
  refreshOnboarding: () => void;
  refreshSessions: () => Promise<unknown>;
  /**
   * The shell's one handler for "no usable model connection" (app-shell.tsx),
   * shared with the send path and the session-event stream. It carries the
   * 打开模型设置 action, which is the only thing that resolves this state.
   */
  showModelSetupToast: (description: string, reason?: string) => void;
  toastApi: ToastApi;
}): AppShellSessionStartActions {
  const {
    uiLocale,
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    newChatProjectId,
    sessionStartPendingRef,
    refreshOnboarding,
    refreshSessions,
    showModelSetupToast,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).chatActions;

  async function startModeSession(mode: SessionStartMode): Promise<boolean> {
    if (sessionStartPendingRef.current) return false;
    const owner = captureComposerImportOwner();
    sessionStartPendingRef.current = true;
    try {
      // #1433: the one session-creation channel. Main derives the
      // permission boundary, name and labels from `mode`.
      const session = await window.maka.sessions.create({
        mode,
        ...(newChatProjectId !== undefined ? { projectId: newChatProjectId } : {}),
      });
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
      // `sessions:create` rejects rather than returning a reason code, so the
      // two cases the old `quickChat:start` union spelled out are recovered
      // here from the errors main actually throws — not from "everything that
      // is not the other one":
      //
      //   workspace_unavailable → `SESSION_WORKSPACE_UNAVAILABLE:` (project-context-root.ts)
      //   setup_required        → `NO_REAL_CONNECTION:<reason>:`   (chat-readiness.ts)
      //
      // Anything else is a genuine failure (storage, disk, a bug) and must
      // not be silently relabelled as "your setup is incomplete".
      if (isSessionWorkspaceUnavailableError(error)) {
        if (isShellSurfaceOwnerActive(owner)) {
          showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
        }
        return false;
      }
      if (isNoRealConnectionError(error)) {
        // Refresh the snapshot so the first-run hero is accurate, then say
        // what is missing. The hero alone is not an answer: it only takes the
        // chat surface over while `sessions.length === 0 && !onboardingSettled`
        // (app-shell.tsx), and onboarding-service backfills that milestone for
        // anyone who already has a session — so for every existing user the
        // refresh alone renders nothing and the command appears to do nothing.
        // This is the same error class the send path handles, so it gets the
        // same toast rather than a second answer to one question.
        //
        // The refresh is global and silent, so it runs either way. The toast
        // is not: `showModelSetupToast` ends in `openSettingsSection('models')`
        // (app-shell.tsx), so it NAVIGATES. Gate it exactly as the sibling
        // branches gate theirs — an await that resolves after the user moved
        // on must not pull them back out of wherever they went.
        refreshOnboarding();
        if (isShellSurfaceOwnerActive(owner)) {
          const reason = noRealConnectionReasonFromError(error);
          showModelSetupToast(noRealConnectionSetupDescription(reason, uiLocale), reason);
        }
        return false;
      }
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

  return { startModeSession };
}
