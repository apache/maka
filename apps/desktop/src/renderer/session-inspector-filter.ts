import type { InspectorPanelModel, InspectorStepRow, InspectorTurnRow } from './session-inspector-panel-model.js';

/**
 * Filtering the Inspector timeline (#1625).
 *
 * Pure predicates over the projected trace, deliberately not a query API on the
 * contract: the questions a reader brings to a trace are `Array.filter` over
 * `TraceStep[]`, and inventing a query language for them would be surface
 * nobody needs.
 *
 * Two predicates, because they are the two the panel can produce. Kind and cost
 * filters are easy to write here and were, but a predicate no control emits is
 * dead surface with tests that guard nothing; they come back when the controls
 * that drive them are designed.
 *
 * Free text matches what each row renders — the step kind, its label, its
 * detail, its recovery disposition — plus the turn's own id, matched against
 * the turn. It deliberately does **not** reach into event bodies: that is
 * `searchRuntimeEventHistory`'s job, and shipping every tool result into the
 * renderer to imitate it would multiply a payload this panel is already asked
 * to bound, with silent truncation as the only way out. A filter that quietly
 * stops matching is worse than one with a stated reach.
 */
export interface InspectorFilter {
  /** Case-insensitive substring over the fields each row renders. */
  query?: string;
  /** Only turns that failed. */
  failedOnly?: boolean;
}

export interface FilteredInspectorModel extends InspectorPanelModel {
  /**
   * Whether a filter is narrowing the view. Kept separate from `empty` so the
   * panel can say "nothing matches" instead of "nothing happened" — a filtered
   * timeline that reads as an idle session is the same lie as an unreported
   * coverage gap, one layer up.
   */
  filtered: boolean;
  /** Turns present in the trace but hidden by the filter. */
  hiddenTurns: number;
  /** Steps hidden inside the turns that still render. */
  hiddenSteps: number;
}

export function isEmptyInspectorFilter(filter: InspectorFilter | undefined): boolean {
  if (!filter) return true;
  return !filter.query?.trim() && !filter.failedOnly;
}

export function applyInspectorFilter(
  model: InspectorPanelModel,
  filter: InspectorFilter | undefined,
): FilteredInspectorModel {
  if (isEmptyInspectorFilter(filter)) {
    return { ...model, filtered: false, hiddenTurns: 0, hiddenSteps: 0 };
  }
  const active = filter!;
  const query = active.query?.trim().toLowerCase();

  let hiddenSteps = 0;
  const turns: InspectorTurnRow[] = [];
  for (const turn of model.turns) {
    if (active.failedOnly && !turn.failed) continue;
    const steps = turn.steps.filter((step) => matchesStep(step, query));
    // A turn with no matching step is still kept when the filter is about the
    // turn itself: its id matched, or there is no text query at all and it
    // already passed the outcome gate above. Dropping it would answer "where is
    // turn-7" — or "show me what failed", for a turn that failed before it
    // recorded a step — with silence.
    const turnMatches = query === undefined ? true : turn.turnId.toLowerCase().includes(query);
    if (steps.length === 0 && !turnMatches) continue;
    hiddenSteps += turn.steps.length - steps.length;
    turns.push({ ...turn, steps });
  }

  return {
    ...model,
    turns,
    filtered: true,
    hiddenTurns: model.turns.length - turns.length,
    hiddenSteps,
    // `empty` stays a statement about the session, not about the filter. The
    // panel distinguishes the two; collapsing them here would make a narrow
    // filter indistinguishable from an empty session.
    empty: model.empty,
  };
}

function matchesStep(step: InspectorStepRow, query: string | undefined): boolean {
  // The turn-level gate is applied by the caller; repeating it here would be a
  // second place to keep in step with it.
  if (query === undefined || query === '') return true;
  return stepSearchText(step).includes(query);
}

/**
 * Exactly the fields this row renders — the filter's reach is what you see.
 *
 * Turn-level text is deliberately absent: folding a turn's failure message into
 * every step's haystack would make one match retain steps that explain nothing
 * about it. The turn's own id is matched against the turn, where it belongs.
 */
function stepSearchText(step: InspectorStepRow): string {
  return [step.kind, step.label, step.detail, step.recovered]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}
