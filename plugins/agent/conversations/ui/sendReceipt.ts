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
  Receipt,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import { message, type UiText } from '../../../../products/maka/workbench/app/text-value.ts';

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
  context: { immediate: boolean; activeRunId: string | null },
): boolean {
  if (!accepted) return false;
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
