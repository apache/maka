/**
 * Frame-level titlebar chrome planning.
 *
 * The titlebar strip is always painted: content columns bleed under it, and
 * the OS drag region has to stay alive. Interactive controls, however, belong
 * only to the surface currently in front of the user.
 *
 * Settings is a full-window surface (stacked under the titlebar on purpose so
 * window drag still works). It owns its own navigation column. Shell
 * session/workspace controls that still reflect the session *under* Settings
 * are wrong affordances — hide them rather than special-casing each button.
 */

/** Module surfaces that own the whole column and have no session workbar. */
export const TITLEBAR_MODULES_WITHOUT_WORKBAR = new Set([
  'skills',
  'cron',
  'daily-review',
]);

export type TitlebarChromePlan = {
  /** Conversation search + session sidebar toggle (left rail). */
  readonly showShellRail: boolean;
  /** Active session name / project breadcrumb (center). */
  readonly showSessionIdentity: boolean;
  /** Workbar launcher + workbar column toggle (right). */
  readonly showWorkbarActions: boolean;
};

export type TitlebarChromeInput = {
  readonly settingsOpen: boolean;
  /** Current module key used for hub surfaces (skills, cron, daily-review, …). */
  readonly agentsView: string;
  readonly onSessionsSurface: boolean;
  /**
   * Session identity can appear on a short-lived placeholder record while the
   * real summary loads (`activeSessionForView`).
   */
  readonly hasSessionIdentity: boolean;
  /** Workbar needs a real active session id, not only a view placeholder. */
  readonly hasWorkbarSession: boolean;
};

export function planTitlebarChrome(input: TitlebarChromeInput): TitlebarChromePlan {
  // Settings is the primary surface: keep drag chrome, drop shell tools.
  if (input.settingsOpen) {
    return {
      showShellRail: false,
      showSessionIdentity: false,
      showWorkbarActions: false,
    };
  }

  return {
    showShellRail: true,
    showSessionIdentity: input.onSessionsSurface && input.hasSessionIdentity,
    showWorkbarActions:
      input.onSessionsSurface &&
      input.hasWorkbarSession &&
      !TITLEBAR_MODULES_WITHOUT_WORKBAR.has(input.agentsView),
  };
}
