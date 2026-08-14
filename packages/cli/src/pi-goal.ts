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

/** Full `/goal` summary. Terminal goals are as welcome here as live ones. */
export function goalSummaryLines(goal: GoalProjection, now: number): string[] {
  // Conditions and evaluator notes may legally embed newlines; collapse
  // whitespace so each field stays on one notice line.
  const inline = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const status = `Status: ${goalStatusLabel(goal.status)} · ${goal.iterations}/${goal.maxIterations} iterations`;
  // Terminal verdicts other than `achieved` carry no freeze timestamp, so a
  // wall-clock elapsed would keep growing for a loop that already ended.
  const elapsedMeaningful =
    isLiveGoalStatus(goal.status) || (goal.status === 'achieved' && goal.achievedAt !== null);
  const lines = [
    // A cleared goal keeps its terminal record, so say "cleared" up front
    // instead of presenting the condition as if it were still armed.
    goal.status === 'cleared'
      ? `Cleared goal: ${inline(goal.condition)}`
      : `Goal: ${inline(goal.condition)}`,
    elapsedMeaningful ? `${status} · ${formatGoalElapsed(goalElapsedMs(goal, now))}` : status,
  ];
  if (goal.tokenBudget !== null) {
    lines.push(
      `Tokens: ${formatTokenCount(goal.tokensSpent)} / ${formatTokenCount(goal.tokenBudget)}`,
    );
  } else if (goal.tokensSpent > 0) {
    lines.push(`Tokens: ${formatTokenCount(goal.tokensSpent)}`);
  }
  if (goal.lastReason) lines.push(`Last evaluator note: ${inline(goal.lastReason)}`);
  return lines;
}
