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

import type { MessageQueueEntryProjection } from '@maka/core/events';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopLocalMessage } from '../../../../shared/session-local-contract.js';
import { getSessionLocalCopy } from '../../../locales/session-local-copy.js';

export function localMessagePresentation(
  message: DesktopLocalMessage, locale: UiLocale,
  queue: readonly MessageQueueEntryProjection[] = [], runningTurnIds: readonly string[] = [],
): { status: string; detail?: string; tone: 'neutral' | 'warning' | 'danger' } {
  const copy = getSessionLocalCopy(locale);
  if (message.state === 'failed') return { status: copy.failed, detail: copy.failedDetail, tone: 'danger' };
  if (message.state === 'unknown') return {
    status: message.checking ? copy.checking : copy.unknown,
    detail: `${copy.unknownDetail}${message.retryScheduled && !message.waitingForConnection ? ` ${copy.retryDetail}` : ''}`,
    tone: 'warning',
  };
  if (message.state === 'saved') return {
    status: message.waitingForConnection ? copy.offline : copy.saved, detail: copy.savedDetail, tone: 'neutral',
  };
  if (message.state === 'sending') return { status: copy.sending, tone: 'neutral' };
  const entry = queue.find((entry) => entry.messageId === message.messageId);
  if (entry) return entry.placement === 'next_turn'
    ? { status: copy.queued, detail: copy.queuedDetail, tone: 'neutral' }
    : { status: entry.state === 'in_flight' ? copy.inFlight : copy.steering, detail: copy.steeringDetail, tone: 'neutral' };
  if (message.turnId && runningTurnIds.includes(message.turnId)) return { status: copy.processing, tone: 'neutral' };
  // An admission receipt is historical evidence, not a live queue or execution snapshot.
  const status = message.admission === 'steering' ? copy.acceptedSteering
    : message.admission === 'followup' ? copy.acceptedFollowup
    : message.admission === 'turn_started' ? copy.started : copy.accepted;
  return { status, tone: 'neutral' };
}
