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
  WorkHubActiveDelegation,
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
      let historyReady = false;
      const coordinationMessagesBySequence = new Map<number, StoredMessage>();
      const emit = () => {
        const messages = store.snapshot().messages;
        handler(
          projectWorkHubCoordinationTurns(messages),
          projectWorkHubActiveDelegations(
            [...coordinationMessagesBySequence.entries()]
              .sort(([left], [right]) => left - right)
              .map(([sequence, message]) => ({ sequence, message })),
          ),
        );
      };
      const handle = await deps.transcripts.open(
        deps.sessionId,
        (batch) => {
          if (disposed) return;
          try {
            if (batch.reset) coordinationMessagesBySequence.clear();
            const changed = store.accept(batch);
            for (const { sequence, message } of store.durableEntries()) {
              if (message.type === 'workhub_coordination') {
                coordinationMessagesBySequence.set(sequence, message);
              }
            }
            ready ||= batch.ready;
            if (historyReady && ready && (changed || batch.ready)) emit();
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
      try {
        while (!disposed && store.range().hasOlder) {
          const before = store.range().oldestSequence;
          await handle.loadBefore(before);
          const after = store.range();
          if (after.hasOlder && after.oldestSequence === before) {
            throw new Error('WorkHub Coordination transcript history did not advance');
          }
        }
        const range = store.range();
        if (!disposed && range.hasNewer && range.durableThrough !== null) {
          await handle.loadAround(range.durableThrough);
        }
      } catch (error) {
        disposed = true;
        await handle.close().catch(() => undefined);
        throw error;
      }
      historyReady = true;
      if (ready && !disposed) emit();
      return {
        async close() {
          disposed = true;
          await handle.close();
        },
      };
    },
  };
}

export function projectWorkHubActiveDelegations(
  entries: ReadonlyArray<{ readonly sequence: number; readonly message: StoredMessage }>,
): WorkHubActiveDelegation[] {
  const supersededDelegationIds = new Set(
    entries.flatMap(({ message }) =>
      message.type === 'workhub_coordination' && message.kind === 'delegation_superseded'
        ? [message.supersededDelegationId]
        : []),
  );
  return entries.flatMap(({ message, sequence }) =>
    message.type === 'workhub_coordination' &&
      message.kind === 'delegation_assigned' &&
      !supersededDelegationIds.has(message.delegationId)
      ? [{
          actionId: message.actionId,
          targetSessionId: message.targetSessionId,
          sequence,
        }]
      : []);
}

export function projectWorkHubCoordinationTurns(
  messages: readonly StoredMessage[],
): WorkHubCoordinationTurn[] {
  const stateByTurnId = new Map(
    deriveTurnRecords(messages).map((turn) => [turn.turnId, projectState(turn.status)]),
  );
  const turns: WorkHubCoordinationTurn[] = [];
  const latestUserIndexByTurnId = new Map<string, number>();
  const supersededDelegationIds = new Set(
    messages.flatMap((message) =>
      message.type === 'workhub_coordination' && message.kind === 'delegation_superseded'
        ? [message.supersededDelegationId]
        : []),
  );

  for (const message of messages) {
    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') {
      turns.push({
        messageId: message.id,
        turnId: message.coordinationTurnId,
        text: boundedWorkHubTimelineText(message.userText),
        state: 'completed',
        assignment: {
          actionId: message.actionId,
          delegationId: message.delegationId,
          targetSessionId: message.targetSessionId,
          targetSessionName: message.targetSessionName,
          targetMessageId: message.targetMessageId,
          targetTurnId: message.targetTurnId,
          feedbackState: 'accepted',
          linkState: supersededDelegationIds.has(message.delegationId)
            ? 'superseded'
            : 'active',
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
