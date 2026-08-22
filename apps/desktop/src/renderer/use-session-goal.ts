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

/**
 * Active-goal subscription for the renderer — the desktop kill-switch data source.
 *
 * Reads the session's goal via the preload bridge and re-fetches whenever the
 * main process emits a `goal-change` session event (goal set / continue /
 * pause / resume / terminal / clear). Only surfaces goals that are still
 * running (active or waiting, or paused); a settled goal returns null so the
 * session context disappears.
 *
 * Kept as a tiny standalone hook (no app-shell coupling) so an autonomous,
 * token-burning loop always has a visible indicator and a one-click stop,
 * regardless of where the chat surface renders it.
 */
import { useEffect, useState } from 'react';
import type { GoalState, GoalStatus } from '@maka/runtime/goal-state';

type LiveGoalStatus = Extract<GoalStatus, 'active' | 'waiting'>;
type LiveGoalState =
  | (GoalState & { readonly status: LiveGoalStatus })
  | (GoalState & { readonly status: 'paused'; readonly pausedAt: number });

const LIVE_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set(['active', 'waiting', 'paused']);

function isLiveGoal(goal: GoalState): goal is LiveGoalState {
  return (
    LIVE_GOAL_STATUSES.has(goal.status) &&
    (goal.status !== 'paused' ||
      (typeof goal.pausedAt === 'number' && Number.isFinite(goal.pausedAt)))
  );
}

export function useSessionGoal(sessionId: string | undefined): LiveGoalState | null {
  const [goal, setGoal] = useState<LiveGoalState | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setGoal(null);
      return;
    }
    // The previous Session's Goal is not an answer for this one, so it goes
    // before the first fetch resolves rather than after.
    setGoal(null);
    let cancelled = false;
    let refreshSequence = 0;
    const refresh = (): void => {
      const sequence = ++refreshSequence;
      void window.maka.goal
        .get(sessionId)
        .then((g) => {
          if (cancelled || sequence !== refreshSequence) return;
          setGoal(g && isLiveGoal(g) ? g : null);
        })
        .catch(() => {
          if (!cancelled && sequence === refreshSequence) setGoal(null);
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
      refreshSequence += 1;
      unsubscribe();
    };
  }, [sessionId]);

  return goal;
}
