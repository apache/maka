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

import type { NormalizedUsage } from './result.js';

export const WORKHUB_ROUTING_EVALUATION_SCHEMA_VERSION = 'maka.workhub.routing-eval.v2' as const;

export type WorkHubIntentAssessment =
  | { readonly kind: 'routing'; readonly mode: 'discuss' | 'execute' | 'create' | 'continue' }
  | { readonly kind: 'linked'; readonly operation: 'correct' | 'stop' | 'resume' }
  | { readonly kind: 'unclear' };

export type WorkHubRecallAssessment =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ranked' | 'ambiguous'; readonly candidateRefs: readonly string[] };

export type WorkHubRoutingOutcome =
  | { readonly kind: 'routing'; readonly disposition: 'answer_here' | 'create_new' | 'clarify' }
  | {
      readonly kind: 'routing';
      readonly disposition: 'delegate_existing';
      readonly candidateRef: string;
    }
  | { readonly kind: 'linked'; readonly operation: 'correct' | 'stop' | 'resume' };

export interface WorkHubRoutingCandidate {
  /** Request-scoped opaque identity. Stable Session ids are not evaluation/model input. */
  readonly candidateRef: string;
  readonly sessionName: string;
  readonly workspaceName: string;
  readonly state: 'active' | 'running' | 'waiting_for_user' | 'blocked' | 'aborted';
  readonly recency: 'today' | 'this_week' | 'older';
  readonly objective?: string;
  readonly recentOutcome?: string;
}

export interface WorkHubRoutingScenario {
  readonly id: string;
  readonly userText: string;
  readonly transcript: readonly {
    readonly role: 'user' | 'assistant';
    readonly text: string;
  }[];
  readonly expectedIntent: WorkHubIntentAssessment;
  readonly expectedRecallKind: WorkHubRecallAssessment['kind'];
  readonly acceptableCandidateRefs: readonly string[];
  readonly forbiddenCandidateRefs: readonly string[];
  readonly expectedOutcome: WorkHubRoutingOutcome;
  readonly risk: 'read_only' | 'workspace_write' | 'external_side_effect';
}

export interface WorkHubRoutingDataset {
  readonly schemaVersion: typeof WORKHUB_ROUTING_EVALUATION_SCHEMA_VERSION;
  readonly id: string;
  /** One frozen, privacy-filtered candidate snapshot shared by every arm. */
  readonly candidates: readonly WorkHubRoutingCandidate[];
  readonly scenarios: readonly WorkHubRoutingScenario[];
}

export interface WorkHubRoutingObservation {
  readonly intent: WorkHubIntentAssessment;
  readonly recall: WorkHubRecallAssessment;
  readonly outcome: WorkHubRoutingOutcome;
  readonly usage?: NormalizedUsage;
  readonly costUsd?: number;
}

/**
 * One evaluation arm. Adapters may call a real model or a deterministic
 * baseline, but they cannot receive Session ids or perform product effects.
 */
export interface WorkHubRoutingEvaluationArm {
  readonly id: string;
  evaluate(input: {
    readonly userText: string;
    readonly transcript: WorkHubRoutingScenario['transcript'];
    readonly candidates: WorkHubRoutingDataset['candidates'];
  }): Promise<WorkHubRoutingObservation>;
}

export interface WorkHubRoutingTrial {
  readonly id: string;
  readonly scenarioId: string;
  readonly armId: string;
  readonly repetition: number;
  readonly expectedIntent: WorkHubIntentAssessment;
  readonly actualIntent?: WorkHubIntentAssessment;
  readonly expectedOutcome: WorkHubRoutingOutcome;
  readonly actualOutcome?: WorkHubRoutingOutcome;
  readonly recall?: WorkHubRecallAssessment;
  readonly intentCorrect: boolean;
  readonly recallKindCorrect: boolean;
  readonly outcomeCorrect: boolean;
  readonly unsafeBind: boolean;
  readonly implicitCreate: boolean;
  readonly unnecessaryClarification: boolean;
  readonly latencyMs: number;
  readonly usage?: NormalizedUsage;
  readonly costUsd?: number;
  readonly failure?: 'arm_failed' | 'invalid_observation';
}

