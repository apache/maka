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
import {
  drainGoalTurn,
  type SessionActivityLease,
  type SessionActivityRegistry,
} from '@maka/runtime/goal-turn-lifecycle';
import { type GoalTurnOutcome } from '@maka/runtime/goal-continuation';
import type { MakaPreparedSessionTurn } from './session-driver.js';

export interface MakaPiTuiTurnActivity {
  activities: SessionActivityRegistry;
}

/** A Turn that another Client or the Runtime Host already started. */
export interface MakaPiTuiTurnRequest {
  turn: MakaPreparedSessionTurn;
}

export interface RunMakaPiTuiTurnInput {
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
 * Every Turn reaches the TUI the same way: Runtime Host admits a submitted
 * Message and this runner attaches to the Turn it started.
 */
export async function runMakaPiTuiTurn(input: RunMakaPiTuiTurnInput): Promise<GoalTurnOutcome> {
  const { request } = input;
  let activity: SessionActivityLease | undefined;
  let preparedTurnId = request.turn.turnId;

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

    activity = await input.turnActivity.activities.acquire(request.turn.sessionId);
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(preparedTurnId));
    }

    const turn = request.turn;
    preparedTurnId = turn.turnId;
    // Adoption first: onPrepared replaces the transcript with the attached
    // Turn's canonical messages, so a Skill card projected before it would be
    // wiped by the very adoption that follows.
    await input.onPrepared?.(turn);
    if (turn.skillInvocation) await input.onSkillInvocation?.(turn.skillInvocation);

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
