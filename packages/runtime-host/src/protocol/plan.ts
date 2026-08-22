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
  PLAN_EXECUTION_STATUSES,
  PLAN_LIFECYCLE_REASON_MAX_BYTES,
  PLAN_MAX_FILES_PER_STEP,
  PLAN_MAX_RISKS,
  PLAN_MAX_STEPS,
  PLAN_PROPOSAL_STATUSES,
  PLAN_STEP_TITLE_MAX_CHARS,
  PLAN_STEP_STATUSES,
  PLAN_TEXT_MAX_BYTES,
  type PlanEvent,
  type PlanExecution,
  type PlanExecutionStatus,
  type PlanProposal,
  type PlanProposalStatus,
  type PlanStepDefinition,
  type PlanStepStatus,
  type PlanUserControlInput,
} from '@maka/core/plan';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { decodeTurnSnapshot, type TurnSnapshot } from './turn.js';

export const PLAN_PAGE_MAX_ITEMS = 16;
export const PLAN_RESULT_MAX_BYTES = 64 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'invalid_request',
  'internal_failure',
] as const;
const CONTROL_ERRORS = [
  ...QUERY_ERRORS,
  'session_busy',
  'operation_conflict',
  'persistence_failed',
] as const;

export type PlanQueryInput =
  | { readonly kind: 'list_start'; readonly sessionId: string }
  | {
      readonly kind: 'list_continue';
      readonly sessionId: string;
      readonly storeVersion: number;
      readonly cursor: string;
    };

export type PlanProjectionItem =
  | { readonly kind: 'proposal'; readonly proposal: PlanProposal }
  | { readonly kind: 'execution'; readonly execution: PlanExecution };

export type PlanQueryResult =
  | {
      readonly kind: 'page';
      readonly sessionId: string;
      readonly storeVersion: number;
      readonly latestProposalId: string | null;
      readonly activeExecutionId: string | null;
      readonly items: readonly PlanProjectionItem[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: number;
      readonly actual: number;
    };

export type PlanControlInput = PlanUserControlInput;

export interface PlanControlResult {
  readonly sessionId: string;
  readonly storeVersion: number;
  readonly eventType: PlanEvent['type'];
  readonly proposalId: string | null;
  readonly executionId: string | null;
}

export type PlanTurnStartInput =
  | {
      readonly kind: 'approve_proposal';
      readonly sessionId: string;
      readonly proposalId: string;
      readonly expectedRevision: number;
      readonly expectedStoreVersion: number;
      readonly turnId: string;
    }
  | {
      readonly kind: 'resume_execution';
      readonly sessionId: string;
      readonly executionId: string;
      readonly turnId: string;
    };

export interface PlanTurnStartResult {
  readonly plan: PlanControlResult;
  readonly turn: TurnSnapshot;
}

export const PLAN_OPERATION_SPECS = {
  'plan.query': defineOperation<PlanQueryInput, PlanQueryResult, (typeof QUERY_ERRORS)[number]>({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodePlanQueryInput,
    decodeOutput: decodePlanQueryResult,
    assertOutputForInput(input, output) {
      if (output.kind === 'page' && output.sessionId !== input.sessionId) {
        throw invalidProtocolFrame('Plan query result belongs to a different Session');
      }
    },
  }),
  'plan.control': defineOperation<
    PlanControlInput,
    PlanControlResult,
    (typeof CONTROL_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: CONTROL_ERRORS,
    decodeInput: decodePlanControlInput,
    decodeOutput: decodePlanControlResult,
    assertOutputForInput: assertPlanControlResult,
  }),
  'plan.turn.start': defineOperation<
    PlanTurnStartInput,
    PlanTurnStartResult,
    (typeof CONTROL_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: CONTROL_ERRORS,
    decodeInput: decodePlanTurnStartInput,
    decodeOutput: decodePlanTurnStartResult,
    assertOutputForInput(input, output) {
      if (
        output.plan.sessionId !== input.sessionId ||
        output.turn.sessionId !== input.sessionId ||
        output.turn.turnId !== input.turnId
      ) {
        throw invalidProtocolFrame('Plan Turn start result changed operation identity');
      }
      assertPlanControlResult(planTurnControlInput(input), output.plan);
    },
  }),
} as const;