export interface WorkHubRoutingSummary {
  readonly armId: string;
  readonly repetitions: number;
  readonly scenarioCoverage: number;
  readonly intentAccuracy: number;
  readonly recallKindAccuracy: number;
  readonly recallAt1: number | null;
  readonly recallAt5: number | null;
  readonly meanReciprocalRank: number | null;
  readonly dispositionAccuracy: number;
  readonly targetAccuracy: number | null;
  readonly outcomeAccuracy: number;
  readonly unsafeBindCount: number;
  readonly implicitCreateCount: number;
  readonly unnecessaryClarificationCount: number;
  readonly failureCount: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  readonly usage: {
    readonly samples: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number;
  };
}

export interface WorkHubRoutingEvaluationReport {
  readonly schemaVersion: typeof WORKHUB_ROUTING_EVALUATION_SCHEMA_VERSION;
  readonly datasetId: string;
  readonly trials: readonly WorkHubRoutingTrial[];
  readonly summaries: readonly WorkHubRoutingSummary[];
}

/** Shared side-effect-free Policy used by every comparison arm. */
export function applyWorkHubRoutingPolicy(
  intent: WorkHubIntentAssessment,
  recall: WorkHubRecallAssessment,
): WorkHubRoutingOutcome {
  if (intent.kind === 'unclear') return { kind: 'routing', disposition: 'clarify' };
  if (intent.kind === 'linked') return { kind: 'linked', operation: intent.operation };
  if (intent.mode === 'discuss') return { kind: 'routing', disposition: 'answer_here' };
  if (intent.mode === 'create') return { kind: 'routing', disposition: 'create_new' };
  if (recall.kind === 'ranked' && recall.candidateRefs[0]) {
    return {
      kind: 'routing',
      disposition: 'delegate_existing',
      candidateRef: recall.candidateRefs[0],
    };
  }
  return { kind: 'routing', disposition: 'clarify' };
}

/** Run repeatable, side-effect-free comparisons over one frozen dataset. */
export async function runWorkHubRoutingEvaluation(input: {
  readonly dataset: WorkHubRoutingDataset;
  readonly arms: readonly WorkHubRoutingEvaluationArm[];
  readonly repetitions: number;
  readonly now?: () => number;
}): Promise<WorkHubRoutingEvaluationReport> {
  validateWorkHubRoutingDataset(input.dataset);
  const dataset = snapshotDataset(input.dataset);
  if (
    input.arms.length === 0 ||
    input.arms.some(({ id }) => !identifier(id)) ||
    new Set(input.arms.map(({ id }) => id)).size !== input.arms.length
  ) {
    throw new Error('WorkHub routing evaluation arms must be non-empty and unique');
  }
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 1) {
    throw new Error('WorkHub routing repetitions must be a positive integer');
  }
  const now = input.now ?? (() => performance.now());
  const trials: WorkHubRoutingTrial[] = [];
  for (const scenario of dataset.scenarios) {
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
      for (const arm of input.arms) {
        const startedAt = now();
        let observation: WorkHubRoutingObservation | undefined;
        let failure: WorkHubRoutingTrial['failure'];
        try {
          const candidateRefs = new Set(dataset.candidates.map(({ candidateRef }) => candidateRef));
          const result = await arm.evaluate({
            userText: scenario.userText,
            transcript: scenario.transcript,
            candidates: dataset.candidates,
          });
          if (!validObservation(result, candidateRefs)) failure = 'invalid_observation';
          else observation = result;
        } catch {
          failure = 'arm_failed';
        }
        const latencyMs = Math.max(0, now() - startedAt);
        const selected = selectedCandidateRef(observation?.outcome);
        trials.push({
          id: `${scenario.id}::${repetition}::${arm.id}`,
          scenarioId: scenario.id,
          armId: arm.id,
          repetition,
          expectedIntent: scenario.expectedIntent,
          ...(observation ? { actualIntent: observation.intent } : {}),
          expectedOutcome: scenario.expectedOutcome,
          ...(observation
            ? { actualOutcome: observation.outcome, recall: observation.recall }
            : {}),
          intentCorrect: observation
            ? sameIntent(observation.intent, scenario.expectedIntent)
            : false,
          recallKindCorrect: observation?.recall.kind === scenario.expectedRecallKind,
          outcomeCorrect: observation
            ? sameOutcome(observation.outcome, scenario.expectedOutcome)
            : false,
          unsafeBind: selected !== undefined && scenario.forbiddenCandidateRefs.includes(selected),
          implicitCreate:
            observation?.outcome.kind === 'routing' &&
            observation.outcome.disposition === 'create_new' &&
            !(
              scenario.expectedIntent.kind === 'routing' &&
              scenario.expectedIntent.mode === 'create'
            ),
          unnecessaryClarification:
            observation?.outcome.kind === 'routing' &&
            observation.outcome.disposition === 'clarify' &&
            !(
              scenario.expectedOutcome.kind === 'routing' &&
              scenario.expectedOutcome.disposition === 'clarify'
            ),
          latencyMs,
          ...(observation?.usage ? { usage: observation.usage } : {}),
          ...(observation?.costUsd === undefined ? {} : { costUsd: observation.costUsd }),
          ...(failure ? { failure } : {}),
        });
      }
    }
  }
  return {
    schemaVersion: WORKHUB_ROUTING_EVALUATION_SCHEMA_VERSION,
    datasetId: dataset.id,
    trials,
    summaries: input.arms.map((arm) =>
      summarize(
        arm.id,
        trials.filter(({ armId }) => armId === arm.id),
        dataset,
        input.repetitions,
      ),
    ),
  };
}

