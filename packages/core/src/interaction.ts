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
  APPROVALS_REVIEWERS,
  APPROVAL_RISK_LEVELS,
  type ApprovalRiskLevel,
  type ApprovalsReviewer,
} from './permission.js';
import { defineObjectShape, hasExactShape } from './record-schema.js';
import {
  InteractionPermissionProjectionError,
  decodeInteractionPermissionPrompt,
  projectInteractionReviewText,
  projectInteractionPermissionPrompt,
  type InteractionPermissionPrompt,
  type InteractionPermissionProjectionInput,
} from './interaction-permission-review.js';
import {
  SANDBOX_BOUNDARY_REQUEST_STATUSES,
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryRequestStatus,
} from './sandbox-boundary.js';
import {
  decodeClientCapabilityGrantTarget,
  type ClientCapabilityGrantTarget,
} from './client-capability-grant.js';

export * from './interaction-permission-review.js';

export const INTERACTION_MIN_QUESTIONS = 1;
export const INTERACTION_MAX_QUESTIONS = 3;
export const INTERACTION_MIN_OPTIONS_PER_QUESTION = 2;
export const INTERACTION_MAX_OPTIONS_PER_QUESTION = 3;
export const INTERACTION_ID_MAX_BYTES = 256;
export const INTERACTION_QUESTION_MAX_BYTES = 1024;
export const INTERACTION_OPTION_LABEL_MAX_BYTES = 256;
export const INTERACTION_OPTION_DESCRIPTION_MAX_BYTES = 512;
export const INTERACTION_ANSWER_MAX_BYTES = 2048;
export const INTERACTION_REQUEST_MAX_BYTES = 16 * 1024;
export const INTERACTION_SANDBOX_BOUNDARY_JUSTIFICATION_MAX_CHARS = 2_000;
export const INTERACTION_ANSWER_SERIALIZED_MAX_BYTES = 8 * 1024;
export const INTERACTION_OUTCOME_SERIALIZED_MAX_BYTES = 8 * 1024;
export const INTERACTION_AUTO_REVIEW_RATIONALE_MAX_CHARS = 1_000;

export const INTERACTION_CLOSURE_REASONS = [
  'turn_stopped',
  'turn_terminal',
  'timed_out',
  'host_restarted',
  'provider_disconnected',
] as const;

const UTF8 = new TextEncoder();

export type InteractionClosureReason = (typeof INTERACTION_CLOSURE_REASONS)[number];

export interface InteractionQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface InteractionQuestion {
  readonly question: string;
  readonly options: readonly InteractionQuestionOption[];
}

export interface InteractionPermissionRequest {
  readonly kind: 'permission';
  readonly toolUseId: string;
  readonly prompt: InteractionPermissionPrompt;
}

export interface InteractionQuestionRequest {
  readonly kind: 'question';
  readonly toolUseId: string;
  readonly questions: readonly InteractionQuestion[];
}

export interface InteractionSandboxBoundaryRequest {
  readonly kind: 'sandbox_boundary';
  readonly expansion: SandboxBoundaryExpansion;
  readonly justification: string;
}

export interface InteractionClientCapabilityRequest {
  readonly kind: 'client_capability';
  readonly toolUseId: string;
  readonly target: ClientCapabilityGrantTarget;
}

export type InteractionRequest =
  | InteractionPermissionRequest
  | InteractionQuestionRequest
  | InteractionSandboxBoundaryRequest
  | InteractionClientCapabilityRequest;

export type InteractionPermissionDecisionFields =
  | { readonly decision: 'allow'; readonly rememberForTurn: boolean }
  | { readonly decision: 'deny'; readonly rememberForTurn: false };

export type InteractionPermissionAnswer = {
  readonly kind: 'permission';
} & InteractionPermissionDecisionFields;

export interface InteractionQuestionAnswer {
  readonly kind: 'question';
  readonly answers: readonly (string | null)[];
}

export interface InteractionSandboxBoundaryAnswer {
  readonly kind: 'sandbox_boundary';
  readonly decision: 'allow' | 'deny';
}

export interface InteractionClientCapabilityAnswer {
  readonly kind: 'client_capability';
  readonly decision: 'allow' | 'deny';
}

export type InteractionAnswer =
  | InteractionPermissionAnswer
  | InteractionQuestionAnswer
  | InteractionSandboxBoundaryAnswer
  | InteractionClientCapabilityAnswer;

