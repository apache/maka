import type { SessionBlockedReason, SessionStatus } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getConversationCopy } from './conversation-copy.js';

export type SessionStatusTone = 'accent' | 'warning' | 'destructive' | 'info' | 'success' | 'muted' | 'neutral';

export interface SessionStatusPresentation {
  label: string;
  tone: SessionStatusTone;
  interactive: boolean;
}

const STATUS_META: Record<SessionStatus, Omit<SessionStatusPresentation, 'label'>> = {
  active: { tone: 'neutral', interactive: true }, running: { tone: 'accent', interactive: true }, waiting_for_user: { tone: 'warning', interactive: true }, blocked: { tone: 'warning', interactive: true }, review: { tone: 'info', interactive: true }, done: { tone: 'success', interactive: true }, archived: { tone: 'muted', interactive: false }, aborted: { tone: 'muted', interactive: false },
};

export function presentSessionStatus(status: SessionStatus, locale: UiLocale = 'zh'): SessionStatusPresentation {
  return { ...STATUS_META[status], label: getConversationCopy(locale).sessions.status[status] };
}

export function describeBlockedReason(reason: SessionBlockedReason | undefined, locale: UiLocale = 'zh'): string {
  const copy = getConversationCopy(locale).sessions.blockedReason;
  return reason ? copy[reason] : copy.unknown;
}
