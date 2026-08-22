/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Renderer-side presentation rules that only Desktop has: which blocked reasons
 * are worth acting on, and what to offer after a turn fails.
 *
 * Separated from the React component layer so the rules can be unit-tested
 * without a DOM, mirroring the `session-health-notice.ts` pattern.
 *
 * Turning a `SessionStatus` into a label and a dot, and a `SessionBlockedReason`
 * into copy, is NOT here — both live in `@maka/ui`'s file of the same name,
 * which is also where the contract that a UI label never shows a raw enum
 * identifier is stated and enforced. This file used to re-export those and
 * document a tone matrix "consumed by both the SessionStatusIcon and the
 * chat-header status badge", naming two consumers that do not exist; the tone
 * layer and the re-exports are gone (#2984).
 */

import { SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS } from '@maka/core/sandbox-boundary';
import type { SessionBlockedReason, SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { describeSessionErrorReason } from './session-error-presentation.js';

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
 * Normalize a SessionSummary as it enters renderer state. Authoritative
 * known-empty live state clears a persisted `running` value that may have
 * survived a crash, while an omitted live state keeps the legacy fallback.
 * Non-actionable blocked sessions read as ordinary resumable sessions
 * (`active`), so every display consumer agrees on the same projection.
 */
export function normalizeSessionSummaryForDisplay<T extends SessionSummary>(session: T): T {
  const liveNormalized: T =
    session.status === 'running' && session.runningTurnIds?.length === 0
      ? ({ ...session, status: 'active' as const } as T)
      : session;
  if (
    liveNormalized.status !== 'blocked' ||
    isActionableBlocked(liveNormalized.blockedReason)
  ) {
    return liveNormalized;
  }
  const { blockedReason: _blockedReason, ...rest } = liveNormalized;
  void _blockedReason;
  return { ...rest, status: 'active' } as T;
}

/**
 * Mutation responses describe persisted metadata and legitimately omit live
 * run state. Preserve the last authoritative state in that case; an explicit
 * empty or non-empty array from a catalog read always replaces it.
 */
export function mergeSessionSummaryForDisplay<T extends SessionSummary>(
  current: T | undefined,
  incoming: T,
): T {
  const merged: T =
    incoming.runningTurnIds === undefined && current?.runningTurnIds !== undefined
      ? ({ ...incoming, runningTurnIds: [...current.runningTurnIds] } as T)
      : incoming;
  return normalizeSessionSummaryForDisplay(merged);
}

/**
 * Apply the same live-state preservation rule at the shared list state
 * boundary, so every metadata mutation path gets it even when a refresh fails.
 */
export function mergeSessionSummaryListForDisplay<T extends SessionSummary>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const currentById = new Map(current.map((session) => [session.id, session]));
  return incoming.map((session) =>
    mergeSessionSummaryForDisplay(currentById.get(session.id), session),
  );
}

/**
 * Generalized Chinese phrasing for a failed turn's `errorClass`
 * Mirrors `describeBlockedReason()` in `@maka/ui`, under the same rule: a UI
 * label must never display the raw enum identifier.
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
  if (lower === 'context_overflow') {
    return { action: 'continue', label: copy.contextOverflow };
  }
  return { action: 'retry', label: copy.retry };
}
