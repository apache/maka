/**
 * Harbor's own agent-phase resolution rule, modelled once for the tests.
 *
 * Every producer of a Harbor job config publishes the agent phase across three
 * fields, and Harbor folds them together in `_resolve_timeout_sec` /
 * `_compute_agent_timeout_sec` (harbor/trial/trial.py):
 *
 *   base  = agent.override_timeout_sec or task.config.agent.timeout_sec
 *   phase = min(base, agent.max_timeout_sec or inf)
 *           * (agent_timeout_multiplier if not None else timeout_multiplier)
 *
 * Deadline assertions go through this rather than reading a field directly. A
 * settlement tail published on max_timeout_sec satisfies a field-shaped
 * assertion while folding straight back to the task's own declared timeout,
 * which is exactly how the window stayed unreachable while the tests were
 * green — on both producers, twice.
 *
 * It takes the whole config because the multiplier lives at job level and the
 * min() at agent level: a producer that gets one right and the other wrong
 * publishes the wrong phase, and only reading both catches it.
 */

export type HarborAgentEntry = {
  env: Record<string, string>;
  override_timeout_sec?: number | null;
  max_timeout_sec?: number | null;
};

/** The phase Harbor resolves for `config`'s single agent on a task declaring
 * `taskDeclaredSec`. Takes the producers' own untyped job-config shape so no
 * call site has to cast. Mirror any change to Harbor's rule here, not at a call
 * site — one drifting copy is how this class of bug survives a green suite. */
export function harborAgentPhaseSec(
  config: Record<string, unknown>,
  taskDeclaredSec: number,
): number {
  const agent = (config.agents as HarborAgentEntry[])[0]!;
  const multiplier =
    (config.agent_timeout_multiplier as number | null | undefined) ??
    (config.timeout_multiplier as number | undefined) ??
    1;
  return (
    Math.min(
      agent.override_timeout_sec ?? taskDeclaredSec,
      agent.max_timeout_sec ?? Number.POSITIVE_INFINITY,
    ) * multiplier
  );
}