export type InteractionCanonicalPermissionOutcome = {
  readonly kind: 'permission_answer';
  readonly reviewer: ApprovalsReviewer;
  readonly rationale?: string;
  readonly riskLevel?: ApprovalRiskLevel;
  readonly committedAt: number;
} & InteractionPermissionDecisionFields;

export interface InteractionCanonicalQuestionOutcome {
  readonly kind: 'question_answer';
  readonly answers: readonly (string | null)[];
  readonly committedAt: number;
}

export interface InteractionCanonicalSandboxBoundaryOutcome {
  readonly kind: 'sandbox_boundary_decision';
  readonly decision: 'allow' | 'deny';
  readonly status: Exclude<SandboxBoundaryRequestStatus, 'pending'>;
  readonly committedAt: number;
}

export interface InteractionCanonicalClientCapabilityOutcome {
  readonly kind: 'client_capability_decision';
  readonly decision: 'allow' | 'deny';
  readonly committedAt: number;
}

export interface InteractionCanonicalClosureOutcome {
  readonly kind: 'closure';
  readonly reason: InteractionClosureReason;
  readonly committedAt: number;
}

export type InteractionCanonicalOutcome =
  | InteractionCanonicalPermissionOutcome
  | InteractionCanonicalQuestionOutcome
  | InteractionCanonicalSandboxBoundaryOutcome
  | InteractionCanonicalClientCapabilityOutcome
  | InteractionCanonicalClosureOutcome;

export type InteractionQuestionProjectionInput = Pick<
  InteractionQuestionRequest,
  'toolUseId' | 'questions'
>;

const PERMISSION_REQUEST_SHAPE = defineObjectShape<InteractionPermissionRequest>()(
  ['kind', 'toolUseId', 'prompt'],
  [],
);
const QUESTION_REQUEST_SHAPE = defineObjectShape<InteractionQuestionRequest>()(
  ['kind', 'toolUseId', 'questions'],
  [],
);
const SANDBOX_BOUNDARY_REQUEST_SHAPE = defineObjectShape<InteractionSandboxBoundaryRequest>()(
  ['kind', 'expansion', 'justification'],
  [],
);
const CLIENT_CAPABILITY_REQUEST_SHAPE = defineObjectShape<InteractionClientCapabilityRequest>()(
  ['kind', 'toolUseId', 'target'],
  [],
);
const PERMISSION_ANSWER_SHAPE = defineObjectShape<InteractionPermissionAnswer>()(
  ['kind', 'decision', 'rememberForTurn'],
  [],
);
const QUESTION_ANSWER_SHAPE = defineObjectShape<InteractionQuestionAnswer>()(
  ['kind', 'answers'],
  [],
);
const SANDBOX_BOUNDARY_ANSWER_SHAPE = defineObjectShape<InteractionSandboxBoundaryAnswer>()(
  ['kind', 'decision'],
  [],
);
const CLIENT_CAPABILITY_ANSWER_SHAPE = defineObjectShape<InteractionClientCapabilityAnswer>()(
  ['kind', 'decision'],
  [],
);
const PERMISSION_OUTCOME_SHAPE = defineObjectShape<InteractionCanonicalPermissionOutcome>()(
  ['kind', 'reviewer', 'committedAt', 'decision', 'rememberForTurn'],
  ['rationale', 'riskLevel'],
);
const QUESTION_OUTCOME_SHAPE = defineObjectShape<InteractionCanonicalQuestionOutcome>()(
  ['kind', 'answers', 'committedAt'],
  [],
);
const SANDBOX_BOUNDARY_OUTCOME_SHAPE =
  defineObjectShape<InteractionCanonicalSandboxBoundaryOutcome>()(
    ['kind', 'decision', 'status', 'committedAt'],
    [],
  );
const CLIENT_CAPABILITY_OUTCOME_SHAPE =
  defineObjectShape<InteractionCanonicalClientCapabilityOutcome>()(
    ['kind', 'decision', 'committedAt'],
    [],
  );
const CLOSURE_OUTCOME_SHAPE = defineObjectShape<InteractionCanonicalClosureOutcome>()(
  ['kind', 'reason', 'committedAt'],
  [],
);
const QUESTION_SHAPE = defineObjectShape<InteractionQuestion>()(['question', 'options'], []);
const OPTION_SHAPE = defineObjectShape<InteractionQuestionOption>()(['label'], ['description']);

