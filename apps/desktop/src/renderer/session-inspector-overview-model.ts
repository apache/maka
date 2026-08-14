import type {
  ContextDiagnosticsResult,
  ContextDiagnosticsSegment,
} from '@maka/runtime-host/protocol';
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

/**
 * One row of "what was this prompt made of", sized in bytes and estimated in
 * tokens (#2323).
 *
 * The estimate is made HERE, at the display layer, and never enters the trace:
 * `bytes / 4` is a rule of thumb over serialized JSON, and a figure that has
 * been rounded into the contract can no longer be labelled as an estimate where
 * it is shown. The panel prints every one of these with a `≈`.
 */
export interface InspectorCompositionRow {
  estimatedTokens: number;
}

export interface InspectorCompositionPart extends InspectorCompositionRow {
  kind: ContextDiagnosticsSegment['kind'];
}

export interface InspectorCompositionTool extends InspectorCompositionRow {
  name: string;
}

export interface InspectorComposition {
  parts: readonly InspectorCompositionPart[];
  /** The largest tool schemas, largest first — the ones worth removing. */
  tools: readonly InspectorCompositionTool[];
  /**
   * Everything below the visible tools, folded rather than dropped.
   *
   * The BYTES add up: this row plus the visible ones equal the tool total. The
   * token column does not, and cannot — each row is rounded up on its own, so
   * a sum of estimates is not the estimate of the sum. That is why every
   * figure carries `≈` and none of them is presented as a subtotal.
   */
  remainingTools?: { count: number; estimatedTokens: number };
  /** Tool schemas the payload did not name; counted, never attributed. */
  unlabelledTools?: { estimatedTokens: number };
}

/**
 * Composition of the same request the bar measures, or the reason there is
 * none.
 *
 * `unrecorded` is a real answer, not an empty one: metering is durable and the
 * capture carrying the segments is best-effort, so a metered call with no
 * breakdown on record happens, and rendering it as a prompt made of nothing
 * would be the fabrication the ledger rules exist to prevent (#1679).
 */
export type InspectorCompositionState =
  | { status: 'available'; composition: InspectorComposition }
  | { status: 'unrecorded' };

