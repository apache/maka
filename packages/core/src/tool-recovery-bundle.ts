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

import { canonicalToolArgsHash } from './tool-args-identity.js';
import {
  validateToolLedgerEventLane,
  type ToolLedgerScanOperation,
} from './tool-ledger-scanner.js';
import type { RuntimeEvent } from './runtime-event.js';
import {
  isToolRecoveryFactEnvelope,
  type ToolReconcileResultFact,
  type ToolRecoveryDecisionFact,
} from './tool-recovery-fact.js';

export interface ToolRecoveryOperationIdentity {
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: NonNullable<NonNullable<RuntimeEvent['actions']>['toolDispatch']>['recoveryMode'];
  callEventId: string;
  dispatchEventId: string;
}

export interface ToolRecoveryEventBundle {
  operation: ToolRecoveryOperationIdentity;
  callEvent: RuntimeEvent;
  dispatchEvent: RuntimeEvent;
  reconcileEvent: RuntimeEvent;
  outcomeEvent?: RuntimeEvent;
  decisionEvent: RuntimeEvent;
}

export type ToolRecoveryBundleValidationCode =
  | 'call_identity_conflict'
  | 'canonical_args_hash_conflict'
  | 'dispatch_identity_conflict'
  | 'reconcile_fact_invalid'
  | 'decision_fact_invalid'
  | 'recovery_fact_identity_conflict'
  | 'operation_identity_conflict'
  | 'recovery_mode_unsupported'
  | 'outcome_required'
  | 'outcome_for_parked'
  | 'outcome_identity_conflict'
  | 'outcome_not_successful'
  | 'outcome_reference_conflict'
  | 'reconcile_decision_conflict'
  | 'evidence_order_conflict';

export type ToolRecoveryBundleValidationResult =
  | { ok: true; reconcile: ToolReconcileResultFact; decision: ToolRecoveryDecisionFact }
  | { ok: false; code: ToolRecoveryBundleValidationCode; message: string };

export type ScannedToolRecoveryInterpretation =
  | { kind: 'absent' }
  | {
      kind: 'valid';
      reconcile: ToolReconcileResultFact;
      decision: ToolRecoveryDecisionFact;
      reconcileEvent: RuntimeEvent;
      decisionEvent: RuntimeEvent;
      outcomeEvent?: RuntimeEvent;
    }
  | {
      kind: 'corruption';
      code:
        | ToolRecoveryBundleValidationCode
        | 'recovery_fact_shape_conflict'
        | 'event_order_conflict';
      message: string;
    };

export class ToolRecoveryBundleValidationError extends Error {
  readonly name = 'ToolRecoveryBundleValidationError';

  constructor(
    readonly code: ToolRecoveryBundleValidationCode,
    message: string,
  ) {
    super(message);
  }
}