export function decodeInteractionRequest(value: unknown): InteractionRequest {
  const record = plainRecord(value, 'Interaction request');
  let request: InteractionRequest;
  if (record.kind === 'permission') {
    exact(record, PERMISSION_REQUEST_SHAPE, 'permission request');
    request = {
      kind: 'permission',
      toolUseId: boundedString(record.toolUseId, 'toolUseId', INTERACTION_ID_MAX_BYTES),
      prompt: decodeInteractionPermissionPrompt(record.prompt),
    };
  } else if (record.kind === 'question') {
    exact(record, QUESTION_REQUEST_SHAPE, 'question request');
    request = {
      kind: 'question',
      toolUseId: boundedString(record.toolUseId, 'toolUseId', INTERACTION_ID_MAX_BYTES),
      questions: plainArray(
        record.questions,
        'questions',
        INTERACTION_MIN_QUESTIONS,
        INTERACTION_MAX_QUESTIONS,
      ).map(decodeQuestion),
    };
  } else if (record.kind === 'sandbox_boundary') {
    exact(record, SANDBOX_BOUNDARY_REQUEST_SHAPE, 'sandbox boundary request');
    const expansion = validateSandboxBoundaryExpansion(record.expansion);
    if (!expansion.ok) throw new Error('Invalid sandbox boundary expansion');
    request = {
      kind: 'sandbox_boundary',
      expansion: expansion.expansion,
      justification: boundedCharacterString(
        record.justification,
        'sandbox boundary justification',
        INTERACTION_SANDBOX_BOUNDARY_JUSTIFICATION_MAX_CHARS,
      ),
    };
  } else if (record.kind === 'client_capability') {
    exact(record, CLIENT_CAPABILITY_REQUEST_SHAPE, 'Client Capability request');
    request = {
      kind: 'client_capability',
      toolUseId: boundedString(record.toolUseId, 'toolUseId', INTERACTION_ID_MAX_BYTES),
      target: decodeClientCapabilityGrantTarget(record.target),
    };
  } else {
    throw new Error('Invalid Interaction request kind');
  }
  if (request.kind !== 'sandbox_boundary') {
    serializedLimit(request, INTERACTION_REQUEST_MAX_BYTES, 'Interaction request');
  }
  return deepFreeze(request);
}

export function decodeInteractionAnswer(value: unknown): InteractionAnswer {
  const record = plainRecord(value, 'Interaction answer');
  let answer: InteractionAnswer;
  if (record.kind === 'permission') {
    exact(record, PERMISSION_ANSWER_SHAPE, 'permission answer');
    const decision = oneOf(record.decision, ['allow', 'deny'] as const, 'decision');
    const rememberForTurn = boolean(record.rememberForTurn, 'rememberForTurn');
    if (decision === 'deny' && rememberForTurn)
      throw new Error('Denied permission cannot be remembered');
    answer =
      decision === 'deny'
        ? { kind: 'permission', decision, rememberForTurn: false }
        : { kind: 'permission', decision, rememberForTurn };
  } else if (record.kind === 'question') {
    exact(record, QUESTION_ANSWER_SHAPE, 'question answer');
    answer = { kind: 'question', answers: decodeAnswers(record.answers) };
  } else if (record.kind === 'sandbox_boundary') {
    exact(record, SANDBOX_BOUNDARY_ANSWER_SHAPE, 'sandbox boundary answer');
    answer = {
      kind: 'sandbox_boundary',
      decision: oneOf(record.decision, ['allow', 'deny'] as const, 'decision'),
    };
  } else if (record.kind === 'client_capability') {
    exact(record, CLIENT_CAPABILITY_ANSWER_SHAPE, 'Client Capability answer');
    answer = {
      kind: 'client_capability',
      decision: oneOf(record.decision, ['allow', 'deny'] as const, 'decision'),
    };
  } else {
    throw new Error('Invalid Interaction answer kind');
  }
  serializedLimit(answer, INTERACTION_ANSWER_SERIALIZED_MAX_BYTES, 'Interaction answer');
  return deepFreeze(answer);
}

