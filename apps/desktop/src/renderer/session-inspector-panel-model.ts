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
  /** Primary label: tool name, model id, or the kind for structural steps. */
  label: string;
  detail?: string;
  durationMs?: number;
  /**
   * Absent when nothing priced this step. The panel renders "cost unavailable"
   * rather than `$0`, because a call nobody could price and a free call are
   * different facts.
   */
  costUsd?: number;
  status?: string;
  /** Retries beyond the first attempt of one logical call. */
  retries?: number;
  failed: boolean;
}

export interface InspectorTurnRow {
  turnId: string;
  startedAt: number;
  durationMs: number;
  totals: TraceTotals;
  failed: boolean;
  failureCode?: string;
  failureMessage?: string;
  /** The step the failure is attributed to, when the trace named one. */
  attributedToStepId?: string;
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

  const turns = trace.turns.map<InspectorTurnRow>((turn) => ({
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    durationMs: turn.durationMs,
    totals: turn.totals,
    failed: turn.failure !== undefined,
    ...(turn.failure?.code !== undefined ? { failureCode: turn.failure.code } : {}),
    ...(turn.failure?.message !== undefined ? { failureMessage: turn.failure.message } : {}),
    ...(turn.failure?.attributedToStepId !== undefined
      ? { attributedToStepId: turn.failure.attributedToStepId }
      : {}),
    steps: turn.steps.map((step) => toStepRow(step, turn.failure?.attributedToStepId)),
  }));

  return {
    turns,
    totals: trace.totals,
    ...(coverageNotice(trace) ? { coverage: coverageNotice(trace)! } : {}),
    empty: turns.length === 0,
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
      detail: step.callKind,
      durationMs: step.durationMs,
      ...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}),
      status: step.status,
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
      ...(step.recovered ? { detail: `recovered: ${step.recovered.disposition}` } : {}),
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      status: step.status,
      failed,
    };
  }
  if (step.kind === 'permission') {
    return {
      id: step.id,
      kind: step.kind,
      label: step.toolName ?? 'permission',
      detail: step.decision,
      failed: false,
    };
  }
  if (step.kind === 'compaction') {
    return {
      id: step.id,
      kind: step.kind,
      label: 'compaction',
      ...(step.checkpointId !== undefined ? { detail: step.checkpointId } : {}),
      failed: false,
    };
  }
  return { id: step.id, kind: step.kind, label: 'error', detail: step.message, failed: true };
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

