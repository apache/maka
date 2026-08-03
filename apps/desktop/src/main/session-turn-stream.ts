import type { SessionEvent } from '@maka/core';
import {
  drainGoalTurn,
  type GoalObservedTurnStart,
  type GoalTurnOutcome,
  type SessionActivityLease,
  type SessionActivityRegistry,
} from '@maka/runtime';

export type SessionGoalBoundary = 'external' | 'coordinator' | 'none';

export interface StartDesktopSessionTurnInput {
  sessionId: string;
  events: AsyncIterable<SessionEvent>;
  turnId: string;
  goalBoundary: SessionGoalBoundary;
  activities: SessionActivityRegistry;
  activity?: SessionActivityLease;
  activityKey?: string;
  beginObservedTurn: (sessionId: string, turnId: string) => GoalObservedTurnStart;
  onEvent: (event: SessionEvent) => void | Promise<void>;
  onStreamError: (error: unknown) => void | Promise<void>;
  onDrained: (outcome: GoalTurnOutcome) => void | Promise<void>;
}

export type DesktopSessionTurnStart =
  | { kind: 'started'; completion: Promise<GoalTurnOutcome> }
  | { kind: 'unavailable'; reason: string };

/**
 * Desktop's canonical turn boundary. Registration and activity ownership are
 * established synchronously before the event iterator can start.
 */
export function startDesktopSessionTurn(
  input: StartDesktopSessionTurnInput,
): DesktopSessionTurnStart {
  const registration = input.goalBoundary === 'external'
    ? input.beginObservedTurn(input.sessionId, input.turnId)
    : undefined;
  if (registration && registration.kind !== 'registered') {
    return {
      kind: 'unavailable',
      reason: registration.reason,
    };
  }

  const activity = input.activity ?? input.activities.reserve(input.sessionId, input.activityKey);
  return {
    kind: 'started',
    completion: drainGoalTurn({
      events: input.events,
      turnId: input.turnId,
      activity,
      onEvent: input.onEvent,
      onStreamError: input.onStreamError,
      onDrained: input.onDrained,
      ...(registration?.kind === 'registered'
        ? { onSettled: (outcome) => { void registration.settle(outcome); } }
        : {}),
    }),
  };
}