export function validateToolRecoveryEventBundle(
  input: ToolRecoveryEventBundle,
): ToolRecoveryBundleValidationResult {
  const { operation } = input;
  const call = input.callEvent.content;
  if (
    input.callEvent.id !== operation.callEventId ||
    call?.kind !== 'function_call' ||
    call.id !== operation.providerToolCallId ||
    call.name !== operation.toolName ||
    validateToolLedgerEventLane(input.callEvent).ok !== true ||
    !hasExecutionIdentity(input.callEvent, operation)
  ) {
    return invalid('call_identity_conflict', 'Recovery bundle call identity conflict');
  }
  let actualHash: string;
  try {
    actualHash = canonicalToolArgsHash(call.name, call.args);
  } catch {
    return invalid(
      'canonical_args_hash_conflict',
      'Recovery bundle argument hash does not match its canonical function call',
    );
  }
  if (actualHash !== operation.canonicalArgsHash) {
    return invalid(
      'canonical_args_hash_conflict',
      'Recovery bundle argument hash does not match its canonical function call',
    );
  }

  const dispatch = input.dispatchEvent.actions?.toolDispatch;
  if (
    input.dispatchEvent.id !== operation.dispatchEventId ||
    !dispatch ||
    dispatch.operationId !== operation.operationId ||
    dispatch.providerToolCallId !== operation.providerToolCallId ||
    dispatch.toolName !== operation.toolName ||
    dispatch.canonicalArgsHash !== operation.canonicalArgsHash ||
    dispatch.recoveryMode !== operation.recoveryMode ||
    validateToolLedgerEventLane(input.dispatchEvent).ok !== true ||
    !hasExecutionIdentity(input.dispatchEvent, operation) ||
    input.dispatchEvent.sessionId !== input.callEvent.sessionId ||
    input.dispatchEvent.refs?.operationId !== operation.operationId ||
    input.dispatchEvent.refs?.toolCallId !== operation.providerToolCallId
  ) {
    return invalid('dispatch_identity_conflict', 'Recovery bundle dispatch identity conflict');
  }
  if (operation.recoveryMode !== 'reconcile') {
    return invalid('recovery_mode_unsupported', 'Recovery bundle requires reconcile recovery mode');
  }

  const reconcileEnvelope = input.reconcileEvent.actions?.toolRecovery;
  if (
    !isToolRecoveryFactEnvelope(reconcileEnvelope) ||
    reconcileEnvelope.kind !== 'maka.tool.reconcile_result'
  ) {
    return invalid(
      'reconcile_fact_invalid',
      'Recovery bundle requires one canonical reconcile result fact',
    );
  }
  const decisionEnvelope = input.decisionEvent.actions?.toolRecovery;
  if (
    !isToolRecoveryFactEnvelope(decisionEnvelope) ||
    decisionEnvelope.kind !== 'maka.tool.recovery_decision'
  ) {
    return invalid(
      'decision_fact_invalid',
      'Recovery bundle requires one canonical recovery decision fact',
    );
  }
  const reconcile = reconcileEnvelope.payload;
  const decision = decisionEnvelope.payload;

  if (
    validateToolLedgerEventLane(input.reconcileEvent).ok !== true ||
    validateToolLedgerEventLane(input.decisionEvent).ok !== true ||
    !hasExecutionIdentity(input.reconcileEvent, operation) ||
    !hasExecutionIdentity(input.decisionEvent, operation) ||
    input.reconcileEvent.sessionId !== input.callEvent.sessionId ||
    input.decisionEvent.sessionId !== input.callEvent.sessionId ||
    input.reconcileEvent.refs?.operationId !== operation.operationId ||
    input.reconcileEvent.refs?.toolCallId !== operation.providerToolCallId ||
    input.decisionEvent.refs?.operationId !== operation.operationId ||
    input.decisionEvent.refs?.toolCallId !== operation.providerToolCallId
  ) {
    return invalid('recovery_fact_identity_conflict', 'Recovery fact execution identity conflict');
  }
  if (
    reconcile.operationId !== operation.operationId ||
    decision.operationId !== operation.operationId
  ) {
    return invalid(
      'operation_identity_conflict',
      'Recovery bundle fact operation identity conflict',
    );
  }

  const expectedEvidence = [
    operation.callEventId,
    operation.dispatchEventId,
    input.reconcileEvent.id,
  ];
  if (decision.disposition === 'completed') {
    if (!input.outcomeEvent) {
      return invalid(
        'outcome_required',
        'Completed recovery decision requires a persisted outcome',
      );
    }
    if (
      input.outcomeEvent.sessionId !== input.callEvent.sessionId ||
      validateToolLedgerEventLane(input.outcomeEvent).ok !== true ||
      !isMatchingOutcome(input.outcomeEvent, operation)
    ) {
      return invalid(
        'outcome_identity_conflict',
        'Completed recovery outcome execution identity conflict',
      );
    }
    if (
      input.outcomeEvent.content?.kind === 'function_response' &&
      input.outcomeEvent.content.isError
    ) {
      return invalid(
        'outcome_not_successful',
        'Completed recovery decision requires a successful synthesized outcome',
      );
    }
    if (decision.outcomeEventId !== input.outcomeEvent.id) {
      return invalid(
        'outcome_reference_conflict',
        'Completed recovery decision outcome reference conflict',
      );
    }
    if (reconcile.observation !== 'matches_expected_state') {
      return invalid(
        'reconcile_decision_conflict',
        'Completed recovery decision requires a matching expected-state observation',
      );
    }
    expectedEvidence.push(input.outcomeEvent.id);
  } else {
    if (input.outcomeEvent) {
      return invalid(
        'outcome_for_parked',
        'Parked recovery decision must not commit a provider outcome',
      );
    }
    if (
      reconcile.observation === 'matches_expected_state' ||
      decision.reasonCode !== parkedReasonFor(reconcile.observation)
    ) {
      return invalid(
        'reconcile_decision_conflict',
        'Parked recovery decision does not match the reconcile result',
      );
    }
  }

  if (
    decision.evidenceEventIds.length !== expectedEvidence.length ||
    decision.evidenceEventIds.some((eventId, index) => eventId !== expectedEvidence[index])
  ) {
    return invalid(
      'evidence_order_conflict',
      'Recovery decision evidence does not match the canonical causal order',
    );
  }
  return { ok: true, reconcile, decision };
}

