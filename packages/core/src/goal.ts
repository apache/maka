export const GOAL_STATUSES = [
  'active',
  'waiting',
  'achieved',
  'impossible',
  'cleared',
  'paused',
  'stalled',
  'budget_limited',
  'max_iterations',
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === 'string' && (GOAL_STATUSES as readonly string[]).includes(value);
}

export interface GoalTextLimit {
  readonly codeUnits: number;
  readonly utf8Bytes: number;
}

/** Shared boundary for a Goal condition in model tools and Host projections. */
export const GOAL_CONDITION_TEXT_LIMIT: GoalTextLimit = Object.freeze({
  codeUnits: 500,
  utf8Bytes: 1_500,
});

/** Shared boundary for evaluator and lifecycle diagnostics. */
export const GOAL_REASON_TEXT_LIMIT: GoalTextLimit = Object.freeze({
  codeUnits: 500,
  utf8Bytes: 1_500,
});