export function decodeInteractionCanonicalOutcome(value: unknown): InteractionCanonicalOutcome {
  const record = plainRecord(value, 'Interaction canonical outcome');
  let outcome: InteractionCanonicalOutcome;
  if (record.kind === 'permission_answer') {
    exact(record, PERMISSION_OUTCOME_SHAPE, 'permission outcome');
    const decision = oneOf(record.decision, ['allow', 'deny'] as const, 'decision');
    const rememberForTurn = boolean(record.rememberForTurn, 'rememberForTurn');
    if (decision === 'deny' && rememberForTurn)
      throw new Error('Denied permission cannot be remembered');
    const reviewer = oneOf(record.reviewer, APPROVALS_REVIEWERS, 'reviewer');
    if (record.rationale !== undefined && reviewer !== 'auto_review') {
      throw new Error('Only auto-review permission outcomes can include rationale');
    }
    const common = {
      kind: 'permission_answer' as const,
      reviewer,
      ...(record.rationale === undefined
        ? {}
        : {
            rationale: boundedCharacterString(
              record.rationale,
              'rationale',
              INTERACTION_AUTO_REVIEW_RATIONALE_MAX_CHARS,
            ),
          }),
      ...(record.riskLevel === undefined
        ? {}
        : {
            riskLevel: oneOf(record.riskLevel, APPROVAL_RISK_LEVELS, 'riskLevel'),
          }),
      committedAt: safeInteger(record.committedAt, 'committedAt', false),
    };
    outcome =
      decision === 'deny'
        ? { ...common, decision, rememberForTurn: false }
        : { ...common, decision, rememberForTurn };
  } else if (record.kind === 'question_answer') {
    exact(record, QUESTION_OUTCOME_SHAPE, 'question outcome');
    outcome = {
      kind: 'question_answer',
      answers: decodeAnswers(record.answers),
      committedAt: safeInteger(record.committedAt, 'committedAt', false),
    };
  } else if (record.kind === 'sandbox_boundary_decision') {
    exact(record, SANDBOX_BOUNDARY_OUTCOME_SHAPE, 'sandbox boundary outcome');
    const status = oneOf(
      record.status,
      SANDBOX_BOUNDARY_REQUEST_STATUSES,
      'sandbox boundary status',
    );
    if (status === 'pending') throw new Error('Sandbox boundary outcome is still pending');
    const decision = oneOf(record.decision, ['allow', 'deny'] as const, 'decision');
    if ((status === 'denied') !== (decision === 'deny')) {
      throw new Error('Sandbox boundary outcome decision does not match its status');
    }
    outcome = {
      kind: 'sandbox_boundary_decision',
      decision,
      status,
      committedAt: safeInteger(record.committedAt, 'committedAt', false),
    };
  } else if (record.kind === 'client_capability_decision') {
    exact(record, CLIENT_CAPABILITY_OUTCOME_SHAPE, 'Client Capability outcome');
    outcome = {
      kind: 'client_capability_decision',
      decision: oneOf(record.decision, ['allow', 'deny'] as const, 'decision'),
      committedAt: safeInteger(record.committedAt, 'committedAt', false),
    };
  } else if (record.kind === 'closure') {
    exact(record, CLOSURE_OUTCOME_SHAPE, 'closure outcome');
    outcome = {
      kind: 'closure',
      reason: oneOf(record.reason, INTERACTION_CLOSURE_REASONS, 'closure reason'),
      committedAt: safeInteger(record.committedAt, 'committedAt', false),
    };
  } else {
    throw new Error('Invalid Interaction canonical outcome kind');
  }
  serializedLimit(outcome, INTERACTION_OUTCOME_SERIALIZED_MAX_BYTES, 'Interaction outcome');
  return deepFreeze(outcome);
}

export function projectInteractionPermissionRequest(
  request: InteractionPermissionProjectionInput,
): InteractionPermissionRequest {
  const record = plainRecord(request, 'Permission request');
  boundedString(record.requestId, 'requestId', INTERACTION_ID_MAX_BYTES);
  const projected: InteractionPermissionRequest = {
    kind: 'permission',
    toolUseId: boundedString(record.toolUseId, 'toolUseId', INTERACTION_ID_MAX_BYTES),
    prompt: projectInteractionPermissionPrompt(request),
  };
  try {
    serializedLimit(projected, INTERACTION_REQUEST_MAX_BYTES, 'Interaction request');
  } catch (error) {
    if (error instanceof InteractionPermissionProjectionError) throw error;
    throw new InteractionPermissionProjectionError();
  }
  return deepFreeze(projected);
}