export function decodePlanQueryInput(value: unknown): PlanQueryInput {
  const record = requireRecord(value, 'Plan query input');
  if (record.kind === 'list_start') {
    const input = requireExactRecord(record, 'Plan list start input', ['kind', 'sessionId']);
    return { kind: 'list_start', sessionId: requireEntityId(input.sessionId, 'sessionId') };
  }
  if (record.kind === 'list_continue') {
    const input = requireExactRecord(record, 'Plan list continuation input', [
      'kind',
      'sessionId',
      'storeVersion',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      storeVersion: requireCount(input.storeVersion, 'Plan storeVersion'),
      cursor: requireEntityId(input.cursor, 'Plan cursor'),
    };
  }
  throw invalidProtocolFrame('Invalid Plan query kind');
}

export function decodePlanQueryResult(value: unknown): PlanQueryResult {
  requireEncodedByteLimit(value, 'Plan query result', PLAN_RESULT_MAX_BYTES);
  const record = requireRecord(value, 'Plan query result');
  if (record.kind === 'revision_changed') {
    const result = requireExactRecord(record, 'Plan revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: requireCount(result.expected, 'expected Plan storeVersion'),
      actual: requireCount(result.actual, 'actual Plan storeVersion'),
    };
  }
  const result = requireExactRecord(record, 'Plan page result', [
    'kind',
    'sessionId',
    'storeVersion',
    'latestProposalId',
    'activeExecutionId',
    'items',
    'nextCursor',
  ]);
  if (result.kind !== 'page') throw invalidProtocolFrame('Invalid Plan query result kind');
  if (!Array.isArray(result.items) || result.items.length > PLAN_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid Plan page items');
  }
  const decoded: PlanQueryResult = {
    kind: 'page',
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    storeVersion: requireCount(result.storeVersion, 'Plan storeVersion'),
    latestProposalId: nullableId(result.latestProposalId, 'latestProposalId'),
    activeExecutionId: nullableId(result.activeExecutionId, 'activeExecutionId'),
    items: result.items.map(decodePlanProjectionItem),
    nextCursor: nullableId(result.nextCursor, 'nextCursor'),
  };
  if (
    decoded.items.some((item) =>
      item.kind === 'proposal'
        ? item.proposal.sessionId !== decoded.sessionId
        : item.execution.sessionId !== decoded.sessionId,
    )
  ) {
    throw invalidProtocolFrame('Plan page contains state from another Session');
  }
  return decoded;
}

export function decodePlanControlInput(value: unknown): PlanControlInput {
  const record = requireRecord(value, 'Plan control input');
  if (record.kind === 'request_revision' || record.kind === 'abandon_proposal') {
    const input = requireExactRecord(record, 'Plan proposal control input', [
      'kind',
      'sessionId',
      'proposalId',
      'operationId',
    ]);
    return {
      kind: record.kind,
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      proposalId: requireEntityId(input.proposalId, 'proposalId'),
      operationId: requireEntityId(input.operationId, 'operationId'),
    };
  }
  if (record.kind === 'approve_proposal') {
    const input = requireExactRecord(record, 'Plan approval input', [
      'kind',
      'sessionId',
      'proposalId',
      'expectedRevision',
      'expectedStoreVersion',
      'operationId',
    ]);
    return {
      kind: 'approve_proposal',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      proposalId: requireEntityId(input.proposalId, 'proposalId'),
      expectedRevision: requireCount(input.expectedRevision, 'expectedRevision'),
      expectedStoreVersion: requireCount(input.expectedStoreVersion, 'expectedStoreVersion'),
      operationId: requireEntityId(input.operationId, 'operationId'),
    };
  }
  if (record.kind === 'resume_execution' || record.kind === 'cancel_execution') {
    const input = requireExactRecord(record, 'Plan execution control input', [
      'kind',
      'sessionId',
      'executionId',
      'operationId',
    ]);
    return {
      kind: record.kind,
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      executionId: requireEntityId(input.executionId, 'executionId'),
      operationId: requireEntityId(input.operationId, 'operationId'),
    };
  }
  throw invalidProtocolFrame('Invalid Plan control kind');
}

export function decodePlanControlResult(value: unknown): PlanControlResult {
  requireEncodedByteLimit(value, 'Plan control result', PLAN_RESULT_MAX_BYTES);
  const result = requireExactRecord(value, 'Plan control result', [
    'sessionId',
    'storeVersion',
    'eventType',
    'proposalId',
    'executionId',
  ]);
  return {
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    storeVersion: requireCount(result.storeVersion, 'Plan storeVersion'),
    eventType: requirePlanEventType(result.eventType),
    proposalId: nullableId(result.proposalId, 'proposalId'),
    executionId: nullableId(result.executionId, 'executionId'),
  };
}

export function decodePlanTurnStartInput(value: unknown): PlanTurnStartInput {
  const record = requireRecord(value, 'Plan Turn start input');
  if (record.kind === 'approve_proposal') {
    const input = requireExactRecord(record, 'Plan approval Turn input', [
      'kind',
      'sessionId',
      'proposalId',
      'expectedRevision',
      'expectedStoreVersion',
      'turnId',
    ]);
    return {
      kind: 'approve_proposal',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      proposalId: requireEntityId(input.proposalId, 'proposalId'),
      expectedRevision: requireCount(input.expectedRevision, 'expectedRevision'),
      expectedStoreVersion: requireCount(input.expectedStoreVersion, 'expectedStoreVersion'),
      turnId: requireEntityId(input.turnId, 'turnId'),
    };
  }
  if (record.kind === 'resume_execution') {
    const input = requireExactRecord(record, 'Plan resume Turn input', [
      'kind',
      'sessionId',
      'executionId',
      'turnId',
    ]);
    return {
      kind: 'resume_execution',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      executionId: requireEntityId(input.executionId, 'executionId'),
      turnId: requireEntityId(input.turnId, 'turnId'),
    };
  }
  throw invalidProtocolFrame('Invalid Plan Turn start kind');
}

export function decodePlanTurnStartResult(value: unknown): PlanTurnStartResult {
  requireEncodedByteLimit(value, 'Plan Turn start result', PLAN_RESULT_MAX_BYTES);
  const result = requireExactRecord(value, 'Plan Turn start result', ['plan', 'turn']);
  return {
    plan: decodePlanControlResult(result.plan),
    turn: decodeTurnSnapshot(result.turn),
  };
}

export function planTurnControlInput(input: PlanTurnStartInput): PlanControlInput {
  return input.kind === 'approve_proposal'
    ? {
        kind: input.kind,
        sessionId: input.sessionId,
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        expectedStoreVersion: input.expectedStoreVersion,
        operationId: input.turnId,
      }
    : {
        kind: input.kind,
        sessionId: input.sessionId,
        executionId: input.executionId,
        operationId: input.turnId,
      };
}

function decodePlanProjectionItem(value: unknown): PlanProjectionItem {
  const record = requireRecord(value, 'Plan projection item');
  if (record.kind === 'proposal') {
    const item = requireExactRecord(record, 'Plan proposal item', ['kind', 'proposal']);
    return { kind: 'proposal', proposal: decodeProposal(item.proposal) };
  }
  if (record.kind === 'execution') {
    const item = requireExactRecord(record, 'Plan execution item', ['kind', 'execution']);
    return { kind: 'execution', execution: decodeExecution(item.execution) };
  }
  throw invalidProtocolFrame('Invalid Plan projection item kind');
}

function decodeProposal(value: unknown): PlanProposal {
  const record = requireShapedRecord(
    value,
    'Plan proposal',
    [
      'planId',
      'proposalId',
      'sessionId',
      'turnId',
      'revision',
      'title',
      'steps',
      'status',
      'submittedAt',
    ],
    ['supersedesProposalId', 'sourceExecutionId', 'overview', 'risks'],
  );
  return {
    planId: requireEntityId(record.planId, 'planId'),
    proposalId: requireEntityId(record.proposalId, 'proposalId'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    revision: requireCount(record.revision, 'Plan proposal revision'),
    ...(record.supersedesProposalId === undefined
      ? {}
      : {
          supersedesProposalId: requireEntityId(
            record.supersedesProposalId,
            'supersedesProposalId',
          ),
        }),
    ...(record.sourceExecutionId === undefined
      ? {}
      : { sourceExecutionId: requireEntityId(record.sourceExecutionId, 'sourceExecutionId') }),
    title: planText(record.title, 'Plan title'),
    ...(record.overview === undefined
      ? {}
      : { overview: planText(record.overview, 'Plan overview') }),
    steps: decodeArray(record.steps, 'Plan steps', PLAN_MAX_STEPS, decodeStepDefinition),
    ...(record.risks === undefined
      ? {}
      : {
          risks: decodeArray(record.risks, 'Plan risks', PLAN_MAX_RISKS, (item) =>
            planText(item, 'Plan risk'),
          ),
        }),
    status: requireProposalStatus(record.status),
    submittedAt: requireCount(record.submittedAt, 'Plan submittedAt'),
  };
}

function decodeExecution(value: unknown): PlanExecution {
  const record = requireShapedRecord(
    value,
    'Plan execution',
    [
      'executionId',
      'planId',
      'proposalId',
      'sessionId',
      'status',
      'steps',
      'startedAt',
      'updatedAt',
    ],
    ['completedAt', 'cancelledAt', 'interruptedAt', 'cancelReason', 'interruptionReason'],
  );
  return {
    executionId: requireEntityId(record.executionId, 'executionId'),
    planId: requireEntityId(record.planId, 'planId'),
    proposalId: requireEntityId(record.proposalId, 'proposalId'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    status: requireExecutionStatus(record.status),
    steps: decodeArray(record.steps, 'Plan execution steps', PLAN_MAX_STEPS, (item) => {
      const step = decodeStepDefinition(item);
      const source = requireShapedRecord(
        item,
        'Plan execution step',
        ['id', 'title', 'description', 'status', 'updatedAt'],
        ['files', 'complexity', 'note'],
      );
      return {
        ...step,
        status: requireStepStatus(source.status),
        ...(source.note === undefined ? {} : { note: planText(source.note, 'Plan step note') }),
        updatedAt: requireCount(source.updatedAt, 'Plan step updatedAt'),
      };
    }),
    startedAt: requireCount(record.startedAt, 'Plan startedAt'),
    updatedAt: requireCount(record.updatedAt, 'Plan updatedAt'),
    ...optionalCount(record, 'completedAt'),
    ...optionalCount(record, 'cancelledAt'),
    ...optionalCount(record, 'interruptedAt'),
    ...(record.cancelReason === undefined
      ? {}
      : {
          cancelReason: lifecycleReason(record.cancelReason, 'Plan cancelReason'),
        }),
    ...(record.interruptionReason === undefined
      ? {}
      : {
          interruptionReason: lifecycleReason(record.interruptionReason, 'Plan interruptionReason'),
        }),
  };
}

function decodeStepDefinition(value: unknown): PlanStepDefinition {
  const record = requireShapedRecord(
    value,
    'Plan step',
    ['id', 'title', 'description'],
    ['files', 'complexity', 'status', 'note', 'updatedAt'],
  );
  const complexity = record.complexity;
  if (complexity !== undefined && !['low', 'medium', 'high'].includes(String(complexity))) {
    throw invalidProtocolFrame('Invalid Plan step complexity');
  }
  const title = planText(record.title, 'Plan step title');
  if (title.length > PLAN_STEP_TITLE_MAX_CHARS) {
    throw invalidProtocolFrame('Invalid Plan step title');
  }
  return {
    id: requireEntityId(record.id, 'Plan step id'),
    title,
    description: planText(record.description, 'Plan step description'),
    ...(record.files === undefined
      ? {}
      : {
          files: decodeArray(record.files, 'Plan step files', PLAN_MAX_FILES_PER_STEP, (item) =>
            planText(item, 'Plan file'),
          ),
        }),
    ...(complexity === undefined
      ? {}
      : { complexity: complexity as PlanStepDefinition['complexity'] }),
  };
}

function decodeArray<T>(
  value: unknown,
  label: string,
  maxItems: number,
  decode: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value.map(decode);
}

function planText(value: unknown, label: string): string {
  return requireUtf8String(value, label, PLAN_TEXT_MAX_BYTES);
}

function lifecycleReason(value: unknown, label: string): string {
  return requireUtf8String(value, label, PLAN_LIFECYCLE_REASON_MAX_BYTES);
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : requireEntityId(value, label);
}

function optionalCount(record: Record<string, unknown>, key: string): Record<string, number> {
  return record[key] === undefined ? {} : { [key]: requireCount(record[key], `Plan ${key}`) };
}

function requireProposalStatus(value: unknown): PlanProposalStatus {
  if (!PLAN_PROPOSAL_STATUSES.includes(value as PlanProposalStatus)) {
    throw invalidProtocolFrame('Invalid Plan proposal status');
  }
  return value as PlanProposalStatus;
}

function requireExecutionStatus(value: unknown): PlanExecutionStatus {
  if (!PLAN_EXECUTION_STATUSES.includes(value as PlanExecutionStatus)) {
    throw invalidProtocolFrame('Invalid Plan execution status');
  }
  return value as PlanExecutionStatus;
}

function requireStepStatus(value: unknown): PlanStepStatus {
  if (!PLAN_STEP_STATUSES.includes(value as PlanStepStatus)) {
    throw invalidProtocolFrame('Invalid Plan step status');
  }
  return value as PlanStepStatus;
}

function requirePlanEventType(value: unknown): PlanEvent['type'] {
  const types: readonly PlanEvent['type'][] = [
    'plan_submitted',
    'plan_revision_requested',
    'plan_abandoned',
    'plan_approved',
    'plan_progress_updated',
    'plan_execution_completed',
    'plan_execution_cancelled',
    'plan_execution_interrupted',
    'plan_execution_resumed',
  ];
  if (!types.includes(value as PlanEvent['type'])) {
    throw invalidProtocolFrame('Invalid Plan eventType');
  }
  return value as PlanEvent['type'];
}

function assertPlanControlResult(input: PlanControlInput, output: PlanControlResult): void {
  if (input.sessionId !== output.sessionId) {
    throw invalidProtocolFrame('Plan control result belongs to a different Session');
  }
  if (input.kind === 'request_revision') {
    assertProposalControl(output, input.proposalId, 'plan_revision_requested');
    return;
  }
  if (input.kind === 'abandon_proposal') {
    assertProposalControl(output, input.proposalId, 'plan_abandoned');
    return;
  }
  if (input.kind === 'approve_proposal') {
    if (
      output.eventType !== 'plan_approved' ||
      output.proposalId !== input.proposalId ||
      output.executionId === null
    ) {
      throw invalidProtocolFrame('Plan approval result does not match its request');
    }
    return;
  }
  const expectedType =
    input.kind === 'resume_execution' ? 'plan_execution_resumed' : 'plan_execution_cancelled';
  if (!('executionId' in input)) {
    throw invalidProtocolFrame('Invalid Plan execution control correlation');
  }
  if (
    output.eventType !== expectedType ||
    output.executionId !== input.executionId ||
    output.proposalId !== null
  ) {
    throw invalidProtocolFrame('Plan execution control result does not match its request');
  }
}

function assertProposalControl(
  output: PlanControlResult,
  proposalId: string,
  eventType: 'plan_revision_requested' | 'plan_abandoned',
): void {
  if (
    output.eventType !== eventType ||
    output.proposalId !== proposalId ||
    output.executionId !== null
  ) {
    throw invalidProtocolFrame('Plan proposal control result does not match its request');
  }
}
