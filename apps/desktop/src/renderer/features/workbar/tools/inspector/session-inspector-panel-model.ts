/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  type SessionTrace,
  type TraceModelCallStep,
  type TraceStep,
} from '@maka/core/session-trace';
import { pricingModelKey } from '@maka/core/usage-stats/pricing';
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
  /** Concise supporting detail — a trace error message or bounded provider facts. */
  detail?: string;
  /** Why this call was made, when it was not the turn's own request. */
  callKind?: string;
  /** How a permission request was answered. */
  decision?: string;
  durationMs?: number;
  /** Retries beyond the first attempt of one logical call. */
  retries?: number;
  /** Exact Runtime pricing lookup key, exposed only when an attempt was unpriced. */
  unpricedPricingKey?: string;
  /**
   * The recovery decision that was actually recorded, structured rather than
   * pre-formatted so the panel owns the wording in the reader's language.
   */
  recovered?: 'completed' | 'parked';
  failed: boolean;
}

export interface InspectorTurnRow {
  runId: string;
  turnId: string;
  startedAt: number;
  durationMs: number;
  costUsd?: number;
  failed: boolean;
  failureCode?: string;
  steps: InspectorStepRow[];
}

export interface InspectorCoverageNotice {
  kind: 'partial' | 'absent';
  turnsMissing: number;
  turnsShort: number;
  unreadableRecords: number;
  oversizedRuns: number;
}

export interface InspectorPanelModel {
  turns: InspectorTurnRow[];
  /**
   * Present only when the trace itself reports a gap. A notice that always
   * shows is a notice nobody reads.
   */
  coverage?: InspectorCoverageNotice;
  /** True when there is nothing to draw — distinct from a trace with gaps. */
  empty: boolean;
}

export function deriveInspectorPanelModel(trace: SessionTrace | undefined): InspectorPanelModel {
  if (!trace) return { turns: [], empty: true };

  const turns = trace.turns.map<InspectorTurnRow>((turn) => {
    const costUsd = deriveTurnCostUsd(turn.steps);
    return {
      runId: turn.runId,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      durationMs: turn.durationMs,
      ...(costUsd !== undefined ? { costUsd } : {}),
      failed: turn.failure !== undefined,
      ...(turn.failure?.code !== undefined ? { failureCode: turn.failure.code } : {}),
      steps: turn.steps.map((step) => toStepRow(step, turn.failure?.attributedToStepId)),
    };
  });

  const coverage = coverageNotice(trace);
  return {
    turns,
    ...(coverage ? { coverage } : {}),
    // A session whose every record failed to decode has no turns *and* a gap to
    // report. Calling that empty would hide exactly what this panel exists to
    // surface, so a reported gap is never "nothing to trace".
    empty: turns.length === 0 && coverage === undefined,
  };
}

function deriveTurnCostUsd(steps: readonly TraceStep[]): number | undefined {
  let total: number | undefined;
  for (const step of steps) {
    if (step.kind === 'model_call' && step.costUsd !== undefined) {
      total = (total ?? 0) + step.costUsd;
    }
  }
  return total;
}

function toStepRow(step: TraceStep, attributedToStepId: string | undefined): InspectorStepRow {
  const failed =
    step.id === attributedToStepId ||
    (step.kind === 'tool' && step.status === 'failed') ||
    (step.kind === 'model_call' && step.status === 'failed') ||
    step.kind === 'error';

  if (step.kind === 'model_call') {
    const detail = historyCompactDiagnosticDetail(step);
    return {
      id: step.id,
      kind: step.kind,
      label: step.modelId,
      // 'main' is what almost every call is, so printing it on every row says
      // nothing; a compaction or a title call beside it is the fact worth a
      // second column.
      ...(step.callKind !== 'main' ? { callKind: step.callKind } : {}),
      ...(detail !== undefined ? { detail } : {}),
      durationMs: step.durationMs,
      ...(step.attempts.length > 1 ? { retries: step.attempts.length - 1 } : {}),
      ...(step.attempts.some((attempt) => attempt.costBasis === 'unpriced')
        ? { unpricedPricingKey: pricingModelKey(step.providerId, step.modelId) }
        : {}),
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

/** Compact, body-free provider facts for the one auxiliary call that needs diagnosis. */
function historyCompactDiagnosticDetail(step: TraceModelCallStep): string | undefined {
  if (step.callKind !== 'history_compact') return undefined;
  const settled = step.attempts.at(-1);
  const parts = [
    step.historyCompactRoute !== undefined ? `route=${step.historyCompactRoute}` : undefined,
    settled?.errorClass !== undefined ? `error=${settled.errorClass}` : undefined,
    settled?.httpStatus !== undefined ? `HTTP ${settled.httpStatus}` : undefined,
    settled?.providerCode !== undefined ? `code=${settled.providerCode}` : undefined,
    settled?.providerRequestId !== undefined ? `request=${settled.providerRequestId}` : undefined,
    settled?.retryable !== undefined ? `retryable=${settled.retryable}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function coverageNotice(trace: SessionTrace): InspectorCoverageNotice | undefined {
  const { coverage } = trace;
  if (coverage.modelCalls === 'none' || coverage.modelCalls === 'no_known_gap') return undefined;
  return {
    kind: coverage.modelCalls,
    turnsMissing: coverage.turnsMissingModelCalls.length,
    turnsShort: coverage.turnsWithFewerModelCallsThanSteps.length,
    unreadableRecords: coverage.unreadableRecords,
    oversizedRuns: coverage.oversizedRuns,
  };
}
