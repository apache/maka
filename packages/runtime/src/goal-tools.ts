/**
 * Goal tools — GoalSet / GoalClear / GoalStatus / GoalPause / GoalResume.
 *
 * Model-facing autonomous-execution controls. The agent can arm its own stop
 * condition (GoalSet), and pause/resume/clear the loop. PascalCase names match
 * the builtin tool family (Bash/Read/TaskCreate/Automation).
 */

import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';
import { TERMINAL_GOAL_STATUSES, type GoalManager, type GoalState } from './goal-state.js';
import type { GoalContinuationCoordinator } from './goal-continuation.js';

export const GOAL_SET_TOOL_NAME = 'GoalSet';
export const GOAL_CLEAR_TOOL_NAME = 'GoalClear';
export const GOAL_STATUS_TOOL_NAME = 'GoalStatus';
export const GOAL_PAUSE_TOOL_NAME = 'GoalPause';
export const GOAL_RESUME_TOOL_NAME = 'GoalResume';

export interface GoalToolsDeps {
  goalManager: GoalManager;
  /** Owns atomic turn authorization for every model-triggered Goal mutation. */
  goalContinuation: Pick<GoalContinuationCoordinator, 'activateGoal' | 'mutateGoal'>;
  /** Current cumulative token count for a session (baseline for budget). */
  getTokenCount?: (sessionId: string) => number;
  now?: () => number;
}

export function buildGoalTools(deps: GoalToolsDeps): MakaTool[] {
  return [
    buildGoalSetTool(deps),
    buildGoalClearTool(deps),
    buildGoalStatusTool(deps),
    buildGoalPauseTool(deps),
    buildGoalResumeTool(deps),
  ];
}

function buildGoalSetTool(deps: GoalToolsDeps): MakaTool<
  {
    condition: string;
    max_iterations?: number;
    block_cap?: number;
    token_budget?: number;
  },
  string
> {
  return {
    name: GOAL_SET_TOOL_NAME,
    displayName: 'Goal Set',
    description:
      'Set an autonomous execution goal. After each turn an evaluator judges progress; ' +
      'if the condition is not met the system continues working turn after turn until it is ' +
      'met, deemed impossible, stalls, or hits a limit. Only one goal is active per session; ' +
      'an unfinished goal must be cleared or completed before another can be set.',
    parameters: z.object({
      condition: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          'The objective to achieve. Should be observable and verifiable (e.g. "all tests in packages/runtime pass", "PR #522 review comments addressed").',
        ),
      max_iterations: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Absolute ceiling on total turns before giving up. Defaults to 50.'),
      block_cap: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Stop after this many consecutive turns with no progress (stall detection). Defaults to 8.',
        ),
      token_budget: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe(
          'Optional token budget; the goal stops (budget_limited) once this many tokens are spent working toward it.',
        ),
    }),
    impl: (input, ctx) => {
      const existing = deps.goalManager.get(ctx.sessionId);
      if (existing && !TERMINAL_GOAL_STATUSES.has(existing.status)) {
        return (
          `Goal not set: unfinished goal "${existing.condition}" is ${existing.status}. ` +
          'Clear or complete it before setting another goal.'
        );
      }
      const tokensAtStart = deps.getTokenCount?.(ctx.sessionId) ?? 0;
      const goal = deps.goalContinuation.activateGoal(ctx.sessionId, ctx.turnId, () => {
        return deps.goalManager.create(ctx.sessionId, input.condition, {
          maxIterations: input.max_iterations,
          blockCap: input.block_cap,
          tokenBudget: input.token_budget,
          tokensAtStart,
        }).goal;
      });
      if (!goal) {
        return 'Goal not set: this turn no longer owns Goal activation.';
      }
      const limits = [
        `max ${goal.maxIterations} turns`,
        `stall after ${goal.blockCap} no-progress turns`,
        goal.tokenBudget ? `budget ${goal.tokenBudget} tokens` : undefined,
      ]
        .filter(Boolean)
        .join(', ');
      return (
        `Goal set: "${goal.condition}" (${limits}). ` +
        'The system will evaluate progress after each turn and continue autonomously until the condition is met.'
      );
    },
  };
}

