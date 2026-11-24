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

import type {
  AgentSendResult,
  QuoteRef,
  Receipt,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import { sameValue } from '../../../shared/value.ts';
import { message, type UiText } from '../../../../products/maka/workbench/app/text-value.ts';

/** A failed preflight still owns an undispatched reservation, not an unknown send. */
export async function confirmAfterProjectMcp<T>(
  check: () => Promise<boolean>,
  abandon: () => Promise<void>,
  confirm: () => Promise<T>,
): Promise<{ kind: 'approval_required' } | { kind: 'confirmed'; value: T }> {
  let approved: boolean;
  try {
    approved = await check();
  } catch (reason) {
    await abandon();
    throw reason;
  }
  if (!approved) {
    await abandon();
    return { kind: 'approval_required' };
  }
  return { kind: 'confirmed', value: await confirm() };
}

export function sendReceiptFailure(
  receipt: Receipt | null | undefined,
): { detail: UiText; retryable: boolean } | null {
  if (receipt?.kind !== 'recorded') return null;
  const outcome = receipt.outcome;
  if (outcome.kind === 'not_executed')
    return { detail: message('Message was not sent.'), retryable: true };
  if (outcome.kind !== 'returned') return null;

  const result = outcome.result;
  // Retrying requires proof of non-delivery.
  if (result.kind === 'failure')
    return {
      detail: message('Send failed: {reason}', { reason: result.diagnostic }),
      retryable: false,
    };

  const value = result.value as AgentSendResult;
  if (value?.kind === 'not_your_worker')
    return {
      detail: message('Send rejected: {reason}', { reason: value.kind }),
      retryable: true,
    };
  if (value?.kind !== 'rejected') return null;

  switch (value.reason) {
    case 'turn_stopped':
      return { detail: message('Stopped before delivery. Your message is kept.'), retryable: true };
    case 'workspace_unavailable':
      return { detail: message('The workspace for this task is unavailable.'), retryable: true };
    case 'model_unavailable':
      return {
        detail: message('The selected model is unavailable. Try again or choose another model.'),
        retryable: true,
      };
    case 'original_operation_unsettled':
      return {
        detail: message(
          'Message was not sent because the previous run is unsettled. Your message is kept.',
        ),
        retryable: true,
      };
    default:
      return {
        detail: message('Send rejected: {reason}', { reason: value.reason }),
        retryable: true,
      };
  }
}

export function shouldProjectPendingSend(
  accepted: { kind: string } | null | undefined,
  context: { immediate: boolean; activeRunId: string | null; atHistoryTail: boolean },
): boolean {
  if (!accepted || !context.atHistoryTail) return false;
  if (accepted.kind === 'started') return true;
  return accepted.kind === 'queued' && context.immediate && context.activeRunId === null;
}

export function shouldHideAcceptedQueuedStatus(options: {
  failed: boolean;
  detail: UiText | undefined;
  delivery: string | undefined;
  messageId: string;
  followups: ReadonlySet<string>;
  inTranscript: (messageId: string) => boolean;
}): boolean {
  return (
    !options.failed &&
    !options.detail &&
    options.delivery !== 'unknown' &&
    (options.followups.has(options.messageId) || options.inTranscript(options.messageId))
  );
}

export const DRAFT_QUOTE_LIMIT = 16;

/** The journal restores original quotes after the current ones, deduplicating full references. */
export function restoredDraftQuotes(current: QuoteRef[], original: readonly QuoteRef[] = []) {
  const quotes = [...current];
  for (const quote of original) {
    if (!quotes.some((existing) => sameValue(existing, quote))) quotes.push(quote);
  }
  return quotes;
}

/** Account for quotes in an in-flight journal restore before accepting a new selection. */
export function appendDraftQuote(
  current: QuoteRef[],
  quote: QuoteRef,
  restoring: readonly QuoteRef[],
) {
  const next = [...current, quote];
  return restoredDraftQuotes(next, restoring).length <= DRAFT_QUOTE_LIMIT ? next : null;
}

/**
 * Combines local edits typed while `restoreSend` was in flight with the
 * original unsent message's content, without re-appending the pre-restore draft
 * already folded into `restoreSend`'s persisted return value.
 */
export function mergeRestoredIntoHeldDraft<File extends { id: string }>(
  typed: { text: string; attachments: File[]; settledUploads: string[]; quotes: QuoteRef[] },
  restoredSource: { text: string; attachments: File[]; quotes?: QuoteRef[] },
) {
  const seen = new Set(typed.attachments.map((file) => file.id));
  const attachments = [
    ...typed.attachments,
    ...restoredSource.attachments.filter((file) => !seen.has(file.id)),
  ];
  const quotes = restoredDraftQuotes(typed.quotes, restoredSource.quotes);
  const text =
    restoredSource.text === ''
      ? typed.text
      : typed.text.trim() === '' || typed.text === restoredSource.text
        ? restoredSource.text
        : `${typed.text}\n\n${restoredSource.text}`;
  return {
    text,
    attachments,
    settledUploads: typed.settledUploads,
    quotes,
  };
}

/**
 * The sends that still stand in the conversation as rows of their own: the one
 * being saved, and those in flight, by their operation, until the message the
 * Host accepted takes their place.
 */
export function unsettledSends<Send>(
  saving: Send | undefined,
  inFlight: ReadonlyMap<string, Send>,
  settled: ReadonlySet<string>,
): Send[] {
  return [
    ...(saving === undefined ? [] : [saving]),
    ...[...inFlight].filter(([operation]) => !settled.has(operation)).map(([, send]) => send),
  ];
}

/**
 * Whether the conversation's working row should stand in place: either a run is
 * admitted/running/quietly waiting, or a local send that starts a run is still
 * in flight or accepted while waiting for the run to open.
 */
export function workingRowActive(state: {
  run: string;
  quietWait: boolean;
  pendingCount: number;
  outgoingCount: number;
}): boolean {
  return (
    state.run === 'admitted' ||
    state.run === 'running' ||
    (state.run === 'waiting' && state.quietWait) ||
    state.pendingCount > 0 ||
    state.outgoingCount > 0
  );
}
