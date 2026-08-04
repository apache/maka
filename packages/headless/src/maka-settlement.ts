/**
 * The one rule for how long a benchmark arm runs.
 *
 * MAKA_CELL_TIMEOUT_SEC is the model budget on every path — the seconds an arm
 * may spend calling the model, and the only number that has to be identical
 * across arms for the comparison to mean anything. The Maka cell alone then
 * stops calling the model and settles its artifacts, so its agent phase is one
 * settlement window longer. Native CLIs have nothing to settle and are killed at
 * the budget itself.
 *
 * Every producer of a Harbor or Pier agent phase resolves it here. Producing it
 * anywhere else is how the smoke harness ended up killing the cell at the exact
 * moment it began writing.
 */

import { lenientPositiveIntEnv } from './headless-run-env.js';

/** Wall-clock the Maka cell reserves to settle artifacts after it stops calling
 * the model. Executor-independent: both runners bound model time the same way. */
export const MAKA_SETTLEMENT_GRACE_SEC = 30;

/** Seconds this arm spends settling after its model budget runs out. Only the
 * Maka cell has such a window; native CLIs run until the executor cancels them.
 * An operator may widen it; the agent phase widens with it. */
export function settlementGraceSec(
  adapter: string,
  agentEnv: Record<string, string> | undefined,
): number {
  if (adapter !== 'maka') return 0;
  return (
    lenientPositiveIntEnv(agentEnv?.MAKA_CELL_SETTLEMENT_GRACE_SEC) ?? MAKA_SETTLEMENT_GRACE_SEC
  );
}

/** The deadline the executor must kill at: the model budget plus whatever this
 * arm needs to settle. Killing at the model budget instead cuts the cell off at
 * the instant it starts writing, which reads as an infra failure rather than a
 * scored result. */
export function agentPhaseTimeoutSec(
  adapter: string,
  agentEnv: Record<string, string> | undefined,
  modelBudgetSec: number,
): number {
  return modelBudgetSec + settlementGraceSec(adapter, agentEnv);
}