function snapshotDataset(dataset: WorkHubRoutingDataset): WorkHubRoutingDataset {
  return Object.freeze({
    ...dataset,
    candidates: Object.freeze(
      dataset.candidates.map((candidate) => Object.freeze({ ...candidate })),
    ),
    scenarios: Object.freeze(
      dataset.scenarios.map((scenario) =>
        Object.freeze({
          ...scenario,
          transcript: Object.freeze(
            scenario.transcript.map((message) => Object.freeze({ ...message })),
          ),
          expectedIntent: Object.freeze({ ...scenario.expectedIntent }),
          acceptableCandidateRefs: Object.freeze([...scenario.acceptableCandidateRefs]),
          forbiddenCandidateRefs: Object.freeze([...scenario.forbiddenCandidateRefs]),
          expectedOutcome: Object.freeze({ ...scenario.expectedOutcome }),
        }),
      ),
    ),
  });
}

export function validateWorkHubRoutingDataset(dataset: WorkHubRoutingDataset): void {
  if (dataset.schemaVersion !== WORKHUB_ROUTING_EVALUATION_SCHEMA_VERSION) {
    throw new Error('Unsupported WorkHub routing evaluation schema');
  }
  if (!identifier(dataset.id) || dataset.scenarios.length === 0) {
    throw new Error('WorkHub routing dataset must have an id and scenarios');
  }
  if (dataset.candidates.length > 32) throw new Error('Too many WorkHub routing candidates');
  const refs = dataset.candidates.map(({ candidateRef }) => candidateRef);
  if (refs.some((ref) => !identifier(ref)) || new Set(refs).size !== refs.length) {
    throw new Error('Invalid WorkHub routing candidate refs');
  }
  const known = new Set(refs);
  const scenarioIds = new Set<string>();
  for (const scenario of dataset.scenarios) {
    if (!identifier(scenario.id) || scenarioIds.has(scenario.id) || !scenario.userText.trim()) {
      throw new Error('WorkHub routing scenarios require unique ids and user text');
    }
    scenarioIds.add(scenario.id);
    const labels = [...scenario.acceptableCandidateRefs, ...scenario.forbiddenCandidateRefs];
    if (labels.some((ref) => !known.has(ref)) || new Set(labels).size !== labels.length) {
      throw new Error(`Invalid candidate labels in ${scenario.id}`);
    }
    const expected = selectedCandidateRef(scenario.expectedOutcome);
    if (expected !== undefined && !scenario.acceptableCandidateRefs.includes(expected)) {
      throw new Error(`Expected target is not acceptable in ${scenario.id}`);
    }
    if (
      scenario.expectedOutcome.kind === 'routing' &&
      scenario.expectedOutcome.disposition === 'create_new' &&
      !(scenario.expectedIntent.kind === 'routing' && scenario.expectedIntent.mode === 'create')
    ) {
      throw new Error(`Implicit creation expectation in ${scenario.id}`);
    }
    if (
      scenario.expectedOutcome.kind === 'linked' &&
      !(
        scenario.expectedIntent.kind === 'linked' &&
        scenario.expectedIntent.operation === scenario.expectedOutcome.operation
      )
    ) {
      throw new Error(`Linked intent and outcome disagree in ${scenario.id}`);
    }
    const recallApplies =
      scenario.expectedIntent.kind === 'routing' &&
      (scenario.expectedIntent.mode === 'execute' || scenario.expectedIntent.mode === 'continue');
    if (recallApplies !== (scenario.expectedRecallKind !== 'not_applicable')) {
      throw new Error(`Intent and recall applicability disagree in ${scenario.id}`);
    }
  }
}

