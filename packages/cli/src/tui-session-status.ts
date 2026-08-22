import type { SessionSummary } from '@maka/core/session';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

interface TuiSessionStatusCopy {
  readonly running: string;
  readonly waitingForUser: string;
  readonly permissionRequired: string;
  readonly connectionRequired: string;
  readonly signInRequired: string;
  readonly stopped: string;
}

const TUI_SESSION_STATUS_COPY = {
  zh: {
    running: '进行中',
    waitingForUser: '等你确认',
    permissionRequired: '需要权限',
    connectionRequired: '需要连接',
    signInRequired: '需要重新登录',
    stopped: '已中止',
  },
  en: {
    running: 'running',
    waitingForUser: 'waiting for you',
    permissionRequired: 'needs permission',
    connectionRequired: 'needs connection',
    signInRequired: 'needs sign-in',
    stopped: 'stopped',
  },
} satisfies UiCatalog<TuiSessionStatusCopy>;

/**
 * Present the runtime Session state as compact picker copy.
 *
 * Persisted `running` is only credible when the Runtime Host also reports a
 * live Turn. Non-actionable blocked reasons remain ordinary resumable rows,
 * matching Desktop's display projection rather than exposing bookkeeping
 * noise as a broken Session.
 */
export function sessionStatusBadge(
  session: Pick<SessionSummary, 'status' | 'blockedReason' | 'runningTurnIds'>,
  locale: UiLocale,
): string | undefined {
  const copy = TUI_SESSION_STATUS_COPY[locale];
  switch (session.status) {
    case 'active':
      return undefined;
    case 'running':
      return session.runningTurnIds?.length ? copy.running : undefined;
    case 'waiting_for_user':
      return session.blockedReason === 'permission_required'
        ? copy.permissionRequired
        : copy.waitingForUser;
    case 'blocked':
      switch (session.blockedReason) {
        case 'NO_REAL_CONNECTION':
          return copy.connectionRequired;
        case 'auth':
          return copy.signInRequired;
        case 'permission_required':
          return copy.permissionRequired;
        case 'tool_failed':
        case 'unknown':
        case undefined:
          return undefined;
      }
    case 'aborted':
      return copy.stopped;
  }
}
