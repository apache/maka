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

export const TOOL_RECONCILE_RESULT_FACT_KIND = 'maka.tool.reconcile_result' as const;
export const TOOL_RECOVERY_DECISION_FACT_KIND = 'maka.tool.recovery_decision' as const;
export const TOOL_RECOVERY_FACT_VERSION = 1 as const;

export type ToolReconcileObservation =
  | 'matches_expected_state'
  | 'matches_prior_state'
  | 'diverged'
  | 'unreadable';

export interface ToolReconcileResultFact {
  protocol: 'tool_reconcile_v1';
  operationId: string;
  observation: ToolReconcileObservation;
  observationSchema: 'state_identity_v1';
  observationDigest: `sha256:${string}`;
}

export type ToolRecoveryParkReason =
  | 'reconcile_matches_prior_state'
  | 'reconcile_diverged'
  | 'reconcile_unreadable';

export interface ToolRecoveryCompletedDecisionFact {
  protocol: 'tool_recovery_v1';
  operationId: string;
  disposition: 'completed';
  reasonCode: 'reconcile_matches_expected_state';
  outcomeEventId: string;
  evidenceEventIds: string[];
}

export interface ToolRecoveryParkedDecisionFact {
  protocol: 'tool_recovery_v1';
  operationId: string;
  disposition: 'parked';
  reasonCode: ToolRecoveryParkReason;
  evidenceEventIds: string[];
}

export type ToolRecoveryDecisionFact =
  | ToolRecoveryCompletedDecisionFact
  | ToolRecoveryParkedDecisionFact;

export type ToolRecoveryFactEnvelope =
  | {
      kind: typeof TOOL_RECONCILE_RESULT_FACT_KIND;
      version: typeof TOOL_RECOVERY_FACT_VERSION;
      payload: ToolReconcileResultFact;
    }
  | {
      kind: typeof TOOL_RECOVERY_DECISION_FACT_KIND;
      version: typeof TOOL_RECOVERY_FACT_VERSION;
      payload: ToolRecoveryDecisionFact;
    };

const PARK_REASONS = new Set<ToolRecoveryParkReason>([
  'reconcile_matches_prior_state',
  'reconcile_diverged',
  'reconcile_unreadable',
]);

export function isToolRecoveryFactEnvelope(value: unknown): value is ToolRecoveryFactEnvelope {
  if (!hasExactKeys(value, ['kind', 'version', 'payload'])) return false;
  if (value.version !== TOOL_RECOVERY_FACT_VERSION) return false;
  if (value.kind === TOOL_RECONCILE_RESULT_FACT_KIND) {
    return isToolReconcileResultFact(value.payload);
  }
  if (value.kind === TOOL_RECOVERY_DECISION_FACT_KIND) {
    return isToolRecoveryDecisionFact(value.payload);
  }
  return false;
}

export function isToolReconcileResultFact(value: unknown): value is ToolReconcileResultFact {
  if (
    !hasExactKeys(value, [
      'protocol',
      'operationId',
      'observation',
      'observationSchema',
      'observationDigest',
    ])
  ) {
    return false;
  }
  return (
    value.protocol === 'tool_reconcile_v1' &&
    isNonEmptyString(value.operationId) &&
    typeof value.observation === 'string' &&
    value.observationSchema === 'state_identity_v1' &&
    isSha256Digest(value.observationDigest) &&
    ['matches_expected_state', 'matches_prior_state', 'diverged', 'unreadable'].includes(
      value.observation,
    )
  );
}

export function isToolRecoveryDecisionFact(value: unknown): value is ToolRecoveryDecisionFact {
  if (
    !isRecord(value) ||
    value.protocol !== 'tool_recovery_v1' ||
    !isNonEmptyString(value.operationId) ||
    !isDistinctNonEmptyStringArray(value.evidenceEventIds)
  ) {
    return false;
  }
  if (value.disposition === 'completed') {
    return (
      hasExactKeys(value, [
        'protocol',
        'operationId',
        'disposition',
        'reasonCode',
        'outcomeEventId',
        'evidenceEventIds',
      ]) &&
      value.reasonCode === 'reconcile_matches_expected_state' &&
      isNonEmptyString(value.outcomeEventId)
    );
  }
  return (
    value.disposition === 'parked' &&
    hasExactKeys(value, [
      'protocol',
      'operationId',
      'disposition',
      'reasonCode',
      'evidenceEventIds',
    ]) &&
    typeof value.reasonCode === 'string' &&
    PARK_REASONS.has(value.reasonCode as ToolRecoveryParkReason)
  );
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isDistinctNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}