export interface InspectorOverviewModel {
  /** Absent when no completed main call reported both usage and a window. */
  context?: InspectorContextBudget;
  /**
   * What filled the context, from the Host operation that owns that question.
   *
   * Independent of `context` above, and that independence is the fix for a
   * real hole: the bar needs a `contextWindow` to have a denominator, so a
   * provider that reports usage without one used to take the whole section
   * down with it. The snapshot answers on its own terms — a request with no
   * window still explains itself, and a request with no capture says
   * `unrecorded` instead of vanishing.
   */
  composition?: InspectorCompositionState;
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

/**
 * The overview reads two owners, and keeps them apart.
 *
 * The trace answers what happened and what it cost. The context snapshot
 * answers what the context holds right now — its own Host operation, the one
 * `/context` prints (#1580, #2323). Neither is derived from the other, so a
 * session with a trace and no snapshot still shows its history, and a snapshot
 * with no trace still sizes the window.
 */
export function deriveInspectorOverviewModel(
  trace: SessionTrace | undefined,
  diagnostics?: ContextDiagnosticsResult,
): InspectorOverviewModel {
  // Both halves of the context block come from the SAME snapshot. They used to
  // be picked separately — the bar from the latest trace attempt that carried a
  // window, the breakdown from the latest diagnostics — so a newest call
  // without a window put one request's fullness above another request's
  // contents. One source cannot disagree with itself (#2323).
  const composition = compositionState(diagnostics);
  const context = contextBudget(diagnostics);
  if (!trace || trace.turns.length === 0) {
    return {
      ...(context ? { context } : {}),
      ...(composition ? { composition } : {}),
    };
  }

  const modelSteps = trace.turns.flatMap(modelCallSteps);
  const cacheHitRate = sessionCacheHitRate(modelSteps.flatMap((step) => step.attempts));

  return {
    ...(context ? { context } : {}),
    ...(composition ? { composition } : {}),
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
 * now" — answered by the snapshot's own metered prompt against the window that
 * same call ran under. Absent when the provider reported no prompt, or no
 * window to measure it against: a bar with no denominator is not a bar.
 */
function contextBudget(
  diagnostics: ContextDiagnosticsResult | undefined,
): InspectorContextBudget | undefined {
  if (!diagnostics || diagnostics.status !== 'available') return undefined;
  const usedTokens = diagnostics.inputTokens;
  const windowTokens = diagnostics.contextWindow;
  if (usedTokens === undefined || windowTokens === undefined || windowTokens <= 0) return undefined;
  // A cache figure larger than the prompt it belongs to is not a fact about
  // the window, so it is clamped rather than allowed to push `fresh` negative.
  const cacheRead =
    diagnostics.cacheReadInputTokens !== undefined
      ? Math.min(diagnostics.cacheReadInputTokens, usedTokens)
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

/**
 * How many tool rows are worth showing.
 *
 * The list exists so a reader can name a tool to remove, and that decision is
 * made off the biggest few; a full registry printed at 4pt is a table, not an
 * answer. What falls below the cut is folded into one row rather than dropped,
 * so the parts still add up to the tool total above them.
 */
const VISIBLE_TOOL_ROWS = 5;

function compositionState(
  diagnostics: ContextDiagnosticsResult | undefined,
): InspectorCompositionState | undefined {
  // No snapshot at all is not a state to render: there is nothing to ask about
  // yet. A snapshot that reports no request is the same — the panel's empty
  // state already covers a session that has not run.
  if (!diagnostics || diagnostics.status !== 'available') return undefined;
  const composition = diagnostics.composition;
  // A request the durable record names but no capture explains. Stated, so the
  // reader knows the breakdown is missing rather than the prompt being empty.
  if (!composition) return { status: 'unrecorded' };

  const tools = composition.tools ?? [];
  const visible = tools.slice(0, VISIBLE_TOOL_ROWS);
  const hidden = tools.slice(VISIBLE_TOOL_ROWS);
  // The Host already folded everything past ITS cap into `remainingTools`, so
  // the panel's remainder is the locally hidden rows PLUS that fold. Counting
  // only the local ones silently dropped every tool beyond the Host's 64 —
  // 236 of them, and their bytes, on a 300-tool session (#2323).
  const producerRemainder = composition.remainingTools;
  const remainingCount = hidden.length + (producerRemainder?.count ?? 0);
  const remainingBytes =
    hidden.reduce((carry, tool) => carry + tool.bytes, 0) + (producerRemainder?.bytes ?? 0);

  return {
    status: 'available',
    composition: {
      parts: composition.segments.map((part) => ({
        kind: part.kind,
        estimatedTokens: estimateTokens(part.bytes),
      })),
      tools: visible.map((tool) => ({
        name: tool.name,
        estimatedTokens: estimateTokens(tool.bytes),
      })),
      ...(remainingCount > 0
        ? {
            remainingTools: {
              count: remainingCount,
              estimatedTokens: estimateTokens(remainingBytes),
            },
          }
        : {}),
      ...(composition.unlabelledToolBytes !== undefined
        ? { unlabelledTools: { estimatedTokens: estimateTokens(composition.unlabelledToolBytes) } }
        : {}),
    },
  };
}

/**
 * The same four-bytes-per-token rule of thumb `/context` prints, kept at the
 * display layer and rendered with a `≈` everywhere it appears. It is not a
 * count: the bytes it divides are serialized JSON, and an attachment's base64
 * makes it wrong in a direction nobody can correct for here.
 */
function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function sum(attempts: readonly TraceModelAttempt[], pick: (attempt: TraceModelAttempt) => number | undefined): number {
  return attempts.reduce((carry, attempt) => carry + (pick(attempt) ?? 0), 0);
}
