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

import type { SessionEvent } from '@maka/core/events';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import {
  drainGoalTurn,
  type SessionActivityLease,
  type SessionActivityRegistry,
} from '@maka/runtime/goal-turn-lifecycle';
import { type GoalTurnOutcome } from '@maka/runtime/goal-continuation';
import {
  SkillInvocationBlockedError,
  type MakaPreparedSessionTurn,
  type MakaSessionDriver,
} from './session-driver.js';

export interface MakaPiTuiTurnActivity {
  activities: SessionActivityRegistry;
}

export type MakaPiTuiTurnRequest =
  | {
      kind: 'external';
      prompt: string;
      /** Model-facing text after explicit skill expansion, when different. */
      sendText?: string;
      /** Session observed before preparation; null is valid for the first turn. */
      sessionId: string | null;
      /** Trusted one-turn orchestration override supplied by a host command. */
      turnOrchestration?: TurnOrchestration;
    }
  | {
      /** A Turn that another Client or the Runtime Host already started. */
      kind: 'attached';
      turn: MakaPreparedSessionTurn;
    };

export interface RunMakaPiTuiTurnInput {
  driver: Pick<MakaSessionDriver, 'preparePrompt'>;
  turnActivity: MakaPiTuiTurnActivity;
  request: MakaPiTuiTurnRequest;
  shouldAbort: () => boolean;
  onStart?: () => void;
  onPrepared?: (turn: MakaPreparedSessionTurn) => void | Promise<void>;
  onSkillInvocation?: (result: SkillInvocationResult) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
}

/**
 * Owns one visible TUI turn from activity reservation through full stream drain.
 * Goal continuation and ScheduledTask admission remain Runtime Host responsibilities.
 */
export async function runMakaPiTuiTurn(input: RunMakaPiTuiTurnInput): Promise<GoalTurnOutcome> {
  const { request } = input;
  let activity: SessionActivityLease | undefined;
  let preparedTurnId = request.kind === 'attached' ? request.turn.turnId : undefined;

  const finishBeforeDrain = (outcome: GoalTurnOutcome): GoalTurnOutcome => {
    activity?.release();
    activity = undefined;
    return outcome;
  };

  try {
    input.onStart?.();
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(preparedTurnId));
    }

    const observedSessionId =
      request.kind === 'external' ? request.sessionId : request.turn.sessionId;
    if (observedSessionId) {
      activity = await input.turnActivity.activities.acquire(observedSessionId);
      if (input.shouldAbort()) {
        return finishBeforeDrain(abortedOutcome(preparedTurnId));
      }
    }

    const turn =
      request.kind === 'attached'
        ? request.turn
        : await input.driver.preparePrompt(request.prompt, {
            ...(request.sendText !== undefined ? { modelText: request.sendText } : {}),
            ...(request.turnOrchestration ? { turnOrchestration: request.turnOrchestration } : {}),
          });
    preparedTurnId = turn.turnId;
    if (turn.skillInvocation) await input.onSkillInvocation?.(turn.skillInvocation);
    await input.onPrepared?.(turn);

    if (!activity) activity = await input.turnActivity.activities.acquire(turn.sessionId);
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(turn.turnId));
    }

    let sawTerminalEvent = false;
    let failureProjected = false;
    const outcome = await drainGoalTurn({
      events: turn.events,
      turnId: turn.turnId,
      activity,
      onEvent: async (event) => {
        if (event.type === 'complete' || event.type === 'abort' || event.type === 'error') {
          sawTerminalEvent = true;
        }
        await input.onEvent?.(event);
      },
      onStreamError: async (error) => {
        failureProjected = true;
        await input.onFailure?.(error);
      },
      onDrained: async (outcome) => {
        if (outcome.kind === 'errored' && !sawTerminalEvent && !failureProjected) {
          await input.onFailure?.(new Error(outcome.reason));
        }
      },
    });
    activity = undefined;
    return outcome;
  } catch (error) {
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(preparedTurnId));
    }
    if (error instanceof SkillInvocationBlockedError) {
      await input.onSkillInvocation?.(error.skillInvocation);
      return finishBeforeDrain(abortedOutcome(preparedTurnId));
    }
    let reportedError = error;
    try {
      await input.onFailure?.(error);
    } catch (projectionError) {
      reportedError = projectionError;
    }
    return finishBeforeDrain({
      kind: 'errored',
      ...(preparedTurnId ? { turnId: preparedTurnId } : {}),
      reason: errorMessage(reportedError),
    });
  }
}

function abortedOutcome(turnId: string | undefined): GoalTurnOutcome {
  return { kind: 'aborted', ...(turnId ? { turnId } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
