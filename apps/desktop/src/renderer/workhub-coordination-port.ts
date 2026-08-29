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

import {
  deriveTurnRecords,
  userFacingText,
  type StoredMessage,
  type TurnStatus,
} from '@maka/core/session';
import { DesktopTranscriptRangeStore } from './desktop-transcript-range-store.js';
import type {
  WorkHubCoordinationPort,
  WorkHubCoordinationTurn,
  WorkHubProjectedTurnState,
} from './workhub-controller.js';
import type {
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidatesResult,
  OperationOutcome,
  OperationError,
} from '@maka/runtime-host/protocol';
import { boundedWorkHubTimelineText } from './workhub-controller.js';
import type { WorkHubDesktopTranscriptBridge } from './workhub-session-port.js';

const WORKHUB_COORDINATION_TURN_LIMIT = 40;

export class WorkHubCoordinationFailure extends Error {
  constructor(
    readonly code: OperationError<'workhub.coordination.act'>['code'],
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubCoordinationFailure';
  }
}

export function createDesktopWorkHubCoordinationPort(deps: {
  sessionId: string;
  transcripts: WorkHubDesktopTranscriptBridge;
  answer(input: { turnId: string; text: string }): Promise<{ turnId: string }>;
  record(input: {
    turnId: string;
    userText: string;
    assistantText: string;
  }): Promise<{ turnId: string }>;
  candidates(): Promise<WorkHubCoordinationCandidatesResult>;
  act(
    input: Omit<WorkHubCoordinationActInput, 'create'>,
  ): Promise<OperationOutcome<'workhub.coordination.act'>>;
}): WorkHubCoordinationPort {
  return {
    answer: deps.answer,
    record: deps.record,
    candidates: deps.candidates,
    async act(input) {
      const outcome = await deps.act(input);
      if (!outcome.ok) {
        throw new WorkHubCoordinationFailure(outcome.error.code, outcome.error.message);
      }
      return outcome.result;
    },
    async open(handler, onError) {
      const store = new DesktopTranscriptRangeStore(deps.sessionId);
      let disposed = false;
      let ready = false;
      const handle = await deps.transcripts.open(
        deps.sessionId,
        (batch) => {
          if (disposed) return;
          try {
            const changed = store.accept(batch);
            ready ||= batch.ready;
            if (ready && (changed || batch.ready)) {
              handler(projectWorkHubCoordinationTurns(store.snapshot().messages));
            }
          } catch (error) {
            onError(error);
          }
        },
        (cancel) => {
          if (disposed) cancel();
        },
      ).catch((error) => {
        onError(error);
        throw error;
      });
      return {
        async close() {
          disposed = true;
          await handle.close();
        },
      };
    },
  };
}

export function projectWorkHubCoordinationTurns(
  messages: readonly StoredMessage[],
): WorkHubCoordinationTurn[] {
  const stateByTurnId = new Map(
    deriveTurnRecords(messages).map((turn) => [turn.turnId, projectState(turn.status)]),
  );
  const turns: WorkHubCoordinationTurn[] = [];
  const latestUserIndexByTurnId = new Map<string, number>();

  for (const message of messages) {
    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') {
      turns.push({
        messageId: message.id,
        turnId: message.coordinationTurnId,
        text: boundedWorkHubTimelineText(message.userText),
        state: 'completed',
        assignment: {
          targetSessionId: message.targetSessionId,
          targetSessionName: message.targetSessionName,
        },
        updatedAt: message.ts,
      });
      continue;
    }
    if (message.type === 'user') {
      const text = boundedWorkHubTimelineText(userFacingText(message));
      if (!text) continue;
      turns.push({
        messageId: message.id,
        turnId: message.turnId,
        text,
        state: stateByTurnId.get(message.turnId) ?? 'running',
        updatedAt: message.ts,
      });
      latestUserIndexByTurnId.set(message.turnId, turns.length - 1);
      continue;
    }
    if (message.type !== 'assistant') continue;
    const userIndex = latestUserIndexByTurnId.get(message.turnId);
    if (userIndex === undefined) continue;
    const result = boundedWorkHubTimelineText(message.text);
    turns[userIndex] = {
      ...turns[userIndex]!,
      ...(result ? { result } : {}),
      updatedAt: Math.max(turns[userIndex]!.updatedAt, message.ts),
    };
  }

  return turns
    .sort((left, right) =>
      left.updatedAt - right.updatedAt || left.messageId.localeCompare(right.messageId),
    )
    .slice(-WORKHUB_COORDINATION_TURN_LIMIT);
}

function projectState(status: TurnStatus): WorkHubProjectedTurnState {
  switch (status) {
    case 'running':
      return 'running';
    case 'aborted':
      return 'aborted';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
  }
}
