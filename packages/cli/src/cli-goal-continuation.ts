import type { SessionEvent } from '@maka/core';
import {
  GoalContinuationCoordinator,
  SessionActivityRegistry,
  drainGoalTurn,
  type GoalContinuationDeps,
  type GoalControlStanding,
  type GoalState,
  type GoalObservedTurnStart,
  type GoalObservedTurnSettler,
  type GoalTurnAdmission,
  type GoalTurnOutcome,
} from '@maka/runtime';

export interface CliGoalTurnHost {
  admitTurn: (sessionId: string, text: string) => GoalTurnAdmission;
}

/** Owns the CLI's single coordinator and the activity boundary shared with Automation. */
export class CliGoalContinuation {
  readonly activities = new SessionActivityRegistry();
  private readonly coordinator: GoalContinuationCoordinator;
  private host: CliGoalTurnHost | undefined;
  private disposed = false;

  constructor(deps: Omit<GoalContinuationDeps, 'admitTurn'>) {
    this.coordinator = new GoalContinuationCoordinator({
      ...deps,
      admitTurn: (sessionId, text) => {
        const whenIdle = this.activities.whenIdle(sessionId);
        if (whenIdle) return { kind: 'busy', whenIdle };
        return (
          this.host?.admitTurn(sessionId, text) ?? {
            kind: 'unavailable',
            reason: 'TUI Goal host is not available.',
          }
        );
      },
    });
  }

  bindHost(host: CliGoalTurnHost): () => void {
    if (this.disposed) throw new Error('CLI Goal continuation is disposed.');
    if (this.host) throw new Error('CLI Goal continuation already has a bound host.');
    this.host = host;
    return () => {
      if (this.host === host) this.host = undefined;
    };
  }

  beginObservedTurn(sessionId: string, turnId: string): GoalObservedTurnStart {
    return this.coordinator.beginObservedTurn(sessionId, turnId);
  }

  activateGoal(
    sessionId: string,
    turnId: string,
    activate: () => GoalState,
  ): GoalState | undefined {
    return this.coordinator.activateGoal(sessionId, turnId, activate);
  }

  mutateGoal(sessionId: string, turnId: string, mutate: () => GoalState): GoalState | undefined {
    return this.coordinator.mutateGoal(sessionId, turnId, mutate);
  }

  activationStanding(sessionId: string, turnId: string): GoalControlStanding {
    return this.coordinator.activationStanding(sessionId, turnId);
  }

  mutationStanding(sessionId: string, turnId: string): GoalControlStanding {
    return this.coordinator.mutationStanding(sessionId, turnId);
  }

  async runAutomationTurn(input: {
    sessionId: string;
    turnId: string;
    start: () => AsyncIterable<SessionEvent>;
  }): Promise<GoalTurnOutcome> {
    const activity = await this.activities.acquire(input.sessionId);
    if (this.disposed) {
      activity.release();
      return {
        kind: 'errored',
        turnId: input.turnId,
        reason: 'CLI Goal continuation is disposed.',
      };
    }
    const registration = this.beginObservedTurn(input.sessionId, input.turnId);
    if (registration.kind !== 'registered') {
      activity.release();
      return { kind: 'errored', turnId: input.turnId, reason: registration.reason };
    }
    const settleExternalTurn: GoalObservedTurnSettler = registration.settle;
    let events: AsyncIterable<SessionEvent>;
    try {
      events = input.start();
    } catch (error) {
      activity.release();
      const reason = error instanceof Error ? error.message : String(error);
      const outcome: GoalTurnOutcome = {
        kind: 'errored',
        turnId: input.turnId,
        reason,
      };
      void settleExternalTurn(outcome);
      return outcome;
    }
    return drainGoalTurn({
      events,
      turnId: input.turnId,
      activity,
      onSettled: (outcome) => {
        void settleExternalTurn(outcome);
      },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host = undefined;
    this.coordinator.dispose();
  }
}
