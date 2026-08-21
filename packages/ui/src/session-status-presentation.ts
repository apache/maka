import type { SessionBlockedReason, SessionStatus } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { dotForStatus, type StatusSemantic } from './status-vocabulary.js';
import { getConversationCopy } from './conversation-copy.js';

export interface SessionStatusPresentation {
  label: string;
  variant?: StatusDotVariant;
}

/**
 * What a status MEANS. The colour is not decided here.
 *
 * There used to be a `SessionStatusTone` in between — seven names of our own
 * that the only caller mapped onto Astryx's five. Deleting that layer was
 * right; replacing it with a private `SessionStatus -> StatusDotVariant` table
 * was not, because `status-vocabulary.ts` already owns the one place a status
 * word becomes a colour, and a second table there means the rail and Settings
 * can disagree about the same fact. They did: a task waiting on a permission
 * prompt drew `error` here while the permission centre drew `attention` for the
 * identical condition.
 *
 * So the session enum maps to `StatusSemantic` and `dotForStatus` picks the
 * colour, which also settles what `waiting_for_user` and `blocked` share.
 * They are both `attention` — both are "waiting on a person", which is what
 * that semantic is defined as. Giving `blocked` `error` to tell the two apart
 * was using colour for a distinction colour cannot carry; `error` is reserved
 * for "broken now". The two are told apart by their label and, for `blocked`,
 * by `describeBlockedReason` in the tooltip.
 *
 * `undefined` means no dot: `active` is the resting state and the rail does not
 * mark a task for being ordinary. Everything else gets one, including
 * `aborted` — it was `muted` before this change and `muted` resolved to a real
 * `neutral` dot, so dropping it to `undefined` was a behaviour change, not a
 * consequence of collapsing the layer. Without a dot it fell through to the
 * unread branch and an aborted task with unread text drew the same accent dot
 * as one that is running.
 */
const STATUS_SEMANTIC: Record<SessionStatus, StatusSemantic | undefined> = {
  active: undefined,
  running: 'active',
  waiting_for_user: 'attention',
  blocked: 'attention',
  aborted: 'neutral',
};

export function presentSessionStatus(
  status: SessionStatus,
  locale: UiLocale = 'zh',
): SessionStatusPresentation {
  const semantic = STATUS_SEMANTIC[status];
  return {
    label: getConversationCopy(locale).sessions.status[status],
    ...(semantic ? { variant: dotForStatus(semantic) } : {}),
  };
}

/**
 * The canonical translation of a blocked reason, and the contract that a UI
 * label never exposes the raw `SessionBlockedReason` identifier (@kenji review).
 * A new reason must extend the core enum AND the copy matrix together, or it
 * reads as `unknown` — which is the intended failure, not a silent leak of the
 * enum string into the interface.
 */
export function describeBlockedReason(
  reason: SessionBlockedReason | undefined,
  locale: UiLocale = 'zh',
): string {
  const copy = getConversationCopy(locale).sessions.blockedReason;
  return reason ? copy[reason] : copy.unknown;
}
