/**
 * Pure presentation helpers for SessionStatus + SessionBlockedReason
 * used by the sidebar and chat header.
 *
 * Separated from the React component layer so the copy + tone mapping
 * can be unit-tested without a DOM, mirroring `session-health-notice.ts`
 * pattern.
 *
 * Two contracts enforced here:
 *
 *  1. **Generalized blocked-reason copy** (@kenji review): UI labels
 *     never expose the raw `SessionBlockedReason` enum string. The
 *     mapping below is the canonical translation. New blocked reasons
 *     must extend the core enum AND this matrix together, or the
 *     `unknown` fallback applies.
 *
 *  2. **Status tone matrix**: each SessionStatus has a single visual
 *     tone (`accent / warning / destructive / info / success / muted`)
 *     consumed by both the SessionStatusIcon and the chat-header
 *     status badge. Aligns with the existing session-health-notice tone
 *     vocabulary.
 */

import { SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS } from '@maka/core/sandbox-boundary';
import type { SessionBlockedReason, SessionStatus, SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  describeBlockedReason,
  presentSessionStatus,
  type SessionStatusPresentation,
  type SessionStatusTone,
} from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { describeSessionErrorReason } from './session-error-presentation.js';
export { presentSessionStatus } from '@maka/ui';
export { describeBlockedReason } from '@maka/ui';

/**
 * Session-level "blocked" is only worth interrupting the user when
 * they can ACT on it: configure a connection, re-login, or confirm a
 * permission. `tool_failed` / `unknown` mean "the last run's bookkeeping
 * didn't close cleanly" — the conversation itself is intact and
 * retryable, and the failure detail already surfaces on the failed
 * turn inside the chat. Runtime keeps writing the strict status (the
 * #397/#410 terminal-fact invariant is untouched); this is a
 * display-layer distinction only.
 */
const ACTIONABLE_BLOCKED_REASONS: ReadonlySet<SessionBlockedReason> = new Set([
  'NO_REAL_CONNECTION',
  'auth',
  'permission_required',
]);

export function isActionableBlocked(reason: SessionBlockedReason | undefined): boolean {
  return reason !== undefined && ACTIONABLE_BLOCKED_REASONS.has(reason);
}

/**
 * Normalize a SessionSummary as it enters renderer state: non-actionable
 * blocked sessions read as ordinary resumable sessions (`active`), so the
 * sidebar grouping, row icon, and chat-header badge all agree without
 * each consumer re-implementing the rule. Everything else passes through
 * unchanged.
 */
export function normalizeSessionSummaryForDisplay(session: SessionSummary): SessionSummary {
  if (session.status !== 'blocked' || isActionableBlocked(session.blockedReason)) return session;
  const { blockedReason: _blockedReason, ...rest } = session;
  void _blockedReason;
  return { ...rest, status: 'active' };
}

/**
 * Generalized Chinese phrasing for a failed turn's `errorClass`
 * Mirrors `describeBlockedReason()`; UI must never display the raw enum identifier.
 *
 * Recognized classes are written by the runtime via `classifyError()`,
 * `classifyHttpStatus()`, and `event.reason` / `event.code`. The set is
 * open-ended (any string the runtime emits is possible), so we map a
 * known prefix-list and fall back to "未知错误" for anything else.
 *
 * Importantly, this helper accepts strings — not a typed enum — so
 * future runtime additions (e.g. a new tool failure class) don't break
 * the UI; they just fall through to the catch-all until the mapping
 * is extended.
 */
export function describeTurnErrorClass(errorClass: string | undefined, locale: UiLocale = 'zh'): string {
  const copy = getDesktopConversationCopy(locale).turnError;
  if (!errorClass) return copy.unknown;
  const reasonDescription = describeSessionErrorReason(errorClass, locale);
  if (reasonDescription) return reasonDescription;
  const lower = errorClass.toLowerCase();
  // Checked before the generic prefix list: a boundary closure is a specific
  // restart outcome the user must be able to tell apart from a bare restart
  // (#1612), and it must never fall through to the "permission"/"tool" catch-alls.
  if (lower === SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS) return copy.sandboxBoundaryClosed;
  if (lower === 'timeout' || lower.includes('timeout')) return copy.timeout;
  if (lower === 'auth' || lower.includes('auth') || lower === '401' || lower === '403') return copy.auth;
  if (lower === 'rate_limit' || lower.includes('rate')) return copy.rateLimit;
  if (lower === 'network' || lower.includes('network') || lower.includes('fetch') || lower.includes('econn')) {
    return copy.network;
  }
  if (lower === 'provider_unavailable' || /\b5\d\d\b/.test(lower)) return copy.provider;
  if (lower === 'tool_step_cap_reached') return copy.stepCap;
  if (lower === 'tool_failed' || lower.includes('tool')) return copy.tool;
  if (lower === 'permission_required' || lower.includes('permission')) return copy.permission;
  if (lower === 'app_restarted') return copy.restarted;
  return copy.unknown;
}

export type FailedTurnRecoveryAction = 'retry' | 'continue' | 'inspect_tool' | 'check_connection';

export interface FailedTurnRecoveryPresentation {
  action: FailedTurnRecoveryAction;
  label: string;
}

export interface FailedTurnRecoveryInput {
  errorClass?: string;
  partialOutputRetained: boolean;
  toolActivityCount: number;
  erroredToolCount: number;
}

/**
 * User-facing recovery guidance for a failed turn. This intentionally
 * separates "what failed" (`describeTurnErrorClass`) from "what should I do
 * next", following the same incident-summary discipline as the runtime logs:
 * do not ask the user to blindly retry if a tool already ran or partial output
 * was retained.
 */
export function deriveFailedTurnRecovery(input: FailedTurnRecoveryInput, locale: UiLocale = 'zh'): FailedTurnRecoveryPresentation {
  const copy = getDesktopConversationCopy(locale).turnError.recovery;
  const lower = input.errorClass?.toLowerCase() ?? '';
  if (lower === SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS) {
    // Not `continue`: the request was denied and its backend generation is
    // gone, so there is nothing to resume into — retrying the turn is the
    // only path that lets the agent ask again.
    return { action: 'retry', label: copy.sandboxBoundaryClosed };
  }
  if (lower === 'app_restarted') {
    return { action: 'continue', label: copy.safeResume };
  }
  if (lower === 'tool_step_cap_reached') {
    return { action: 'continue', label: copy.stepCap };
  }
  if (input.erroredToolCount > 0 || lower === 'tool_failed' || lower.includes('tool')) {
    return { action: 'inspect_tool', label: copy.toolError };
  }
  if (lower === 'provider_billing' || lower === 'auth' || lower.includes('auth') || lower === '401' || lower === '403') {
    return { action: 'check_connection', label: copy.connection };
  }
  if (input.partialOutputRetained) {
    return { action: 'continue', label: copy.partial };
  }
  if (input.toolActivityCount > 0) {
    return { action: 'inspect_tool', label: copy.toolRecord };
  }
  return { action: 'retry', label: copy.retry };
}
