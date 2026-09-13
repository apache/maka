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
 * Goal display helpers for the TUI — the status-line segment and the `/goal`
 * summary share this formatting. Pure functions over the host's Goal
 * projection; the session driver owns fetching.
 *
 * Codex parallel: codex-rs/tui/src/goal_display.rs.
 */

import type { GoalStatus } from '@maka/core/goal';
import type { GoalProjection } from '@maka/runtime-host/protocol';
import { formatTokenCount } from './pi-transcript-format.js';
import { stripAnsi } from './tui-ansi.js';

/**
 * Statuses a watching user still cares about. Terminal goals are hidden from
 * the status line (matching the desktop chip) but remain visible to `/goal`.
 */
export function isLiveGoalStatus(status: GoalStatus): boolean {
  return status === 'active' || status === 'waiting' || status === 'paused';
}

export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return 'active';
    case 'waiting':
      return 'waiting';
    case 'paused':
      return 'paused';
    case 'achieved':
      return 'achieved';
    case 'impossible':
      return 'impossible';
    case 'cleared':
      return 'cleared';
    case 'stalled':
      return 'stalled';
    case 'budget_limited':
      return 'budget limited';
    case 'max_iterations':
      return 'iteration limit';
  }
}

/**
 * Wall-clock milliseconds since the goal was armed: frozen at `pausedAt`
 * while paused and at `achievedAt` once achieved. Not accumulated active
 * time: a pause/resume cycle keeps the paused window in the total. Honest
 * and cheap; per-goal active-time accounting would require runtime changes
 * (Codex tracks it server-side).
 */
export function goalElapsedMs(
  goal: Pick<GoalProjection, 'status' | 'setAt' | 'pausedAt' | 'achievedAt'>,
  now: number,
): number {
  const end =
    goal.status === 'paused' && goal.pausedAt !== null
      ? goal.pausedAt
      : goal.status === 'achieved' && goal.achievedAt !== null
        ? goal.achievedAt
        : now;
  return Math.max(0, end - goal.setAt);
}

export function formatGoalElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * One compact status-line segment for a live goal:
 *   active  → `goal 3/50 12m`
 *   waiting → `goal waiting 3/50`
 *   paused  → `goal paused 3/50`
 * Elapsed is omitted while waiting/paused: waiting bounces between turns and
 * paused freezes the clock, so the number adds noise without saying "alive".
 */
export function goalStatusLineText(
  goal: Pick<
    GoalProjection,
    'status' | 'iterations' | 'maxIterations' | 'setAt' | 'pausedAt' | 'achievedAt'
  >,
  now: number,
): string {
  const counter = `${goal.iterations}/${goal.maxIterations}`;
  if (goal.status === 'active') {
    return `goal ${counter} ${formatGoalElapsed(goalElapsedMs(goal, now))}`;
  }
  return `goal ${goalStatusLabel(goal.status)} ${counter}`;
}

/** Conditions and evaluator notes may legally embed newlines; collapse whitespace so notices stay one line per field. */
function inlineGoalText(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One-line notice when a goal transitions into paused while attached —
 * typically the runtime's abort auto-pause after Ctrl+C on a goal
 * continuation turn. Says the loop still exists and how to continue/stop it.
 */
export function goalPausedNoticeText(
  goal: Pick<GoalProjection, 'iterations' | 'maxIterations' | 'lastReason'>,
): string {
  const reason = goal.lastReason ? ` ${inlineGoalText(goal.lastReason)}` : '';
  return `Goal paused (${goal.iterations}/${goal.maxIterations}).${reason} /goal resume continues it, /goal clear stops it.`;
}

/**
 * One-line notice when attaching to a session whose durable goal is
 * auto-continuing after recovery — a token-burning loop never resumes silently.
 */
export function goalAttachedNoticeText(
  goal: Pick<GoalProjection, 'condition' | 'iterations' | 'maxIterations'>,
): string {
  const condition = inlineGoalText(goal.condition);
  const short = condition.length > 120 ? `${condition.slice(0, 119)}…` : condition;
  return `Autonomous goal is running (${goal.iterations}/${goal.maxIterations}): ${short} — /goal shows details, /goal pause pauses it.`;
}

/** Full `/goal` summary. Terminal goals are as welcome here as live ones. */
export function goalSummaryLines(goal: GoalProjection, now: number): string[] {
  const status = `Status: ${goalStatusLabel(goal.status)} · ${goal.iterations}/${goal.maxIterations} iterations`;
  // Terminal verdicts other than `achieved` carry no freeze timestamp, so a
  // wall-clock elapsed would keep growing for a loop that already ended.
  const elapsedMeaningful =
    isLiveGoalStatus(goal.status) || (goal.status === 'achieved' && goal.achievedAt !== null);
  const lines = [
    // A cleared goal keeps its terminal record, so say "cleared" up front
    // instead of presenting the condition as if it were still armed.
    goal.status === 'cleared'
      ? `Cleared goal: ${inlineGoalText(goal.condition)}`
      : `Goal: ${inlineGoalText(goal.condition)}`,
    elapsedMeaningful ? `${status} · ${formatGoalElapsed(goalElapsedMs(goal, now))}` : status,
  ];
  if (goal.tokenBudget !== null) {
    lines.push(
      `Tokens: ${formatTokenCount(goal.tokensSpent)} / ${formatTokenCount(goal.tokenBudget)}`,
    );
  } else if (goal.tokensSpent > 0) {
    lines.push(`Tokens: ${formatTokenCount(goal.tokensSpent)}`);
  }
  if (goal.lastReason) lines.push(`Last evaluator note: ${inlineGoalText(goal.lastReason)}`);
  return lines;
}
