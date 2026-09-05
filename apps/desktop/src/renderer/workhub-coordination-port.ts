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
  WorkHubCoordinationSnapshotResult,
  OperationOutcome,
  OperationError,
} from '@maka/runtime-host/protocol';
import { boundedWorkHubTimelineText, WorkHubCoordinationFailure } from './workhub-controller.js';

export { WorkHubCoordinationFailure };

import type { WorkHubDesktopTranscriptBridge } from './workhub-session-port.js';

const WORKHUB_COORDINATION_TURN_LIMIT = 40;

export function createDesktopWorkHubCoordinationPort(deps: {
  sessionId: string;
  transcripts: WorkHubDesktopTranscriptBridge;
  record(input: {
    turnId: string;
    userText: string;
    assistantText: string;
  }): Promise<{ turnId: string }>;
  candidates(): Promise<WorkHubCoordinationSnapshotResult>;
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
      let refreshGeneration = 0;
      let handle: Awaited<ReturnType<typeof deps.transcripts.open>> | undefined;
      let refreshLane = Promise.resolve();
      let refreshScheduled = false;
      let scheduledRefreshGeneration = 0;
      let activeDelegations: readonly WorkHubActiveDelegation[] = [];
      const emit = () => {
        handler(projectWorkHubCoordinationTurns(store.snapshot().messages), activeDelegations);
      };
      const scheduleRefresh = (generation: number) => {
        scheduledRefreshGeneration = generation;
        if (refreshScheduled) return;
        refreshScheduled = true;
        refreshLane = refreshLane
          .then(async () => {
            const scheduledGeneration = scheduledRefreshGeneration;
            refreshScheduled = false;
            if (disposed || scheduledGeneration !== refreshGeneration) return;
            const result = await deps.candidates();
            if (disposed || scheduledGeneration !== refreshGeneration) return;
            activeDelegations = result.delegations;
            if (ready) emit();
          })
          .catch(onError);
      };
      const opened = await deps.transcripts.open(
        deps.sessionId,
        (batch) => {
          if (disposed) return;
          try {
            const reset = batch.reset === true;
            if (batch.reset) {
              ready = false;
              refreshGeneration += 1;
            }
            const changed = store.accept(batch);
            ready ||= batch.ready;
            if (handle && (reset || changed || batch.ready)) scheduleRefresh(refreshGeneration);
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
      handle = opened;

      try {
        const result = await deps.candidates();
        activeDelegations = result.delegations;
        if (ready) emit();
      } catch (error) {
        disposed = true;
        await handle.close().catch(() => undefined);
        throw error;
      }
      return {
        async close() {
          disposed = true;
          await handle?.close();
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
  const terminalLinkState = new Map<string, 'superseded' | 'aborted' | 'stopped'>();
  const stopResolutionByDelegationId = new Map(
    messages.flatMap((message) =>
      message.type === 'workhub_coordination' && message.kind === 'delegation_stop_resolved'
        ? [[message.stopsDelegationId, message] as const]
        : [],
    ),
  );
  for (const message of messages) {
    const terminal = terminalDelegationLink(message);
    if (terminal) terminalLinkState.set(terminal.delegationId, terminal.state);
  }

  for (const message of messages) {
    if (message.type === 'workhub_coordination' && message.kind === 'delegation_resume') {
      turns.push({
        messageId: message.id,
        turnId: message.coordinationTurnId,
        text: boundedWorkHubTimelineText(message.userText),
        state: 'completed',
        resume: {
          targetSessionId: message.targetSessionId,
          targetSessionName: message.targetSessionName,
          outcome: message.outcome,
        },
        updatedAt: message.ts,
      });
      continue;
    }
    if (message.type === 'workhub_coordination' && message.kind === 'delegation_stop_requested') {
      const resolution = stopResolutionByDelegationId.get(message.stopsDelegationId);
      turns.push({
        messageId: message.id,
        turnId: message.coordinationTurnId,
        text: boundedWorkHubTimelineText(message.userText),
        state: resolution ? 'completed' : 'running',
        stop: {
          targetSessionId: message.targetSessionId,
          targetSessionName: message.targetSessionName,
          ...(resolution ? { outcome: resolution.outcome } : {}),
        },
        updatedAt: resolution ? Math.max(message.ts, resolution.ts) : message.ts,
      });
      continue;
    }
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
          linkState: terminalLinkState.get(message.delegationId) ?? 'active',
          ...(message.disposition === 'create_new' ? { createdNew: true as const } : {}),
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

function terminalDelegationLink(
  message: StoredMessage,
): { readonly delegationId: string; readonly state: 'superseded' | 'aborted' | 'stopped' } | undefined {
  if (message.type !== 'workhub_coordination') return undefined;
  if (message.kind === 'delegation_superseded') {
    return { delegationId: message.supersededDelegationId, state: 'superseded' };
  }
  if (message.kind === 'delegation_replacement_aborted') {
    return { delegationId: message.abortedDelegationId, state: 'aborted' };
  }
  if (message.kind === 'delegation_stop_resolved' && message.outcome !== 'not_owned') {
    return { delegationId: message.stopsDelegationId, state: 'stopped' };
  }
  return undefined;
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
