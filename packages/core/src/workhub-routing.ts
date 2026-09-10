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

export type WorkHubIntentAssessment =
  | { readonly kind: 'routing'; readonly mode: 'discuss' | 'execute' | 'create' | 'continue' }
  | { readonly kind: 'linked'; readonly operation: 'correct' | 'stop' | 'resume' }
  | { readonly kind: 'unclear' };

export type WorkHubRecallAssessment =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ranked' | 'ambiguous'; readonly candidateRefs: readonly string[] };

/** Durable advisory result. It never authorizes a Session mutation. */
export type WorkHubRoutingOutcome =
  | { readonly kind: 'routing'; readonly disposition: 'answer_here' | 'create_new' | 'clarify' }
  | {
      readonly kind: 'routing';
      readonly disposition: 'delegate_existing';
      readonly candidateRef: string;
    }
  | { readonly kind: 'linked'; readonly operation: 'correct' | 'stop' | 'resume' };

export type WorkHubRoutingDecision =
  | Exclude<WorkHubRoutingOutcome, { readonly disposition: 'delegate_existing' }>
  | {
      readonly kind: 'routing';
      readonly disposition: 'delegate_existing';
      readonly candidateSetId: string;
      readonly candidateRef: string;
    };

/** The only mapping from model assessments to a product routing decision. */
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

export function bindWorkHubRoutingDecision(
  outcome: WorkHubRoutingOutcome,
  candidateSetId?: string,
): WorkHubRoutingDecision {
  if (outcome.kind !== 'routing' || outcome.disposition !== 'delegate_existing') return outcome;
  if (!candidateSetId) return { kind: 'routing', disposition: 'clarify' };
  return { ...outcome, candidateSetId };
}

export function decodeWorkHubIntent(value: unknown): WorkHubIntentAssessment {
  const record = requireRecord(value);
  if (record.kind === 'unclear' && Object.keys(record).length === 1) return { kind: 'unclear' };
  if (
    record.kind === 'routing' &&
    Object.keys(record).length === 2 &&
    ['discuss', 'execute', 'create', 'continue'].includes(String(record.mode))
  ) {
    return { kind: 'routing', mode: record.mode as 'discuss' | 'execute' | 'create' | 'continue' };
  }
  if (
    record.kind === 'linked' &&
    Object.keys(record).length === 2 &&
    ['correct', 'stop', 'resume'].includes(String(record.operation))
  ) {
    return { kind: 'linked', operation: record.operation as 'correct' | 'stop' | 'resume' };
  }
  throw new Error('Invalid WorkHub model intent');
}

export function decodeWorkHubRecall(
  value: unknown,
  allowedCandidateRefs: ReadonlySet<string>,
): WorkHubRecallAssessment {
  const record = requireRecord(value);
  if (record.kind === 'none' && Object.keys(record).length === 1) return { kind: 'none' };
  if (
    (record.kind === 'ranked' || record.kind === 'ambiguous') &&
    Object.keys(record).length === 2 &&
    Array.isArray(record.candidateRefs) &&
    record.candidateRefs.length <= allowedCandidateRefs.size &&
    record.candidateRefs.every((ref) => typeof ref === 'string' && allowedCandidateRefs.has(ref)) &&
    new Set(record.candidateRefs).size === record.candidateRefs.length &&
    (record.kind === 'ranked' ? record.candidateRefs.length > 0 : record.candidateRefs.length > 1)
  ) {
    return { kind: record.kind, candidateRefs: record.candidateRefs as string[] };
  }
  throw new Error('Invalid WorkHub model recall');
}

export function workHubIntentRequiresRecall(intent: WorkHubIntentAssessment): boolean {
  return intent.kind === 'routing' && (intent.mode === 'execute' || intent.mode === 'continue');
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid WorkHub model output');
  }
  return value as Record<string, unknown>;
}