export function projectInteractionQuestionRequest(
  request: InteractionQuestionProjectionInput,
): InteractionQuestionRequest {
  const record = plainRecord(request, 'User question request');
  const shape = defineObjectShape<InteractionQuestionProjectionInput>()(
    ['toolUseId', 'questions'],
    [],
  );
  exact(record, shape, 'question projection');
  const decoded = decodeInteractionRequest({
    kind: 'question',
    toolUseId: record.toolUseId,
    questions: record.questions,
  }) as InteractionQuestionRequest;
  const projected = {
    kind: 'question' as const,
    toolUseId: decoded.toolUseId,
    questions: decoded.questions.map((question) => {
      const options = question.options.map((option) => ({
        label: projectInteractionReviewText(option.label, INTERACTION_OPTION_LABEL_MAX_BYTES),
        ...(option.description === undefined
          ? {}
          : {
              description: projectInteractionReviewText(
                option.description,
                INTERACTION_OPTION_DESCRIPTION_MAX_BYTES,
              ),
            }),
      }));
      if (new Set(options.map((option) => option.label)).size !== options.length)
        throw new Error('Question option labels collide after safe projection');
      return {
        question: projectInteractionReviewText(question.question, INTERACTION_QUESTION_MAX_BYTES),
        options,
      };
    }),
  };
  return decodeInteractionRequest(projected) as InteractionQuestionRequest;
}

export function projectInteractionSandboxBoundaryRequest(input: {
  readonly expansion: SandboxBoundaryExpansion;
  readonly justification: string;
}): InteractionSandboxBoundaryRequest {
  return decodeInteractionRequest({
    kind: 'sandbox_boundary',
    expansion: input.expansion,
    justification: input.justification,
  }) as InteractionSandboxBoundaryRequest;
}

export function projectInteractionClientCapabilityRequest(input: {
  readonly toolUseId: string;
  readonly target: ClientCapabilityGrantTarget;
}): InteractionClientCapabilityRequest {
  return decodeInteractionRequest({
    kind: 'client_capability',
    toolUseId: input.toolUseId,
    target: input.target,
  }) as InteractionClientCapabilityRequest;
}

export function interactionAnswerMatchesRequestKind(
  request: InteractionRequest,
  answer: InteractionAnswer,
): boolean {
  return request.kind === answer.kind;
}

export function interactionOutcomeMatchesRequestKind(
  request: InteractionRequest,
  outcome: InteractionCanonicalOutcome,
): boolean {
  return (
    outcome.kind === 'closure' ||
    (request.kind === 'permission'
      ? outcome.kind === 'permission_answer'
      : request.kind === 'question'
        ? outcome.kind === 'question_answer'
        : request.kind === 'sandbox_boundary'
          ? outcome.kind === 'sandbox_boundary_decision'
          : outcome.kind === 'client_capability_decision')
  );
}

export function interactionQuestionAnswerCountMatchesRequest(
  request: InteractionQuestionRequest,
  answers: readonly (string | null)[],
): boolean {
  return request.questions.length === answers.length;
}

export function interactionRememberForTurnIsEligible(
  request: InteractionRequest,
  decision: InteractionPermissionDecisionFields,
): boolean {
  if (request.kind !== 'permission') return false;
  if (!decision.rememberForTurn) return true;
  return (
    decision.decision === 'allow' &&
    request.prompt.kind === 'tool_permission' &&
    request.prompt.rememberForTurnAllowed
  );
}

export function isInteractionAnswerValidForRequest(
  request: InteractionRequest,
  answer: InteractionAnswer,
): boolean {
  if (!interactionAnswerMatchesRequestKind(request, answer)) return false;
  if (answer.kind === 'question') {
    return (
      request.kind === 'question' &&
      interactionQuestionAnswerCountMatchesRequest(request, answer.answers)
    );
  }
  if (answer.kind === 'sandbox_boundary') return request.kind === 'sandbox_boundary';
  if (answer.kind === 'client_capability') return request.kind === 'client_capability';
  return interactionRememberForTurnIsEligible(request, answer);
}

