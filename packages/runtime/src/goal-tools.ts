/**
 * Goal tools — GoalSet / GoalClear / GoalStatus / GoalPause / GoalResume.
 *
 * Model-facing autonomous-execution controls. The agent can arm its own stop
 * condition (GoalSet), and pause/resume/clear the loop. Names follow their
 * canonical registered tool identities.
 */

import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';
import {
  GOAL_CONDITION_TEXT_LIMIT,
  isGoalTextWithinLimit,
  TERMINAL_GOAL_STATUSES,
  type GoalManager,
  type GoalState,
} from './goal-state.js';
import type { GoalContinuationCoordinator, GoalControlDecline } from './goal-continuation.js';

export const GOAL_SET_TOOL_NAME = 'GoalSet';
export const GOAL_CLEAR_TOOL_NAME = 'GoalClear';
export const GOAL_STATUS_TOOL_NAME = 'GoalStatus';
export const GOAL_PAUSE_TOOL_NAME = 'GoalPause';
export const GOAL_RESUME_TOOL_NAME = 'GoalResume';

/**
 * What a declined Goal mutation tells the model to do next.
 *
 * These four tools all failed the same way and said so in one sentence: the
 * turn no longer owns Goal control. Opaque, but it asked for nothing. Replacing
 * it with a single cause and a retry made it worse, because only one of the
 * causes is a race. A turn that was never registered under a Goal boundary —
 * every turn started with `goalBoundary: 'none'`, and every turn whose session
 * was closed and removed — declines permanently. Told to call GoalStatus and
 * then retry "if there is still no active goal", such a turn gets "No goal set
 * for this session", satisfies the condition, retries, and receives the
 * identical refusal, forever.
 *
 * So a retry is prescribed only where a retry can succeed — and that turned out
 * to be nowhere. `goal_changed` reads like a race, and it is one, but the loser
 * of that race cannot re-enter it: `observedControlLease` is written once in
 * `beginObservedTurn` and refreshed only by a mutation that succeeds, so once
 * the lease has moved on, every gate this turn passes through declines with the
 * same cause until the turn ends. Driven against the real coordinator — one
 * turn registers, a second arms a goal and clears it — GoalSet declines
 * `goal_changed` on the first call and on the fourth, and GoalStatus in between
 * reports a goal that only makes the model want to call again.
 *
 * `goal_already_armed` is the same shape. It is reachable from GoalSet only
 * once the armed goal has left `active` — otherwise the "unfinished goal is
 * active" guard answers first — and by then `registration.controlLease` is set
 * and nothing this turn can call will clear it, because clearing it requires a
 * mutation that the moved lease also declines.
 *
 * Every branch therefore ends by closing the retry. Reading the goal is still
 * safe, so GoalStatus is still offered where it would tell the model something
 * it does not know; it is offered as the last thing to do, not as a step on the
 * way back to the call that just failed.
 *
 * The advice also has to know which tool it is answering. `goal_already_armed`
 * is produced by the activation gate, and GoalResume goes through that gate too
 * — so a turn that arrived while a goal was active, paused it and then tried to
 * resume it read "this turn cannot arm a second one" in reply to a request that
 * asked to arm nothing. Same cause, different thing to say about it.
 *
 * "Already armed" was also the wrong noun for the cause. A turn holds the lease
 * either because it armed a goal or because `beginObservedTurn` bound it to a
 * goal that was already active — the second turn never armed anything. What the
 * gate observes is a binding, so that is what the sentence names.
 */
function declineAdvice(reason: GoalControlDecline, tool: string): string {
  switch (reason) {
    case 'goal_changed':
      return (
        'the session goal changed while this turn was running, and this turn can act only on the ' +
        'goal it observed. Call GoalStatus to see the current goal, then report what it shows; ' +
        `do not call ${tool} again in this turn, because it will decline the same way.`
      );
    case 'goal_already_armed':
      return tool === GOAL_SET_TOOL_NAME
        ? 'this turn is already bound to a goal, and a turn can bind only once, so it cannot arm ' +
            'a second one. Call GoalStatus to see that goal, then report what it shows; do not ' +
            'call GoalSet again in this turn, because it will decline the same way.'
        : 'this turn is already bound to a goal, and a turn can bind only once, so ' +
            `${tool} cannot take another. Call GoalStatus to see the current goal. ` +
            `Do not call ${tool} again in this turn; report what GoalStatus shows.`;
    case 'coordinator_disposed':
      return (
        'the goal system is shutting down, so it can no longer be changed. ' +
        'Do not call this tool again in this turn; say what you were trying to change.'
      );
    case 'goal_not_observed':
      return (
        'this turn began before the current goal existed, so it cannot change it. ' +
        'Do not call this tool again in this turn; say what you were trying to change.'
      );
    case 'turn_not_registered':
      return (
        'this turn does not run under the session goal boundary, so it cannot change the goal. ' +
        'Do not call this tool again in this turn; say what you were trying to change.'
      );
  }
}

