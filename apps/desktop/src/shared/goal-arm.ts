/**
 * What the renderer sends to arm a Goal.
 *
 * The Session is not here: it travels as the scoped IPC argument, so a
 * renderer-side Session id can never redirect the operation. Preload declares
 * this shape and the IPC validator refuses anything outside it, so both read
 * the one declaration instead of each keeping its own copy.
 */
export interface GoalArmRequest {
  readonly condition: string;
  readonly maxIterations?: number | null;
  readonly tokenBudget?: number | null;
}

export const GOAL_ARM_REQUEST_KEYS: readonly (keyof GoalArmRequest)[] = Object.freeze([
  'condition',
  'maxIterations',
  'tokenBudget',
]);
