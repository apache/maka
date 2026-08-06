import type {
  SessionTrace,
  TraceModelAttempt,
  TraceModelCallStep,
  TurnTrace,
} from '@maka/core/session-trace';

/**
 * Overview view model for the Inspector panel's summary sections.
 *
 * Pure, for the same reason `deriveInspectorPanelModel` is: every judgement
 * about what a number means is testable without a DOM, and the panel only lays
 * the result out. Nothing is derived that the trace does not carry — a session
 * whose backend reports no usage shows its structure and says so, rather than
 * fabricating zeros (#1625, #1679).
 */

/**
 * One band of the context window.
 *
 * `cacheRead` + `fresh` split the prompt by what the provider served from its
 * cache; `used` is the same prompt left whole because the provider reported no
 * cache figure — an unsplit bar, not a bar that claims a zero cache hit.
 * `free` is the headroom left in the window.
 */
export type InspectorContextSegmentKind = 'cacheRead' | 'fresh' | 'used' | 'free';

export interface InspectorContextSegment {
  kind: InspectorContextSegmentKind;
  tokens: number;
}

/** The prompt size of the most recent metered call, against its own ceiling. */
export interface InspectorContextBudget {
  usedTokens: number;
  /** The window the call was metered against, frozen at call time. */
  windowTokens: number;
  /** usedTokens / windowTokens; the panel clamps for display, not here. */
  ratio: number;
  /**
   * The window broken into bands, in reading order and with empty bands
   * dropped, so the bar and its legend cannot disagree about what is drawn.
   */
  segments: readonly InspectorContextSegment[];
}

export interface InspectorOverviewModel {
  /** Absent when no completed main call reported both usage and a window. */
  context?: InspectorContextBudget;
  /**
   * cacheRead / input over the attempts that reported input, session-wide.
   * Absent when no input was metered at all — a rate over nothing is not
   * zero, it is unknown.
   *
   * The only token figure the panel keeps. The raw totals it used to carry
   * were priced by `totals.costUsd`, sized by the context bar and audited in
   * the run ledger; three statements of the same tokens is two too many.
   */
  cacheHitRate?: number;
}

export function deriveInspectorOverviewModel(trace: SessionTrace | undefined): InspectorOverviewModel {
  if (!trace || trace.turns.length === 0) return {};

  const modelSteps = trace.turns.flatMap(modelCallSteps);
  const cacheHitRate = sessionCacheHitRate(modelSteps.flatMap((step) => step.attempts));
  const context = contextBudget(modelSteps);

  return {
    ...(context ? { context } : {}),
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
  };
}

function modelCallSteps(turn: TurnTrace): TraceModelCallStep[] {
  return turn.steps.filter((step): step is TraceModelCallStep => step.kind === 'model_call');
}

/**
 * Summed over the attempts that reported input, and undefined when none did:
 * a rate over nothing is unknown, not zero, the same way "did not report" and
 * "reported none" stay apart in the ledger (#1679).
 *
 * An input-reported attempt without a cache figure reads as a miss, because
 * the providers that cache always count the hits.
 *
 * Each attempt's cache read is clamped to its own prompt, the same way the
 * context bar clamps it: a provider can report more cache than prompt — the
 * runtime's Google mapping guards against exactly that — and a share of a
 * prompt over 100% is not a fact, it is corruption wearing a percent sign.
 */
function sessionCacheHitRate(attempts: readonly TraceModelAttempt[]): number | undefined {
  const input = attempts.filter((attempt) => attempt.inputTokens !== undefined);
  const inputTokens = sum(input, (attempt) => attempt.inputTokens);
  if (inputTokens === 0) return undefined;
  return sum(input, (attempt) => Math.min(attempt.cacheReadInputTokens ?? 0, attempt.inputTokens!)) / inputTokens;
}

/**
 * The budget question a reader actually asks — "how full is the context right
 * now" — is answered by the most recent completed call whose provider counted
 * a prompt: its input total IS the context size the next call builds on.
 */
function contextBudget(steps: readonly TraceModelCallStep[]): InspectorContextBudget | undefined {
  const candidates = steps
    .filter((step) => step.callKind === 'main')
    .flatMap((step) => step.attempts)
    .filter(
      (attempt) =>
        attempt.status === 'completed' &&
        attempt.inputTokens !== undefined &&
        attempt.contextWindow !== undefined &&
        attempt.contextWindow > 0,
    );
  const latest = candidates.reduce<TraceModelAttempt | undefined>(
    (carry, attempt) => (carry === undefined || attempt.completedAt >= carry.completedAt ? attempt : carry),
    undefined,
  );
  if (!latest) return undefined;
  const usedTokens = latest.inputTokens!;
  const windowTokens = latest.contextWindow!;
  // A cache figure larger than the prompt it belongs to is not a fact about
  // the window, so it is clamped rather than allowed to push `fresh` negative.
  const cacheRead =
    latest.cacheReadInputTokens !== undefined
      ? Math.min(latest.cacheReadInputTokens, usedTokens)
      : undefined;
  const prompt: { kind: InspectorContextSegmentKind; tokens: number }[] =
    cacheRead === undefined
      ? [{ kind: 'used', tokens: usedTokens }]
      : [
          { kind: 'cacheRead', tokens: cacheRead },
          { kind: 'fresh', tokens: usedTokens - cacheRead },
        ];
  return {
    usedTokens,
    windowTokens,
    ratio: usedTokens / windowTokens,
    segments: [
      ...prompt,
      { kind: 'free' as const, tokens: Math.max(0, windowTokens - usedTokens) },
    ].filter((segment) => segment.tokens > 0),
  };
}

function sum(attempts: readonly TraceModelAttempt[], pick: (attempt: TraceModelAttempt) => number | undefined): number {
  return attempts.reduce((carry, attempt) => carry + (pick(attempt) ?? 0), 0);
}