/**
 * Shown when the enclosing Goal authority has stopped accepting mutations.
 *
 * Its only producer is `GoalCoordinator.beginDrain`, which is one-way: the flag
 * is set once, the continuation coordinator is disposed alongside it, and
 * nothing clears it. "Goal authority is unavailable." left the model free to
 * read that as a passing condition and call again for the rest of the turn, so
 * the replacement says the door does not reopen and names the move that is
 * always left.
 */
const GOAL_AUTHORITY_GONE =
  'Goal authority has been shut down, so goals can no longer be set or changed, and it will not ' +
  'come back. Do not call this tool again; say what you were trying to change.';

export interface GoalToolsDeps {
  goalManager: GoalManager;
  /** Owns atomic turn authorization for every model-triggered Goal mutation. */
  goalContinuation: Pick<
    GoalContinuationCoordinator,
    'activateGoal' | 'mutateGoal' | 'activationStanding' | 'mutationStanding'
  >;
  /** Current cumulative token count for a session (baseline for budget). */
  getTokenCount?: (sessionId: string) => number;
  /**
   * Reject new model-owned mutations while the enclosing authority drains.
   *
   * One-way by contract: once this returns false it must never return true
   * again. `GOAL_AUTHORITY_GONE` tells the model the door does not reopen.
   */
  isAvailable?: () => boolean;
  flush?: (sessionId: string) => Promise<void>;
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
        .max(GOAL_CONDITION_TEXT_LIMIT.codeUnits)
        .refine((value) => isGoalTextWithinLimit(value, GOAL_CONDITION_TEXT_LIMIT), {
          message: 'Goal condition exceeds its UTF-8 byte limit',
        })
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
    impl: async (input, ctx) => {
      if (deps.isAvailable?.() === false) return GOAL_AUTHORITY_GONE;
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
        // Nothing was mutated on this path, so asking now returns the same
        // answer the attempt acted on.
        const standing = deps.goalContinuation.activationStanding(ctx.sessionId, ctx.turnId);
        const cause = standing.kind === 'declined' ? standing.reason : 'goal_changed';
        return `Goal not set: ${declineAdvice(cause, GOAL_SET_TOOL_NAME)}`;
      }
      await deps.flush?.(ctx.sessionId);
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
    impl: async (_input, ctx) => {
      if (deps.isAvailable?.() === false) return GOAL_AUTHORITY_GONE;
      const current = deps.goalManager.get(ctx.sessionId);
      if (!current || TERMINAL_GOAL_STATUSES.has(current.status)) {
        return 'No active goal to clear.';
      }
      const goal = deps.goalContinuation.mutateGoal(ctx.sessionId, ctx.turnId, () => {
        return deps.goalManager.clear(ctx.sessionId)!;
      });
      if (!goal) {
        const standing = deps.goalContinuation.mutationStanding(ctx.sessionId, ctx.turnId);
        const cause = standing.kind === 'declined' ? standing.reason : 'goal_changed';
        return `Goal not cleared: ${declineAdvice(cause, GOAL_CLEAR_TOOL_NAME)}`;
      }
      await deps.flush?.(ctx.sessionId);
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
    impl: async (_input, ctx) => {
      if (deps.isAvailable?.() === false) return GOAL_AUTHORITY_GONE;
      const current = deps.goalManager.get(ctx.sessionId);
      if (!current || (current.status !== 'active' && current.status !== 'waiting')) {
        return 'No active goal to pause.';
      }
      const goal = deps.goalContinuation.mutateGoal(ctx.sessionId, ctx.turnId, () => {
        return deps.goalManager.pause(ctx.sessionId)!;
      });
      if (!goal) {
        const standing = deps.goalContinuation.mutationStanding(ctx.sessionId, ctx.turnId);
        const cause = standing.kind === 'declined' ? standing.reason : 'goal_changed';
        return `Goal not paused: ${declineAdvice(cause, GOAL_PAUSE_TOOL_NAME)}`;
      }
      await deps.flush?.(ctx.sessionId);
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
    impl: async (_input, ctx) => {
      if (deps.isAvailable?.() === false) return GOAL_AUTHORITY_GONE;
      if (deps.goalManager.get(ctx.sessionId)?.status !== 'paused') {
        return 'No paused goal to resume.';
      }
      const goal = deps.goalContinuation.activateGoal(ctx.sessionId, ctx.turnId, () => {
        return deps.goalManager.resume(ctx.sessionId)!;
      });
      if (!goal) {
        const standing = deps.goalContinuation.activationStanding(ctx.sessionId, ctx.turnId);
        const cause = standing.kind === 'declined' ? standing.reason : 'goal_changed';
        return `Goal not resumed: ${declineAdvice(cause, GOAL_RESUME_TOOL_NAME)}`;
      }
      await deps.flush?.(ctx.sessionId);
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
    impl: async (_input, ctx) => {
      await deps.flush?.(ctx.sessionId);
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