function validObservation(
  value: WorkHubRoutingObservation,
  candidateRefs: ReadonlySet<string>,
): boolean {
  if (!validIntent(value.intent)) return false;
  if (!validRecall(value.recall, candidateRefs)) return false;
  if (requiresSessionRecall(value.intent) !== (value.recall.kind !== 'not_applicable'))
    return false;
  if (!validOutcome(value.outcome, candidateRefs)) return false;
  if (!sameOutcome(value.outcome, applyWorkHubRoutingPolicy(value.intent, value.recall)))
    return false;
  if (value.usage && !validUsage(value.usage)) return false;
  if (value.costUsd !== undefined && (!Number.isFinite(value.costUsd) || value.costUsd < 0)) {
    return false;
  }
  const selected = selectedCandidateRef(value.outcome);
  if (selected !== undefined && !candidateRefs.has(selected)) return false;
  if (value.outcome.kind === 'linked') {
    return value.intent.kind === 'linked' && value.intent.operation === value.outcome.operation;
  }
  return true;
}

function requiresSessionRecall(intent: WorkHubIntentAssessment): boolean {
  return intent.kind === 'routing' && (intent.mode === 'execute' || intent.mode === 'continue');
}

function validIntent(value: WorkHubIntentAssessment): boolean {
  if (value.kind === 'unclear') return Object.keys(value).length === 1;
  if (value.kind === 'routing') {
    return (
      Object.keys(value).length === 2 &&
      ['discuss', 'execute', 'create', 'continue'].includes(value.mode)
    );
  }
  return (
    value.kind === 'linked' &&
    Object.keys(value).length === 2 &&
    ['correct', 'stop', 'resume'].includes(value.operation)
  );
}

function validRecall(value: WorkHubRecallAssessment, allowed: ReadonlySet<string>): boolean {
  if (value.kind === 'not_applicable' || value.kind === 'none') {
    return Object.keys(value).length === 1;
  }
  return (
    (value.kind === 'ranked' || value.kind === 'ambiguous') &&
    (value.kind === 'ranked' ? value.candidateRefs.length > 0 : value.candidateRefs.length > 1) &&
    value.candidateRefs.length <= allowed.size &&
    new Set(value.candidateRefs).size === value.candidateRefs.length &&
    value.candidateRefs.every((ref) => allowed.has(ref))
  );
}

function validOutcome(value: WorkHubRoutingOutcome, allowed: ReadonlySet<string>): boolean {
  if (value.kind === 'linked') {
    return (
      Object.keys(value).length === 2 && ['correct', 'stop', 'resume'].includes(value.operation)
    );
  }
  if (value.disposition === 'delegate_existing') {
    return Object.keys(value).length === 3 && allowed.has(value.candidateRef);
  }
  return (
    Object.keys(value).length === 2 &&
    ['answer_here', 'create_new', 'clarify'].includes(value.disposition)
  );
}

function validUsage(usage: NormalizedUsage): boolean {
  return Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0);
}

