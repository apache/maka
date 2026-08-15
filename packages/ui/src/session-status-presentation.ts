import type { SessionBlockedReason, SessionStatus } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { getConversationCopy } from './conversation-copy.js';

export interface SessionStatusPresentation {
  label: string;
  /**
   * Astryx's own dot variant, reached in one step.
   *
   * There used to be a `SessionStatusTone` in between — seven names of our own
   * that the only caller then mapped onto Astryx's five. Two of those names
   * (`info`, `muted`) had no distinct outcome at the end of the chain, and the
   * collapse is what let `waiting_for_user` and `blocked` land on the same
   * `warning`: they were different tones that stopped being different dots.
   * One table, one hop, and the collision is visible in the source.
   *
   * `undefined` means the row draws no dot at all: an idle session and an
   * archived or aborted one are not states the rail interrupts anyone about.
   */
  variant?: StatusDotVariant;
}

const STATUS_VARIANT: Record<SessionStatus, StatusDotVariant | undefined> = {
  active: undefined,
  running: 'accent',
  waiting_for_user: 'warning',
  // `error`, not `warning`: blocked means the task cannot proceed until someone
  // fixes a connection, a login, or a permission, while waiting_for_user means
  // it is holding a question for you. Sharing one colour made the rail unable to
  // say which of the two a row was in.
  blocked: 'error',
  archived: undefined,
  aborted: undefined,
};

export function presentSessionStatus(
  status: SessionStatus,
  locale: UiLocale = 'zh',
): SessionStatusPresentation {
  const variant = STATUS_VARIANT[status];
  return {
    label: getConversationCopy(locale).sessions.status[status],
    ...(variant ? { variant } : {}),
  };
}

export function describeBlockedReason(
  reason: SessionBlockedReason | undefined,
  locale: UiLocale = 'zh',
): string {
  const copy = getConversationCopy(locale).sessions.blockedReason;
  return reason ? copy[reason] : copy.unknown;
}
