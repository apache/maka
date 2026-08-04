import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  PLAN_MAX_FILES_PER_STEP,
  PLAN_MAX_RISKS,
  PLAN_MAX_STEPS,
  PLAN_LIFECYCLE_REASON_MAX_BYTES,
  PLAN_PROJECTION_ITEM_MAX_BYTES,
  PLAN_STEP_TITLE_MAX_CHARS,
  PLAN_TEXT_MAX_BYTES,
  type PlanEvent,
  type PlanExecution,
  type PlanExecutionStep,
  type PlanProposal,
  type PlanSessionState,
  type PlanStepDefinition,
  isCanonicalPlanEntityId,
  isPlanProposalLifecycleAdmissible,
  planEncodedByteLength,
  worstCasePlanExecution,
} from '@maka/core/plan';

/**
 * Embedded Plan Mode predates the Host wire bounds. Keep its immutable event
 * history intact while projecting a deterministic, bounded state that the
 * Host and later strict mutations can consume.
 */
export function normalizeLegacyPlanEvent(event: PlanEvent, state: PlanSessionState): PlanEvent {
  if (event.operationFingerprint) return event;
  switch (event.type) {
    case 'plan_submitted':
      return { ...event, proposal: normalizeLegacyProposal(event.proposal) };
    case 'plan_approved':
      return { ...event, execution: normalizeLegacyExecution(event.execution) };
    case 'plan_progress_updated':
    case 'plan_execution_completed': {
      const execution = state.executions.find(
        (candidate) => candidate.executionId === event.executionId,
      );
      if (!execution) return event;
      const steps = fitLegacyExecutionSteps(event.steps, execution);
      return isDeepStrictEqual(steps, event.steps)
        ? event
        : { ...event, steps, legacyProjection: { truncated: true } };
    }
    case 'plan_abandoned': {
      const reason = legacyText(event.reason, PLAN_TEXT_MAX_BYTES);
      return reason === event.reason
        ? event
        : { ...event, reason, legacyProjection: { truncated: true } };
    }
    case 'plan_execution_cancelled':
    case 'plan_execution_interrupted': {
      const reason = legacyText(event.reason, PLAN_LIFECYCLE_REASON_MAX_BYTES);
      return reason === event.reason
        ? event
        : { ...event, reason, legacyProjection: { truncated: true } };
    }
    case 'plan_revision_requested':
    case 'plan_execution_resumed':
      return event;
  }
}

function normalizeLegacyProposal(proposal: PlanProposal): PlanProposal {
  const base = {
    ...proposal,
    title: legacyText(proposal.title, PLAN_TEXT_MAX_BYTES),
    ...(proposal.overview ? { overview: legacyText(proposal.overview, PLAN_TEXT_MAX_BYTES) } : {}),
    ...(proposal.risks
      ? {
          risks: proposal.risks
            .slice(0, PLAN_MAX_RISKS)
            .map((risk) => legacyText(risk, PLAN_TEXT_MAX_BYTES)),
        }
      : {}),
    steps: normalizeLegacyDefinitions(proposal.steps, PLAN_TEXT_MAX_BYTES),
  };
  const normalized = fitLegacyTextBudget(
    (textBytes) => ({
      ...base,
      title: legacyText(base.title, textBytes),
      steps: normalizeLegacyDefinitions(base.steps, textBytes),
      ...(base.overview ? { overview: legacyText(base.overview, textBytes) } : {}),
      ...(base.risks ? { risks: base.risks.map((risk) => legacyText(risk, textBytes)) } : {}),
    }),
    legacyProposalFits,
  );
  return isDeepStrictEqual(normalized, proposal)
    ? proposal
    : { ...normalized, legacyProjection: { truncated: true } };
}

function normalizeLegacyExecution(execution: PlanExecution): PlanExecution {
  const base = {
    ...execution,
    steps: normalizeLegacyExecutionSteps(execution.steps, PLAN_TEXT_MAX_BYTES),
  };
  const normalized = fitLegacyTextBudget(
    (textBytes) => ({
      ...base,
      steps: normalizeLegacyExecutionSteps(base.steps, textBytes),
      ...(base.cancelReason
        ? { cancelReason: legacyText(base.cancelReason, PLAN_LIFECYCLE_REASON_MAX_BYTES) }
        : {}),
      ...(base.interruptionReason
        ? {
            interruptionReason: legacyText(
              base.interruptionReason,
              PLAN_LIFECYCLE_REASON_MAX_BYTES,
            ),
          }
        : {}),
    }),
    legacyExecutionFits,
  );
  return isDeepStrictEqual(normalized, execution)
    ? execution
    : { ...normalized, legacyProjection: { truncated: true } };
}