function buildGoalClearTool(deps: GoalToolsDeps): MakaTool<Record<string, never>, string> {
  return {
    name: GOAL_CLEAR_TOOL_NAME,
    displayName: 'Goal Clear',
    description: 'Clear the active goal, stopping autonomous execution after the current turn.',
    parameters: z.object({}),
    impl: (_input, ctx) => {
      const current = deps.goalManager.get(ctx.sessionId);
      if (!current || TERMINAL_GOAL_STATUSES.has(current.status)) {
        return 'No active goal to clear.';
      }
      const goal = deps.goalContinuation.mutateGoal(ctx.sessionId, ctx.turnId, () => {
        return deps.goalManager.clear(ctx.sessionId)!;
      });
      if (!goal) {
        return 'Goal not cleared: this turn no longer owns Goal control.';
      }
      return `Goal cleared: "${goal.condition}" after ${goal.iterations} turn(s).`;
    },
  };
}

function buildGoalPauseTool(deps: GoalToolsDeps): MakaTool<Record<string, never>, string> {
  return {
    name: GOAL_PAUSE_TOOL_NAME,
    displayName: 'Goal Pause',
    description:
      'Pause the active goal. Autonomous continuation stops until GoalResume is called; state is preserved.',
    parameters: z.object({}),
    impl: (_input, ctx) => {
      const current = deps.goalManager.get(ctx.sessionId);
      if (!current || (current.status !== 'active' && current.status !== 'waiting')) {
        return 'No active goal to pause.';
      }
      const goal = deps.goalContinuation.mutateGoal(ctx.sessionId, ctx.turnId, () => {
        return deps.goalManager.pause(ctx.sessionId)!;
      });
      if (!goal) {
        return 'Goal not paused: this turn no longer owns Goal control.';
      }
      return `Goal paused: "${goal.condition}" at turn ${goal.iterations}. Use GoalResume to continue.`;
    },
  };
}

function buildGoalResumeTool(deps: GoalToolsDeps): MakaTool<Record<string, never>, string> {
  return {
    name: GOAL_RESUME_TOOL_NAME,
    displayName: 'Goal Resume',
    description: 'Resume a paused goal, re-enabling autonomous continuation.',
    parameters: z.object({}),
    impl: (_input, ctx) => {
      if (deps.goalManager.get(ctx.sessionId)?.status !== 'paused') {
        return 'No paused goal to resume.';
      }
      const goal = deps.goalContinuation.activateGoal(ctx.sessionId, ctx.turnId, () => {
        return deps.goalManager.resume(ctx.sessionId)!;
      });
      if (!goal) {
        return 'Goal not resumed: this turn no longer owns Goal activation.';
      }
      return `Goal resumed: "${goal.condition}". Autonomous continuation re-enabled.`;
    },
  };
}

function buildGoalStatusTool(deps: GoalToolsDeps): MakaTool<Record<string, never>, string> {
  return {
    name: GOAL_STATUS_TOOL_NAME,
    displayName: 'Goal Status',
    description: 'Check the current goal status for this session.',
    parameters: z.object({}),
    impl: (_input, ctx) => {
      const goal = deps.goalManager.get(ctx.sessionId);
      if (!goal) return 'No goal set for this session.';
      return formatGoal(goal, deps);
    },
  };
}

function formatGoal(goal: GoalState, deps: GoalToolsDeps): string {
  const now = deps.now?.() ?? Date.now();
  const elapsed = Math.round((now - goal.setAt) / 1000);
  const spent = Math.max(0, goal.tokensNow - goal.tokensAtStart);
  const lines = [
    `Goal: "${goal.condition}"`,
    `Status: ${goal.status}`,
    `Turns: ${goal.iterations}/${goal.maxIterations}`,
    `No-progress streak: ${goal.consecutiveNoProgress}/${goal.blockCap}`,
    `Elapsed: ${elapsed}s`,
  ];
  if (goal.tokenBudget) lines.push(`Tokens: ${spent}/${goal.tokenBudget}`);
  else if (spent > 0) lines.push(`Tokens spent: ${spent}`);
  if (goal.lastReason) lines.push(`Last reason: ${goal.lastReason}`);
  return lines.join('\n');
}
