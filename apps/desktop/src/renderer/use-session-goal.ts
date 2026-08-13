/**
 * Active-goal subscription for the renderer — the desktop kill-switch data source.
 *
 * Reads the session's goal via the preload bridge and re-fetches whenever the
 * main process emits a `goal-change` session event (goal set / continue /
 * terminal / clear). Only surfaces goals that are still running (active or
 * waiting, or paused); a settled goal returns null so the session context disappears.
 *
 * Kept as a tiny standalone hook (no app-shell coupling) so an autonomous,
 * token-burning loop always has a visible indicator and a one-click stop,
 * regardless of where the chat surface renders it.
 */
import { useEffect, useState } from 'react';
import type { GoalState, GoalStatus } from '@maka/runtime/goal-state';

const RUNNING_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set(['active', 'waiting', 'paused']);

export function useSessionGoal(sessionId: string | undefined): GoalState | null {
  const [goal, setGoal] = useState<GoalState | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setGoal(null);
      return;
    }
    let cancelled = false;
    const refresh = (): void => {
      void window.maka.goal
        .get(sessionId)
        .then((g) => {
          if (cancelled) return;
          setGoal(g && RUNNING_GOAL_STATUSES.has(g.status) ? g : null);
        })
        .catch(() => {
          if (!cancelled) setGoal(null);
        });
    };
    refresh();
    const unsubscribe = window.maka.sessions.subscribeChanges((event) => {
      // Refetch on goal transitions for this session (an undefined sessionId on
      // the event is a broadcast — refetch to be safe).
      if (event.reason === 'goal-change' && (!event.sessionId || event.sessionId === sessionId)) {
        refresh();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  return goal;
}