function summarize(
  armId: string,
  trials: readonly WorkHubRoutingTrial[],
  dataset: WorkHubRoutingDataset,
  repetitions: number,
): WorkHubRoutingSummary {
  const scenarioById = new Map(dataset.scenarios.map((scenario) => [scenario.id, scenario]));
  const recallTrials = trials.flatMap((trial) => {
    const scenario = scenarioById.get(trial.scenarioId)!;
    return scenario.acceptableCandidateRefs.length > 0 && trial.recall
      ? [{ trial, acceptable: new Set(scenario.acceptableCandidateRefs) }]
      : [];
  });
  const ranks = recallTrials.map(({ trial, acceptable }) =>
    trial.recall?.kind === 'ranked' || trial.recall?.kind === 'ambiguous'
      ? trial.recall.candidateRefs.findIndex((ref) => acceptable.has(ref)) + 1
      : 0,
  );
  const usage = trials.flatMap((trial) => (trial.usage ? [trial.usage] : []));
  const routingTrials = trials.filter(({ expectedOutcome }) => expectedOutcome.kind === 'routing');
  const targetTrials = trials.flatMap((trial) => {
    const scenario = scenarioById.get(trial.scenarioId)!;
    return scenario.expectedOutcome.kind === 'routing' &&
      scenario.expectedOutcome.disposition === 'delegate_existing'
      ? [{ trial, acceptable: new Set(scenario.acceptableCandidateRefs) }]
      : [];
  });
  return {
    armId,
    repetitions,
    scenarioCoverage:
      new Set(trials.map(({ scenarioId }) => scenarioId)).size / dataset.scenarios.length,
    intentAccuracy: ratio(
      trials.filter(({ intentCorrect }) => intentCorrect).length,
      trials.length,
    ),
    recallKindAccuracy: ratio(
      trials.filter(({ recallKindCorrect }) => recallKindCorrect).length,
      trials.length,
    ),
    recallAt1:
      ranks.length === 0 ? null : ratio(ranks.filter((rank) => rank === 1).length, ranks.length),
    recallAt5:
      ranks.length === 0
        ? null
        : ratio(ranks.filter((rank) => rank > 0 && rank <= 5).length, ranks.length),
    meanReciprocalRank:
      ranks.length === 0
        ? null
        : ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / ranks.length,
    dispositionAccuracy: ratio(
      routingTrials.filter(({ expectedOutcome, actualOutcome }) =>
        sameRoutingDisposition(actualOutcome, expectedOutcome),
      ).length,
      routingTrials.length,
    ),
    targetAccuracy:
      targetTrials.length === 0
        ? null
        : ratio(
            targetTrials.filter(({ trial, acceptable }) => {
              const selected = selectedCandidateRef(trial.actualOutcome);
              return selected !== undefined && acceptable.has(selected);
            }).length,
            targetTrials.length,
          ),
    outcomeAccuracy: ratio(
      trials.filter(({ outcomeCorrect }) => outcomeCorrect).length,
      trials.length,
    ),
    unsafeBindCount: trials.filter(({ unsafeBind }) => unsafeBind).length,
    implicitCreateCount: trials.filter(({ implicitCreate }) => implicitCreate).length,
    unnecessaryClarificationCount: trials.filter(
      ({ unnecessaryClarification }) => unnecessaryClarification,
    ).length,
    failureCount: trials.filter(({ failure }) => failure !== undefined).length,
    latencyMs: {
      p50: percentile(
        trials.map(({ latencyMs }) => latencyMs),
        0.5,
      ),
      p95: percentile(
        trials.map(({ latencyMs }) => latencyMs),
        0.95,
      ),
    },
    usage: {
      samples: usage.length,
      inputTokens: sum(usage.map(({ inputTokens }) => inputTokens ?? 0)),
      outputTokens: sum(usage.map(({ outputTokens }) => outputTokens ?? 0)),
      totalTokens: sum(usage.map(({ totalTokens }) => totalTokens ?? 0)),
      costUsd: sum(trials.map(({ costUsd }) => costUsd ?? 0)),
    },
  };
}

function sameRoutingDisposition(
  actual: WorkHubRoutingOutcome | undefined,
  expected: WorkHubRoutingOutcome,
): boolean {
  return (
    actual?.kind === 'routing' &&
    expected.kind === 'routing' &&
    actual.disposition === expected.disposition
  );
}

function selectedCandidateRef(outcome: WorkHubRoutingOutcome | undefined): string | undefined {
  return outcome?.kind === 'routing' && outcome.disposition === 'delegate_existing'
    ? outcome.candidateRef
    : undefined;
}

function sameIntent(left: WorkHubIntentAssessment, right: WorkHubIntentAssessment): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOutcome(left: WorkHubRoutingOutcome, right: WorkHubRoutingOutcome): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(fraction * ordered.length) - 1] ?? 0;
}
