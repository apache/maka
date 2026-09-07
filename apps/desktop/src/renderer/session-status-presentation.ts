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
import type { ModelRetryDecision } from '@maka/core/model-failure';
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

export function describeTurnErrorClass(errorClass: string | undefined, locale: UiLocale): string {
  const copy = getDesktopConversationCopy(locale).turnError;
  if (!errorClass) return copy.unknown;
  const reasonDescription = describeSessionErrorReason(errorClass, locale);
  if (reasonDescription) return reasonDescription;
  switch (errorClass.toLowerCase()) {
    // Before #3758, transport failures could persist their raw code as the class.
    case 'econnreset': case 'econnrefused': case 'econnaborted': return copy.network;
    case SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS: return copy.sandboxBoundaryClosed;
    case 'server_error': case 'providerunavailable': return copy.provider;
    case 'contextlength': return copy.contextOverflow;
    case 'providerbilling': return copy.providerBilling;
    case 'providercapacity': return copy.providerCapacity;
    case 'ratelimit': return copy.rateLimit;
    case 'requestrejected': return copy.requestRejected;
    case 'tool_step_cap_reached': return copy.stepCap;
    case 'tool_failed': return copy.tool;
    case 'permission_required': return copy.permission;
    case 'app_restarted': return copy.restarted;
    default: return copy.unknown;
  }
}

/**
 * How loud a failed turn should look. `warning` is for the outcomes where the
 * work itself survived and the session just needs another nudge — the app
 * restarted mid-turn, the step cap stopped it, a permission prompt outlived
 * its turn. Everything else is an `error`: the user has to fix, pay, wait, or
 * inspect something before the next attempt can differ from this one.
 *
 * The two tiers exist because a single `error` red made "restarted, press
 * continue" look as severe as "billing is blocked". Matches how the rest of
 * the app grades its Banners (`tone === 'destructive' ? 'error' : 'warning'`).
 */
export type FailedTurnSeverity = 'error' | 'warning';

export function deriveFailedTurnSeverity(errorClass: string | undefined): FailedTurnSeverity {
  const lower = errorClass?.toLowerCase() ?? '';
  if (lower === SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS) return 'warning';
  if (lower === 'app_restarted') return 'warning';
  if (lower === 'tool_step_cap_reached') return 'warning';
  if (lower === 'permission_required' || lower.includes('permission')) return 'warning';
  return 'error';
}

export interface FailedTurnExecutionState {
  retry?: ModelRetryDecision;
  toolActivityCount: number;
  erroredToolCount: number;
}

/**
 * What this turn already did before it failed, when that changes what sending
 * the next message costs. A tool that ran may have had side effects the retry
 * would repeat, so the user should read its result before deciding.
 *
 * This is a SECOND sentence, not a replacement for `describeTurnErrorClass()`.
 * The retired `deriveFailedTurnRecovery()` ranked the two against each other
 * and let the tool branch win, so `auth` plus one errored tool advised
 * "inspect the tool result" and dropped "sign in again" — the only step that
 * could actually change the outcome. Both facts are true at once and the
 * banner has a slot for each (`title` / `description`), so neither has to
 * lose. Without a recorded retry decision or tool activity, there is no
 * supplementary guidance; loading older answer text must not change it.
 */
export function describeFailedTurnExecutionState(
  state: FailedTurnExecutionState,
  locale: UiLocale,
): string | undefined {
  const turnCopy = getDesktopConversationCopy(locale).turnError;
  if (state.retry?.decision === 'exhausted') return turnCopy.retryExhausted;
  if (state.retry?.decision === 'declined') return turnCopy.retryDeclined[state.retry.because];
  const copy = turnCopy.executionState;
  if (state.erroredToolCount > 0) return copy.erroredTool;
  if (state.toolActivityCount > 0) return copy.toolRan;
  return undefined;
}
