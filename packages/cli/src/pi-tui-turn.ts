import type { SessionEvent } from '@maka/core';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import {
  drainGoalTurn,
  type GoalObservedTurnStart,
  type GoalObservedTurnSettler,
  type GoalTurnOutcome,
  type SessionActivityLease,
  type SessionActivityRegistry,
} from '@maka/runtime';
import type { MakaPreparedSessionTurn, MakaSessionDriver } from './session-driver.js';

export interface MakaPiTuiTurnLifecycle {
  activities: SessionActivityRegistry;
  beginObservedTurn: (sessionId: string, turnId: string) => GoalObservedTurnStart;
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
      kind: 'coordinator';
      prompt: string;
      turnId: string;
      activity: SessionActivityLease;
    }
  | {
      /** A Turn that another Client or the Runtime Host already started. */
      kind: 'attached';
      turn: MakaPreparedSessionTurn;
    };

export interface RunMakaPiTuiTurnInput {
  driver: Pick<MakaSessionDriver, 'preparePrompt'>;
  lifecycle: MakaPiTuiTurnLifecycle;
  request: MakaPiTuiTurnRequest;
  shouldAbort: () => boolean;
  onStart?: () => void;
  onPrepared?: (turn: MakaPreparedSessionTurn) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
}

/**
 * Owns one visible TUI turn from activity reservation through full stream drain.
 * External settlement always follows activity release; coordinator turns return
 * their outcome directly to the admission completion capability.
 */
export async function runMakaPiTuiTurn(input: RunMakaPiTuiTurnInput): Promise<GoalTurnOutcome> {
  const { request } = input;
  let activity = request.kind === 'coordinator' ? request.activity : undefined;
  let preparedTurnId =
    request.kind === 'coordinator'
      ? request.turnId
      : request.kind === 'attached'
        ? request.turn.turnId
        : undefined;
  let settleExternalTurn: GoalObservedTurnSettler | undefined;

  const notifySettlement = (outcome: GoalTurnOutcome): void => {
    if (!settleExternalTurn) return;
    void settleExternalTurn(outcome);
  };

  const finishBeforeDrain = (outcome: GoalTurnOutcome): GoalTurnOutcome => {
    activity?.release();
    activity = undefined;
    notifySettlement(outcome);
    return outcome;
  };

  try {
    input.onStart?.();
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(preparedTurnId));
    }

    const observedSessionId =
      request.kind === 'external'
        ? request.sessionId
        : request.kind === 'attached'
          ? request.turn.sessionId
          : null;
    if (observedSessionId) {
      activity = await input.lifecycle.activities.acquire(observedSessionId);
      if (input.shouldAbort()) {
        return finishBeforeDrain(abortedOutcome(preparedTurnId));
      }
    }

    const turn =
      request.kind === 'attached'
        ? request.turn
        : await input.driver.preparePrompt(request.prompt, {
            ...(request.kind === 'coordinator' ? { turnId: request.turnId } : {}),
            ...(request.kind === 'external' && request.sendText !== undefined
              ? { modelText: request.sendText }
              : {}),
            ...(request.kind === 'external' && request.turnOrchestration
              ? { turnOrchestration: request.turnOrchestration }
              : {}),
          });
    preparedTurnId = turn.turnId;
    await input.onPrepared?.(turn);

    if (!activity) activity = await input.lifecycle.activities.acquire(turn.sessionId);
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(turn.turnId));
    }

    if (request.kind !== 'coordinator') {
      const registration = input.lifecycle.beginObservedTurn(turn.sessionId, turn.turnId);
      if (registration.kind !== 'registered') {
        throw new Error(registration.reason);
      }
      settleExternalTurn = registration.settle;
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
      onSettled: notifySettlement,
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
