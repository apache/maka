import { emptyTraceTotals, type SessionTrace, type TraceStep, type TraceTotals } from '@maka/core/session-trace';

/**
 * View model for the Inspector panel (#1625).
 *
 * Pure, so the panel's judgements — what counts as a gap worth showing, when a
 * cost may be rendered at all — are testable without a DOM. The panel itself
 * only lays these out.
 */
export interface InspectorStepRow {
  id: string;
  kind: TraceStep['kind'];
  /**
   * The identifier this row is about — a model id, a tool name. Absent when
   * the row has no identifier of its own and its kind IS the label; naming it
   * is the panel's job, in the reader's language, not this file's in English.
   */
  label?: string;
  /** Free text the trace already carries in words — an error message. */
  detail?: string;
  /** Why this call was made, when it was not the turn's own request. */
  callKind?: string;
  /** How a permission request was answered. */
  decision?: string;
  durationMs?: number;
  /** Retries beyond the first attempt of one logical call. */
  retries?: number;
  /**
   * The recovery decision that was actually recorded, structured rather than
   * pre-formatted so the panel owns the wording in the reader's language.
   */
  recovered?: 'completed' | 'parked';
  failed: boolean;
}

export interface InspectorTurnRow {
  turnId: string;
  /** 1-based position in the session's turn order — the display name. */
  index: number;
  durationMs: number;
  totals: TraceTotals;
  failed: boolean;
  failureCode?: string;
  steps: InspectorStepRow[];
}

export interface InspectorCoverageNotice {
  kind: 'partial' | 'absent';
  turnsMissing: number;
  turnsShort: number;
  unreadableRecords: number;
}

export interface InspectorPanelModel {
  turns: InspectorTurnRow[];
  totals: TraceTotals;
  /**
   * Present only when the trace itself reports a gap. A notice that always
   * shows is a notice nobody reads.
   */
  coverage?: InspectorCoverageNotice;
  /** True when there is nothing to draw — distinct from a trace with gaps. */
  empty: boolean;
}

export function deriveInspectorPanelModel(trace: SessionTrace | undefined): InspectorPanelModel {
  if (!trace) return { turns: [], totals: emptyTraceTotals(), empty: true };

  const turns = trace.turns.map<InspectorTurnRow>((turn, index) => ({
    turnId: turn.turnId,
    index: index + 1,
    durationMs: turn.durationMs,
    totals: turn.totals,
    failed: turn.failure !== undefined,
    ...(turn.failure?.code !== undefined ? { failureCode: turn.failure.code } : {}),
    steps: turn.steps.map((step) => toStepRow(step, turn.failure?.attributedToStepId)),
  }));

  const coverage = coverageNotice(trace);
  return {
    turns,
    totals: trace.totals,
    ...(coverage ? { coverage } : {}),
    // A session whose every record failed to decode has no turns *and* a gap to
    // report. Calling that empty would hide exactly what this panel exists to
    // surface, so a reported gap is never "nothing to trace".
    empty: turns.length === 0 && coverage === undefined,
  };
}

function toStepRow(step: TraceStep, attributedToStepId: string | undefined): InspectorStepRow {
  const failed =
    step.id === attributedToStepId ||
    (step.kind === 'tool' && step.status === 'failed') ||
    (step.kind === 'model_call' && step.status === 'failed') ||
    step.kind === 'error';

  if (step.kind === 'model_call') {
    return {
      id: step.id,
      kind: step.kind,
      label: step.modelId,
      // 'main' is what almost every call is, so printing it on every row says
      // nothing; a compaction or a title call beside it is the fact worth a
      // second column.
      ...(step.callKind !== 'main' ? { callKind: step.callKind } : {}),
      durationMs: step.durationMs,
      ...(step.attempts.length > 1 ? { retries: step.attempts.length - 1 } : {}),
      failed,
    };
  }
  if (step.kind === 'tool') {
    return {
      id: step.id,
      kind: step.kind,
      label: step.toolName,
      // The recovery that happened, never the policy every dispatch declares.
      ...(step.recovered ? { recovered: step.recovered.disposition } : {}),
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      failed,
    };
  }
  if (step.kind === 'permission') {
    return {
      id: step.id,
      kind: step.kind,
      ...(step.toolName !== undefined ? { label: step.toolName } : {}),
      decision: step.decision,
      failed: false,
    };
  }
  if (step.kind === 'compaction') {
    // No label and no detail: the kind is the whole fact. The checkpoint id is
    // an internal handle a reader cannot act on, and it is in the run ledger
    // for anyone who can.
    return { id: step.id, kind: step.kind, failed: false };
  }
  return { id: step.id, kind: step.kind, detail: step.message, failed: true };
}

function coverageNotice(trace: SessionTrace): InspectorCoverageNotice | undefined {
  const { coverage } = trace;
  if (coverage.modelCalls === 'none' || coverage.modelCalls === 'no_known_gap') return undefined;
  return {
    kind: coverage.modelCalls,
    turnsMissing: coverage.turnsMissingModelCalls.length,
    turnsShort: coverage.turnsWithFewerModelCallsThanSteps.length,
    unreadableRecords: coverage.unreadableRecords,
  };
}

