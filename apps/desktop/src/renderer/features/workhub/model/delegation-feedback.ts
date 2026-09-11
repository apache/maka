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

import type { SessionSummary, StoredMessage, TurnRecord } from '@maka/core/session';
import type { TurnMessageExecutionResolution } from '@maka/runtime-host/protocol';
import type { WorkHubDelegationState } from './linked-work.js';

export function projectWorkHubDelegationState(input: {
  resolution: TurnMessageExecutionResolution | undefined;
  session: SessionSummary | undefined;
  turn: TurnRecord | undefined;
  executionReadFailed?: boolean;
  turnReadFailed?: boolean;
}): WorkHubDelegationState {
  if (input.executionReadFailed || !input.resolution) return 'recovering';
  if (input.resolution.state === 'cancelled') return 'aborted';
  if (input.resolution.state === 'pending') return 'accepted';
  if (input.turn?.statusSource === 'recorded' && input.turn.status !== 'running') {
    return input.turn.status;
  }
  const ownsLiveTurn = input.session?.runningTurnIds?.includes(input.resolution.turnId) === true;
  if (ownsLiveTurn && input.session?.status === 'waiting_for_user') return 'waiting_for_user';
  if (ownsLiveTurn) return 'running';
  if (input.turnReadFailed || !input.session || !input.turn) return 'recovering';
  if (input.session?.runningTurnIds === undefined &&
    input.turn?.statusSource === 'recorded' && input.turn.status === 'running') return 'running';
  return 'accepted';
}

const WORKHUB_RESULT_PREVIEW_MAX_CHARACTERS = 600;

export function workHubTurnResultPreview(
  messages: readonly StoredMessage[],
  turnId: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== 'assistant' || message.turnId !== turnId || !message.text.trim()) continue;
    const normalized = message.text.trim().replace(/\s+/gu, ' ');
    const characters = Array.from(normalized);
    return characters.length <= WORKHUB_RESULT_PREVIEW_MAX_CHARACTERS
      ? normalized
      : `${characters.slice(0, WORKHUB_RESULT_PREVIEW_MAX_CHARACTERS - 1).join('')}…`;
  }
  return undefined;
}
