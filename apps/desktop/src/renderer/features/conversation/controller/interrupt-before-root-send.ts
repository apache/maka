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

import type { UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import type { StopOutcome } from './stop-action.js';

export type LiveTurnAtSubmit = {
  turnId: string;
  terminal?: boolean;
};

/**
 * Whether a plain-Enter root send must interrupt first.
 *
 * `liveTurns` is the Session's live-turn buffer (active and retained terminal
 * projections). Any non-terminal entry means a live turn is still in flight.
 * Running Host turn IDs that are not already accounted for by retained
 * terminal projections also count as active — the arm can exist before React
 * publishes streaming state, and a second turn can race a settled first.
 */
export function hasActiveTurnAtSubmit(input: {
  liveTurns?: readonly LiveTurnAtSubmit[];
  runningTurnIds?: readonly string[];
}): boolean {
  if (input.liveTurns?.some((turn) => turn.terminal !== true) === true) return true;
  const retainedTerminalIds = new Set(
    (input.liveTurns ?? [])
      .filter((turn) => turn.terminal === true)
      .map((turn) => turn.turnId),
  );
  return input.runningTurnIds?.some((turnId) => !retainedTerminalIds.has(turnId)) === true;
}

/**
 * After plain-Enter interrupts a live turn, the root send must still target the
 * Session that was submitted. The Host stop awaits terminal settlement, so the
 * user can navigate away while that await is open — refuse the send rather than
 * delivering the draft to whichever Session is active afterward (#4083 review).
 */
export function shouldContinueRootSendAfterInterrupt(input: {
  submittingSessionId: string;
  activeSessionId: string | undefined;
}): boolean {
  return input.activeSessionId === input.submittingSessionId;
}

/**
 * Pin stop to the live turn that armed interrupt, so a queued turn that starts
 * during settlement is not cancelled in its place (#4083 review).
 */
export function resolveExpectedTurnIdForInterrupt(input: {
  liveTurns?: readonly LiveTurnAtSubmit[];
  runningTurnIds?: readonly string[];
}): string | undefined {
  const activeLive = input.liveTurns?.find((turn) => turn.terminal !== true);
  if (activeLive) return activeLive.turnId;
  const retainedTerminalIds = new Set(
    (input.liveTurns ?? [])
      .filter((turn) => turn.terminal === true)
      .map((turn) => turn.turnId),
  );
  return input.runningTurnIds?.find((turnId) => !retainedTerminalIds.has(turnId));
}

/** Interrupt a live turn before admitting a plain-Enter root send (#4083). */
export async function interruptBeforeRootSend(input: {
  sessionId: string | undefined;
  slashCommand: unknown;
  liveTurns?: readonly LiveTurnAtSubmit[];
  runningTurnIds?: readonly string[];
  /**
   * Re-read after a stop that found nothing to interrupt. When the pinned turn
   * finished on its own the root send proceeds; when another turn is running,
   * refuse with a toast instead of dropping Enter silently (#4083).
   */
  refreshActiveTurn?: () => {
    liveTurns?: readonly LiveTurnAtSubmit[];
    runningTurnIds?: readonly string[];
  };
  activeSessionId: () => string | undefined;
  stop: (sessionId?: string, expectedTurnId?: string) => Promise<StopOutcome>;
  toastApi?: {
    error(title: string, description?: string): void;
  };
  uiLocale?: UiLocale;
}): Promise<boolean> {
  if (!input.sessionId || input.slashCommand) return true;
  if (!hasActiveTurnAtSubmit({ liveTurns: input.liveTurns, runningTurnIds: input.runningTurnIds })) {
    return true;
  }
  const expectedTurnId = resolveExpectedTurnIdForInterrupt({
    liveTurns: input.liveTurns,
    runningTurnIds: input.runningTurnIds,
  });
  const reportNotSent = (description: 'blocked' | 'stopping') => {
    if (!input.toastApi || !input.uiLocale) return;
    const copy = getDesktopConversationCopy(input.uiLocale).actions;
    input.toastApi.error(
      copy.interruptSendBlockedTitle,
      description === 'blocked' ? copy.interruptSendBlockedDescription : copy.interruptSendStoppingDescription,
    );
  };
  const outcome = await input.stop(input.sessionId, expectedTurnId);
  // The stop action already reported its own failure.
  if (outcome === 'failed') return false;
  if (outcome === 'busy') {
    reportNotSent('stopping');
    return false;
  }
  if (outcome === 'not_running') {
    const refreshed = input.refreshActiveTurn?.() ?? {
      liveTurns: input.liveTurns,
      runningTurnIds: input.runningTurnIds,
    };
    // The pinned turn may have finished on its own; another live turn blocks the send.
    if (hasActiveTurnAtSubmit(refreshed)) {
      reportNotSent('blocked');
      return false;
    }
  }
  if (
    !shouldContinueRootSendAfterInterrupt({
      submittingSessionId: input.sessionId,
      activeSessionId: input.activeSessionId(),
    })
  ) {
    // User navigated away during the awaited stop — keep the draft and say so.
    if (input.toastApi && input.uiLocale) {
      const copy = getDesktopConversationCopy(input.uiLocale).actions;
      input.toastApi.error(copy.interruptSendAbandonedTitle, copy.interruptSendAbandonedDescription);
    }
    return false;
  }
  return true;
}