export function isInteractionCanonicalOutcomeValidForRequest(
  request: InteractionRequest,
  outcome: InteractionCanonicalOutcome,
): boolean {
  if (!interactionOutcomeMatchesRequestKind(request, outcome)) return false;
  if (outcome.kind === 'closure')
    return (
      request.kind === 'permission' ||
      request.kind === 'client_capability' ||
      outcome.reason !== 'timed_out'
    );
  if (outcome.kind === 'permission_answer') {
    return interactionRememberForTurnIsEligible(request, outcome);
  }
  if (outcome.kind === 'question_answer') {
    return (
      request.kind === 'question' &&
      interactionQuestionAnswerCountMatchesRequest(request, outcome.answers)
    );
  }
  if (outcome.kind === 'client_capability_decision') {
    return request.kind === 'client_capability';
  }
  return request.kind === 'sandbox_boundary';
}

export function interactionCanonicalOutcomesEquivalent(
  left: InteractionCanonicalOutcome,
  right: InteractionCanonicalOutcome,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'permission_answer' && right.kind === 'permission_answer')
    return left.decision === right.decision && left.rememberForTurn === right.rememberForTurn;
  if (left.kind === 'question_answer' && right.kind === 'question_answer')
    return equalAnswers(left.answers, right.answers);
  if (left.kind === 'sandbox_boundary_decision' && right.kind === 'sandbox_boundary_decision') {
    return left.decision === right.decision && left.status === right.status;
  }
  if (left.kind === 'client_capability_decision' && right.kind === 'client_capability_decision') {
    return left.decision === right.decision;
  }
  return left.kind === 'closure' && right.kind === 'closure' && left.reason === right.reason;
}

function decodeQuestion(value: unknown): InteractionQuestion {
  const record = plainRecord(value, 'Interaction question');
  exact(record, QUESTION_SHAPE, 'question');
  const options = plainArray(
    record.options,
    'options',
    INTERACTION_MIN_OPTIONS_PER_QUESTION,
    INTERACTION_MAX_OPTIONS_PER_QUESTION,
  ).map(decodeOption);
  if (new Set(options.map((option) => option.label)).size !== options.length)
    throw new Error('Duplicate question option label');
  return deepFreeze({
    question: boundedString(record.question, 'question', INTERACTION_QUESTION_MAX_BYTES),
    options,
  });
}

function decodeOption(value: unknown): InteractionQuestionOption {
  const record = plainRecord(value, 'Interaction question option');
  exact(record, OPTION_SHAPE, 'question option');
  return Object.freeze({
    label: boundedString(record.label, 'option label', INTERACTION_OPTION_LABEL_MAX_BYTES),
    ...(record.description === undefined
      ? {}
      : {
          description: boundedString(
            record.description,
            'option description',
            INTERACTION_OPTION_DESCRIPTION_MAX_BYTES,
          ),
        }),
  });
}

function decodeAnswers(value: unknown): readonly (string | null)[] {
  return Object.freeze(
    plainArray(value, 'answers', 1, INTERACTION_MAX_QUESTIONS).map((answer) =>
      answer === null ? null : boundedString(answer, 'answer', INTERACTION_ANSWER_MAX_BYTES),
    ),
  );
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be a plain record`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain record`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    )
      throw new Error(`${label} must contain plain data properties`);
  }
  return value as Record<string, unknown>;
}

function exact(
  record: Record<string, unknown>,
  shape: Parameters<typeof hasExactShape>[1],
  label: string,
): void {
  if (!hasExactShape(record, shape)) throw new Error(`Invalid ${label} fields`);
}

function plainArray(value: unknown, label: string, min: number, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < min ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new Error(`Invalid ${label}`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw new Error(`Invalid ${label}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || UTF8.encode(value).byteLength > maxBytes)
    throw new Error(`Invalid ${label}`);
  return value;
}

function boundedCharacterString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars)
    throw new Error(`Invalid ${label}`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
  return value;
}

function safeInteger(value: unknown, label: string, positive: boolean): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new Error(`Invalid ${label}`);
  return value;
}

function oneOf<const T extends readonly unknown[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!values.includes(value)) throw new Error(`Invalid ${label}`);
  return value as T[number];
}

function serializedLimit(value: unknown, maxBytes: number, label: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined || UTF8.encode(serialized).byteLength > maxBytes)
    throw new Error(`${label} exceeds serialized byte limit`);
}

function equalAnswers(
  left: readonly (string | null)[],
  right: readonly (string | null)[],
): boolean {
  return left.length === right.length && left.every((answer, index) => answer === right[index]);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