export function assertToolRecoveryEventBundle(input: ToolRecoveryEventBundle): {
  reconcile: ToolReconcileResultFact;
  decision: ToolRecoveryDecisionFact;
} {
  const result = validateToolRecoveryEventBundle(input);
  if (!result.ok) throw new ToolRecoveryBundleValidationError(result.code, result.message);
  return { reconcile: result.reconcile, decision: result.decision };
}

/**
 * Interprets the recovery tail of one scanner-owned operation. Resolver and
 * projection rebuild must consume this result instead of independently
 * assembling facts or defining their own causal-order rules.
 */
export function interpretScannedToolRecovery(
  operation: ToolLedgerScanOperation,
  eventOrder: ReadonlyMap<string, number>,
): ScannedToolRecoveryInterpretation {
  if (operation.reconcileEvents.length === 0 && operation.decisionEvents.length === 0) {
    return { kind: 'absent' };
  }
  if (
    operation.reconcileEvents.length !== 1 ||
    operation.decisionEvents.length !== 1 ||
    !operation.callEvent ||
    !operation.dispatchEvent ||
    !operation.operationId
  ) {
    return {
      kind: 'corruption',
      code: 'recovery_fact_shape_conflict',
      message: 'Recovery requires exactly one reconcile fact and one terminal decision',
    };
  }
  const dispatch = operation.dispatchEvent.actions?.toolDispatch;
  if (!dispatch) {
    return {
      kind: 'corruption',
      code: 'recovery_fact_shape_conflict',
      message: 'Recovery requires one canonical dispatch fact',
    };
  }

  const reconcileEvent = operation.reconcileEvents[0]!;
  const decisionEvent = operation.decisionEvents[0]!;
  const validation = validateToolRecoveryEventBundle({
    operation: {
      operationId: operation.operationId,
      invocationId: operation.dispatchEvent.invocationId,
      runId: operation.dispatchEvent.runId,
      turnId: operation.dispatchEvent.turnId,
      providerToolCallId: operation.toolCallId,
      toolName: operation.toolName ?? dispatch.toolName,
      canonicalArgsHash: dispatch.canonicalArgsHash,
      recoveryMode: dispatch.recoveryMode,
      callEventId: operation.callEvent.id,
      dispatchEventId: operation.dispatchEvent.id,
    },
    callEvent: operation.callEvent,
    dispatchEvent: operation.dispatchEvent,
    reconcileEvent,
    outcomeEvent: operation.responseEvent,
    decisionEvent,
  });
  if (!validation.ok) {
    return {
      kind: 'corruption',
      code: validation.code,
      message: validation.message,
    };
  }
  const facts = [
    operation.callEvent,
    operation.dispatchEvent,
    reconcileEvent,
    ...(operation.responseEvent ? [operation.responseEvent] : []),
    decisionEvent,
  ];
  const positions = facts.map((event) => eventOrder.get(event.id));
  if (
    !positions.every(
      (position, index) =>
        position !== undefined && (index === 0 || position > (positions[index - 1] ?? -1)),
    )
  ) {
    return {
      kind: 'corruption',
      code: 'event_order_conflict',
      message: 'Recovery facts violate canonical RuntimeEvent causal order',
    };
  }
  return {
    kind: 'valid',
    reconcile: validation.reconcile,
    decision: validation.decision,
    reconcileEvent,
    decisionEvent,
    ...(operation.responseEvent ? { outcomeEvent: operation.responseEvent } : {}),
  };
}

function hasExecutionIdentity(
  event: RuntimeEvent,
  operation: ToolRecoveryOperationIdentity,
): boolean {
  return (
    !event.partial &&
    event.invocationId === operation.invocationId &&
    event.runId === operation.runId &&
    event.turnId === operation.turnId
  );
}

function isMatchingOutcome(event: RuntimeEvent, operation: ToolRecoveryOperationIdentity): boolean {
  const content = event.content;
  return (
    hasExecutionIdentity(event, operation) &&
    content?.kind === 'function_response' &&
    content.id === operation.providerToolCallId &&
    content.name === operation.toolName &&
    event.refs?.operationId === operation.operationId &&
    event.refs?.toolCallId === operation.providerToolCallId
  );
}

function invalid(
  code: ToolRecoveryBundleValidationCode,
  message: string,
): ToolRecoveryBundleValidationResult {
  return { ok: false, code, message };
}

function parkedReasonFor(
  observation: Exclude<ToolReconcileResultFact['observation'], 'matches_expected_state'>,
): 'reconcile_matches_prior_state' | 'reconcile_diverged' | 'reconcile_unreadable' {
  switch (observation) {
    case 'matches_prior_state':
      return 'reconcile_matches_prior_state';
    case 'diverged':
      return 'reconcile_diverged';
    case 'unreadable':
      return 'reconcile_unreadable';
  }
}