function legacyProposalFits(proposal: PlanProposal): boolean {
  const marked = { ...proposal, legacyProjection: { truncated: true as const } };
  return (
    planEncodedByteLength({ kind: 'proposal', proposal: marked }) <=
      PLAN_PROJECTION_ITEM_MAX_BYTES && isPlanProposalLifecycleAdmissible(proposal)
  );
}

function fitLegacyExecutionSteps(
  steps: PlanExecutionStep[],
  execution: PlanExecution,
): PlanExecutionStep[] {
  const base = normalizeLegacyExecutionSteps(steps, PLAN_TEXT_MAX_BYTES);
  return fitLegacyTextBudget(
    (textBytes) => normalizeLegacyExecutionSteps(base, textBytes),
    (candidate) => legacyExecutionFits({ ...execution, steps: candidate }),
  );
}

function legacyExecutionFits(execution: PlanExecution): boolean {
  const marked = { ...execution, legacyProjection: { truncated: true as const } };
  const worst = {
    ...worstCasePlanExecution(execution, execution.executionId, Number.MAX_SAFE_INTEGER),
    legacyProjection: { truncated: true as const },
  };
  return (
    planEncodedByteLength({ kind: 'execution', execution: marked }) <=
      PLAN_PROJECTION_ITEM_MAX_BYTES &&
    planEncodedByteLength({
      kind: 'execution',
      execution: worst,
    }) <= PLAN_PROJECTION_ITEM_MAX_BYTES
  );
}

function normalizeLegacyExecutionSteps(
  steps: PlanExecutionStep[],
  textBytes: number,
): PlanExecutionStep[] {
  const definitions = normalizeLegacyDefinitions(steps, textBytes);
  return definitions.map((definition, index) => {
    const source = steps[index]!;
    return {
      ...definition,
      status: source.status,
      ...(source.note ? { note: legacyText(source.note, textBytes) } : {}),
      updatedAt: source.updatedAt,
    };
  });
}

function normalizeLegacyDefinitions(
  steps: PlanStepDefinition[],
  textBytes: number,
): PlanStepDefinition[] {
  const ids = canonicalLegacyStepIds(steps.map((step) => step.id));
  return steps.slice(0, PLAN_MAX_STEPS).map((step, index) => ({
    id: ids[index]!,
    title: legacyStepTitle(step.title, textBytes),
    description: legacyText(step.description, textBytes),
    ...(step.files
      ? {
          files: step.files
            .slice(0, PLAN_MAX_FILES_PER_STEP)
            .map((file) => legacyText(file, textBytes)),
        }
      : {}),
    ...(step.complexity ? { complexity: step.complexity } : {}),
  }));
}

function canonicalLegacyStepIds(ids: readonly string[]): string[] {
  const used = new Set<string>();
  return ids.slice(0, PLAN_MAX_STEPS).map((id, index) => {
    const normalized = id.trim();
    const base = isCanonicalPlanEntityId(normalized)
      ? normalized
      : `legacy-${createHash('sha256').update(normalized).digest('hex')}`;
    let candidate = base;
    let suffix = 0;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base.slice(0, 120)}-${index}-${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

function fitLegacyTextBudget<T>(
  project: (textBytes: number) => T,
  accepts: (candidate: T) => boolean,
): T {
  let low = 4;
  let high = PLAN_TEXT_MAX_BYTES;
  let best = project(low);
  if (!accepts(best)) throw new Error('Legacy Plan projection cannot be represented safely');
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = project(middle);
    if (accepts(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function legacyText(value: string, maxBytes: number): string {
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) return normalized;
  let result = '';
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function legacyStepTitle(value: string, maxBytes: number): string {
  return legacyText(
    Array.from(value.trim()).slice(0, PLAN_STEP_TITLE_MAX_CHARS).join(''),
    maxBytes,
  );
}
