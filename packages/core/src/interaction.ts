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
export const INTERACTION_FORM_MAX_FIELDS = 32;
export const INTERACTION_FORM_MAX_OPTIONS = 64;
export const INTERACTION_FORM_MESSAGE_MAX_BYTES = 2_048;
export const INTERACTION_FORM_REQUESTER_NAME_MAX_BYTES = 256;
export const INTERACTION_FORM_REQUESTER_SOURCE_MAX_BYTES = 512;
export const INTERACTION_FORM_FIELD_NAME_MAX_BYTES = 256;
export const INTERACTION_FORM_FIELD_LABEL_MAX_BYTES = 256;
export const INTERACTION_FORM_FIELD_DESCRIPTION_MAX_BYTES = 512;
export const INTERACTION_FORM_VALUE_MAX_BYTES = 2_048;

export const INTERACTION_CLOSURE_REASONS = [
  'turn_stopped',
  'turn_terminal',
  'producer_cancelled',
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

export interface InteractionRequesterProjection {
  /** Human-readable name only. Runtime identity remains the exact Tool invocation. */
  readonly name: string;
  /** Optional display provenance such as a provider or server name. */
  readonly source?: string;
}

export interface InteractionFormOption {
  readonly value: string;
  readonly label: string;
}

interface InteractionFormFieldBase {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly description?: string;
}

export type InteractionFormField =
  | (InteractionFormFieldBase & {
      readonly kind: 'string';
      readonly default?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly format?: 'email' | 'uri' | 'date' | 'date-time';
    })
  | (InteractionFormFieldBase & {
      readonly kind: 'number';
      readonly default?: number;
      readonly minimum?: number;
      readonly maximum?: number;
    })
  | (InteractionFormFieldBase & {
      readonly kind: 'integer';
      readonly default?: number;
      readonly minimum?: number;
      readonly maximum?: number;
    })
  | (InteractionFormFieldBase & {
      readonly kind: 'boolean';
      readonly default?: boolean;
    })
  | (InteractionFormFieldBase & {
      readonly kind: 'single_select';
      readonly options: readonly InteractionFormOption[];
      readonly default?: string;
    })
  | (InteractionFormFieldBase & {
      readonly kind: 'multi_select';
      readonly options: readonly InteractionFormOption[];
      readonly default?: readonly string[];
      readonly minItems?: number;
      readonly maxItems?: number;
    });

export type InteractionFormValue = string | number | boolean | readonly string[];

export interface InteractionFormRequest {
  readonly kind: 'form';
  readonly toolUseId: string;
  readonly message: string;
  readonly requester: InteractionRequesterProjection;
  readonly fields: readonly InteractionFormField[];
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
  | InteractionFormRequest
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

export type InteractionFormResult =
  | {
      readonly action: 'accept';
      readonly values: Readonly<Record<string, InteractionFormValue>>;
    }
  | {
      readonly action: 'decline' | 'cancel';
    };

export type InteractionFormAnswer = { readonly kind: 'form' } & InteractionFormResult;

export type InteractionFormResponse = { readonly requestId: string } & InteractionFormResult;

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
  | InteractionFormAnswer
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

export type InteractionCanonicalFormOutcome =
  | {
      readonly kind: 'form_answer';
      readonly action: 'accept';
      readonly values: Readonly<Record<string, InteractionFormValue>>;
      readonly committedAt: number;
    }
  | {
      readonly kind: 'form_answer';
      readonly action: 'decline' | 'cancel';
      readonly committedAt: number;
    };

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
  | InteractionCanonicalFormOutcome
  | InteractionCanonicalSandboxBoundaryOutcome
  | InteractionCanonicalClientCapabilityOutcome
  | InteractionCanonicalClosureOutcome;

export type InteractionQuestionProjectionInput = Pick<
  InteractionQuestionRequest,
  'toolUseId' | 'questions'
>;

export type InteractionFormInput = Pick<InteractionFormRequest, 'message' | 'requester' | 'fields'>;

export type InteractionFormProjectionInput = InteractionFormInput & {
  readonly toolUseId: string;
};

const PERMISSION_REQUEST_SHAPE = defineObjectShape<InteractionPermissionRequest>()(
  ['kind', 'toolUseId', 'prompt'],
  [],
);
const QUESTION_REQUEST_SHAPE = defineObjectShape<InteractionQuestionRequest>()(
  ['kind', 'toolUseId', 'questions'],
  [],
);
const FORM_REQUEST_SHAPE = defineObjectShape<InteractionFormRequest>()(
  ['kind', 'toolUseId', 'message', 'requester', 'fields'],
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
const FORM_ACCEPT_ANSWER_SHAPE = defineObjectShape<
  Extract<InteractionFormAnswer, { action: 'accept' }>
>()(['kind', 'action', 'values'], []);
const FORM_EMPTY_ANSWER_SHAPE = defineObjectShape<
  Extract<InteractionFormAnswer, { action: 'decline' | 'cancel' }>
>()(['kind', 'action'], []);
const FORM_ACCEPT_RESPONSE_SHAPE = defineObjectShape<
  Extract<InteractionFormResponse, { action: 'accept' }>
>()(['requestId', 'action', 'values'], []);
const FORM_EMPTY_RESPONSE_SHAPE = defineObjectShape<
  Extract<InteractionFormResponse, { action: 'decline' | 'cancel' }>
>()(['requestId', 'action'], []);
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
const FORM_ACCEPT_OUTCOME_SHAPE = defineObjectShape<
  Extract<InteractionCanonicalFormOutcome, { action: 'accept' }>
>()(['kind', 'action', 'values', 'committedAt'], []);
const FORM_EMPTY_OUTCOME_SHAPE = defineObjectShape<
  Extract<InteractionCanonicalFormOutcome, { action: 'decline' | 'cancel' }>
>()(['kind', 'action', 'committedAt'], []);
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
const FORM_REQUESTER_SHAPE = defineObjectShape<InteractionRequesterProjection>()(
  ['name'],
  ['source'],
);
const FORM_OPTION_SHAPE = defineObjectShape<InteractionFormOption>()(['value', 'label'], []);
const FORM_STRING_FIELD_SHAPE = defineObjectShape<
  Extract<InteractionFormField, { kind: 'string' }>
>()(
  ['kind', 'name', 'label', 'required'],
  ['description', 'default', 'minLength', 'maxLength', 'format'],
);
const FORM_NUMBER_FIELD_SHAPE = defineObjectShape<
  Extract<InteractionFormField, { kind: 'number' | 'integer' }>
>()(['kind', 'name', 'label', 'required'], ['description', 'default', 'minimum', 'maximum']);
const FORM_BOOLEAN_FIELD_SHAPE = defineObjectShape<
  Extract<InteractionFormField, { kind: 'boolean' }>
>()(['kind', 'name', 'label', 'required'], ['description', 'default']);
const FORM_SINGLE_SELECT_FIELD_SHAPE = defineObjectShape<
  Extract<InteractionFormField, { kind: 'single_select' }>
>()(['kind', 'name', 'label', 'required', 'options'], ['description', 'default']);
const FORM_MULTI_SELECT_FIELD_SHAPE = defineObjectShape<
  Extract<InteractionFormField, { kind: 'multi_select' }>
>()(
  ['kind', 'name', 'label', 'required', 'options'],
  ['description', 'default', 'minItems', 'maxItems'],
);

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
  } else if (record.kind === 'form') {
    exact(record, FORM_REQUEST_SHAPE, 'form request');
    const fields = plainArray(record.fields, 'form fields', 0, INTERACTION_FORM_MAX_FIELDS).map(
      decodeFormField,
    );
    if (new Set(fields.map((field) => field.name)).size !== fields.length) {
      throw new Error('Duplicate form field name');
    }
    request = {
      kind: 'form',
      toolUseId: boundedString(record.toolUseId, 'toolUseId', INTERACTION_ID_MAX_BYTES),
      message: boundedString(record.message, 'form message', INTERACTION_FORM_MESSAGE_MAX_BYTES),
      requester: decodeFormRequester(record.requester),
      fields,
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
  if (request.kind === 'form') assertFormHasAcceptedAnswer(request);
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
  } else if (record.kind === 'form') {
    const action = oneOf(record.action, ['accept', 'decline', 'cancel'] as const, 'form action');
    if (action === 'accept') {
      exact(record, FORM_ACCEPT_ANSWER_SHAPE, 'accepted form answer');
      answer = { kind: 'form', action, values: decodeFormValues(record.values) };
    } else {
      exact(record, FORM_EMPTY_ANSWER_SHAPE, 'empty form answer');
      answer = { kind: 'form', action };
    }
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
  if (answer.kind === 'form' && answer.action === 'accept') {
    assertAcceptedFormAnswerFitsCanonicalOutcome(answer);
  }
  return deepFreeze(answer);
}

export function decodeInteractionFormResponse(value: unknown): InteractionFormResponse {
  const record = plainRecord(value, 'Interaction form response');
  const requestId = boundedString(record.requestId, 'requestId', INTERACTION_ID_MAX_BYTES);
  const action = oneOf(record.action, ['accept', 'decline', 'cancel'] as const, 'form action');
  if (action === 'accept') {
    exact(record, FORM_ACCEPT_RESPONSE_SHAPE, 'accepted form response');
    const answer = decodeInteractionAnswer({
      kind: 'form',
      action,
      values: record.values,
    });
    if (answer.kind !== 'form' || answer.action !== 'accept') {
      throw new Error('Invalid accepted form response');
    }
    return deepFreeze({ requestId, action, values: answer.values });
  }
  exact(record, FORM_EMPTY_RESPONSE_SHAPE, 'empty form response');
  return deepFreeze({ requestId, action });
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
  } else if (record.kind === 'form_answer') {
    const action = oneOf(record.action, ['accept', 'decline', 'cancel'] as const, 'form action');
    const committedAt = safeInteger(record.committedAt, 'committedAt', false);
    if (action === 'accept') {
      exact(record, FORM_ACCEPT_OUTCOME_SHAPE, 'accepted form outcome');
      outcome = {
        kind: 'form_answer',
        action,
        values: decodeFormValues(record.values),
        committedAt,
      };
    } else {
      exact(record, FORM_EMPTY_OUTCOME_SHAPE, 'empty form outcome');
      outcome = { kind: 'form_answer', action, committedAt };
    }
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

export function projectInteractionFormRequest(
  input: InteractionFormProjectionInput,
): InteractionFormRequest {
  const decoded = decodeInteractionRequest({ kind: 'form', ...input }) as InteractionFormRequest;
  return decodeInteractionRequest({
    ...decoded,
    message: projectInteractionReviewText(decoded.message, INTERACTION_FORM_MESSAGE_MAX_BYTES),
    requester: {
      name: projectInteractionReviewText(
        decoded.requester.name,
        INTERACTION_FORM_REQUESTER_NAME_MAX_BYTES,
      ),
      ...(decoded.requester.source === undefined
        ? {}
        : {
            source: projectInteractionReviewText(
              decoded.requester.source,
              INTERACTION_FORM_REQUESTER_SOURCE_MAX_BYTES,
              true,
            ),
          }),
    },
    fields: decoded.fields.map(projectInteractionFormField),
  }) as InteractionFormRequest;
}

function projectInteractionFormField(field: InteractionFormField): InteractionFormField {
  const display = {
    label: projectInteractionReviewText(field.label, INTERACTION_FORM_FIELD_LABEL_MAX_BYTES),
    ...(field.description === undefined
      ? {}
      : {
          description: projectInteractionReviewText(
            field.description,
            INTERACTION_FORM_FIELD_DESCRIPTION_MAX_BYTES,
            true,
          ),
        }),
  };
  if (field.kind !== 'single_select' && field.kind !== 'multi_select') {
    // `name` is a protocol identity returned to the tool. A string default is
    // both display text and a canonical answer value, so a safety rewrite must
    // not silently change its semantics under the original constraints.
    if (field.kind === 'string' && field.default !== undefined) {
      const { default: canonicalDefault, ...fieldWithoutDefault } = field;
      const projectedDefault = projectInteractionReviewText(
        canonicalDefault,
        INTERACTION_FORM_VALUE_MAX_BYTES,
        true,
      );
      return {
        ...fieldWithoutDefault,
        ...display,
        ...(projectedDefault === canonicalDefault ? { default: canonicalDefault } : {}),
      };
    }
    return { ...field, ...display };
  }
  // Select values are protocol identities; labels are their display text.
  const options = field.options.map((option) => ({
    ...option,
    label: projectInteractionReviewText(option.label, INTERACTION_FORM_FIELD_LABEL_MAX_BYTES),
  }));
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new Error('Form option labels collide after safe projection');
  }
  return { ...field, ...display, options };
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
        : request.kind === 'form'
          ? outcome.kind === 'form_answer'
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
  if (answer.kind === 'form') {
    return request.kind === 'form' && interactionFormAnswerMatchesRequest(request, answer);
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
  if (outcome.kind === 'form_answer') {
    return (
      request.kind === 'form' &&
      interactionFormAnswerMatchesRequest(
        request,
        outcome.action === 'accept'
          ? { kind: 'form', action: 'accept', values: outcome.values }
          : { kind: 'form', action: outcome.action },
      )
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
  if (left.kind === 'form_answer' && right.kind === 'form_answer') {
    return (
      left.action === right.action &&
      (left.action !== 'accept' ||
        (right.action === 'accept' && equalFormValues(left.values, right.values)))
    );
  }
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

function decodeFormRequester(value: unknown): InteractionRequesterProjection {
  const record = plainRecord(value, 'Interaction form requester');
  exact(record, FORM_REQUESTER_SHAPE, 'form requester');
  return Object.freeze({
    name: boundedString(
      record.name,
      'form requester name',
      INTERACTION_FORM_REQUESTER_NAME_MAX_BYTES,
    ),
    ...(record.source === undefined
      ? {}
      : {
          source: boundedText(
            record.source,
            'form requester source',
            INTERACTION_FORM_REQUESTER_SOURCE_MAX_BYTES,
          ),
        }),
  });
}

function decodeFormField(value: unknown): InteractionFormField {
  const record = plainRecord(value, 'Interaction form field');
  const common = decodeFormFieldBase(record);
  if (record.kind === 'string') {
    exact(record, FORM_STRING_FIELD_SHAPE, 'string form field');
    const minLength = optionalBoundedCount(record.minLength, 'minLength');
    const maxLength = optionalBoundedCount(record.maxLength, 'maxLength');
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw new Error('Invalid form string length range');
    }
    const field: Extract<InteractionFormField, { kind: 'string' }> = {
      ...common,
      kind: 'string',
      ...(record.default === undefined
        ? {}
        : {
            default: boundedText(
              record.default,
              'form string default',
              INTERACTION_FORM_VALUE_MAX_BYTES,
            ),
          }),
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(record.format === undefined
        ? {}
        : {
            format: oneOf(
              record.format,
              ['email', 'uri', 'date', 'date-time'] as const,
              'form string format',
            ),
          }),
    };
    if (field.default !== undefined && !isInteractionFormFieldValueValid(field, field.default)) {
      throw new Error('Invalid form string default');
    }
    return deepFreeze(field);
  }
  if (record.kind === 'number' || record.kind === 'integer') {
    exact(record, FORM_NUMBER_FIELD_SHAPE, 'number form field');
    const minimum = optionalFiniteNumber(record.minimum, 'minimum');
    const maximum = optionalFiniteNumber(record.maximum, 'maximum');
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error('Invalid form number range');
    }
    const field: Extract<InteractionFormField, { kind: 'number' | 'integer' }> = {
      ...common,
      kind: record.kind,
      ...(record.default === undefined
        ? {}
        : { default: finiteNumber(record.default, 'form number default') }),
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    };
    if (field.default !== undefined && !isInteractionFormFieldValueValid(field, field.default)) {
      throw new Error('Invalid form number default');
    }
    return deepFreeze(field);
  }
  if (record.kind === 'boolean') {
    exact(record, FORM_BOOLEAN_FIELD_SHAPE, 'boolean form field');
    return Object.freeze({
      ...common,
      kind: 'boolean',
      ...(record.default === undefined
        ? {}
        : { default: boolean(record.default, 'form boolean default') }),
    });
  }
  if (record.kind === 'single_select') {
    exact(record, FORM_SINGLE_SELECT_FIELD_SHAPE, 'single-select form field');
    const options = decodeFormOptions(record.options);
    const field: Extract<InteractionFormField, { kind: 'single_select' }> = {
      ...common,
      kind: 'single_select',
      options,
      ...(record.default === undefined
        ? {}
        : {
            default: boundedText(
              record.default,
              'single-select default',
              INTERACTION_FORM_VALUE_MAX_BYTES,
            ),
          }),
    };
    if (field.default !== undefined && !isInteractionFormFieldValueValid(field, field.default)) {
      throw new Error('Invalid single-select default');
    }
    return deepFreeze(field);
  }
  if (record.kind === 'multi_select') {
    exact(record, FORM_MULTI_SELECT_FIELD_SHAPE, 'multi-select form field');
    const options = decodeFormOptions(record.options);
    const minItems = optionalBoundedCount(record.minItems, 'minItems', options.length);
    const maxItems = optionalBoundedCount(record.maxItems, 'maxItems', options.length);
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      throw new Error('Invalid multi-select item range');
    }
    const field: Extract<InteractionFormField, { kind: 'multi_select' }> = {
      ...common,
      kind: 'multi_select',
      options,
      ...(record.default === undefined
        ? {}
        : {
            default: decodeFormStringArray(record.default, 'multi-select default'),
          }),
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
    };
    if (field.default !== undefined && !isInteractionFormFieldValueValid(field, field.default)) {
      throw new Error('Invalid multi-select default');
    }
    return deepFreeze(field);
  }
  throw new Error('Invalid form field kind');
}

function decodeFormFieldBase(record: Record<string, unknown>): InteractionFormFieldBase {
  return {
    name: boundedString(record.name, 'form field name', INTERACTION_FORM_FIELD_NAME_MAX_BYTES),
    label: boundedString(record.label, 'form field label', INTERACTION_FORM_FIELD_LABEL_MAX_BYTES),
    required: boolean(record.required, 'form field required'),
    ...(record.description === undefined
      ? {}
      : {
          description: boundedText(
            record.description,
            'form field description',
            INTERACTION_FORM_FIELD_DESCRIPTION_MAX_BYTES,
          ),
        }),
  };
}

function decodeFormOptions(value: unknown): readonly InteractionFormOption[] {
  const options = plainArray(value, 'form options', 1, INTERACTION_FORM_MAX_OPTIONS).map(
    (candidate) => {
      const record = plainRecord(candidate, 'Interaction form option');
      exact(record, FORM_OPTION_SHAPE, 'form option');
      return Object.freeze({
        value: boundedText(record.value, 'form option value', INTERACTION_FORM_VALUE_MAX_BYTES),
        label: boundedString(
          record.label,
          'form option label',
          INTERACTION_FORM_FIELD_LABEL_MAX_BYTES,
        ),
      });
    },
  );
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new Error('Duplicate form option value');
  }
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new Error('Duplicate form option label');
  }
  return Object.freeze(options);
}

function decodeFormValues(value: unknown): Readonly<Record<string, InteractionFormValue>> {
  const record = plainRecord(value, 'Interaction form values');
  const entries = Object.entries(record);
  if (entries.length > INTERACTION_FORM_MAX_FIELDS) throw new Error('Too many form values');
  return deepFreeze(
    Object.fromEntries(
      entries.map(([name, candidate]) => [
        boundedString(name, 'form value name', INTERACTION_FORM_FIELD_NAME_MAX_BYTES),
        decodeFormValue(candidate),
      ]),
    ),
  );
}

function decodeFormValue(value: unknown): InteractionFormValue {
  if (typeof value === 'string') {
    return boundedText(value, 'form string value', INTERACTION_FORM_VALUE_MAX_BYTES);
  }
  if (typeof value === 'number') return finiteNumber(value, 'form number value');
  if (typeof value === 'boolean') return value;
  return decodeFormStringArray(value, 'form multi-select value');
}

function decodeFormStringArray(value: unknown, label: string): readonly string[] {
  const values = plainArray(value, label, 0, INTERACTION_FORM_MAX_OPTIONS).map((candidate) =>
    boundedText(candidate, label, INTERACTION_FORM_VALUE_MAX_BYTES),
  );
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
  return Object.freeze(values);
}

export function interactionFormAnswerMatchesRequest(
  request: InteractionFormRequest,
  answer: InteractionFormAnswer,
): boolean {
  if (answer.action !== 'accept') return true;
  const fields = new Map(request.fields.map((field) => [field.name, field]));
  const names = Object.keys(answer.values);
  if (names.some((name) => !fields.has(name))) return false;
  for (const field of request.fields) {
    if (!Object.hasOwn(answer.values, field.name)) {
      if (field.required) return false;
      continue;
    }
    if (!isInteractionFormFieldValueValid(field, answer.values[field.name])) return false;
  }
  return true;
}

export function isInteractionFormFieldValueValid(
  field: InteractionFormField,
  value: InteractionFormValue | undefined,
): boolean {
  if (value === undefined) return false;
  if (field.kind === 'string') {
    if (typeof value !== 'string') return false;
    const length = [...value].length;
    return (
      (field.minLength === undefined || length >= field.minLength) &&
      (field.maxLength === undefined || length <= field.maxLength) &&
      matchesStringFormat(value, field.format)
    );
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (field.kind !== 'integer' || Number.isSafeInteger(value)) &&
      (field.minimum === undefined || value >= field.minimum) &&
      (field.maximum === undefined || value <= field.maximum)
    );
  }
  if (field.kind === 'boolean') return typeof value === 'boolean';
  if (field.kind === 'single_select') {
    return typeof value === 'string' && field.options.some((option) => option.value === value);
  }
  if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== 'string')) {
    return false;
  }
  return (
    new Set(value).size === value.length &&
    (field.minItems === undefined || value.length >= field.minItems) &&
    (field.maxItems === undefined || value.length <= field.maxItems) &&
    value.every((candidate) => field.options.some((option) => option.value === candidate))
  );
}

function matchesStringFormat(
  value: string,
  format: Extract<InteractionFormField, { kind: 'string' }>['format'],
): boolean {
  if (format === undefined) return true;
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'uri') {
    try {
      return new URL(value).protocol.length > 1;
    } catch {
      return false;
    }
  }
  if (format === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  return (
    isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    (match[7] === undefined || Number(match[7]) <= 23) &&
    (match[8] === undefined || Number(match[8]) <= 59) &&
    Number.isFinite(Date.parse(value))
  );
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** Reject a form that can be admitted but can never produce a bounded accepted answer. */
function assertFormHasAcceptedAnswer(request: InteractionFormRequest): void {
  const values: Record<string, InteractionFormValue> = {};
  for (const field of request.fields) {
    if (!field.required) continue;
    values[field.name] = formFieldWitness(field);
  }
  const answer = { kind: 'form' as const, action: 'accept' as const, values };
  if (!interactionFormAnswerMatchesRequest(request, answer)) {
    throw new Error('Interaction form has no valid accepted answer');
  }
  serializedLimit(answer, INTERACTION_ANSWER_SERIALIZED_MAX_BYTES, 'Interaction form answer');
  assertAcceptedFormAnswerFitsCanonicalOutcome(answer);
  assertEveryFormAnswerFitsCanonicalOutcome(request);
}

/**
 * Admission must reserve the whole legal answer envelope, not only a smallest
 * witness. This intentionally over-approximates format-constrained strings:
 * rejecting an over-large form is safe, whereas accepting one that can later
 * reject a valid user answer strands the interaction.
 */
function assertEveryFormAnswerFitsCanonicalOutcome(request: InteractionFormRequest): void {
  const values = Object.fromEntries(
    request.fields.map((field) => [field.name, formFieldMaximumEnvelope(field)]),
  );
  const answer = { kind: 'form' as const, action: 'accept' as const, values };
  serializedLimit(answer, INTERACTION_ANSWER_SERIALIZED_MAX_BYTES, 'Interaction form answer');
  assertAcceptedFormAnswerFitsCanonicalOutcome(answer);
}

function formFieldMaximumEnvelope(field: InteractionFormField): InteractionFormValue {
  if (field.kind === 'string') {
    // Admission must prove every legal answer serializes, so reserve the worst
    // value inside the format's legal language, measured post-serialization.
    // - date is a fixed-length language over [0-9-]; nothing JSON-escapes.
    // - date-time adds only digits and `.:TZ+-`; nothing JSON-escapes, and the
    //   fractional seconds leave the length unbounded up to the field caps.
    // - every other string may legally hold control characters, which
    //   JSON-escape to six bytes per code point (one raw byte each).
    if (field.format === 'date') return '0000-01-01';
    const maximumCodePoints = Math.min(
      field.maxLength ?? INTERACTION_FORM_VALUE_MAX_BYTES,
      INTERACTION_FORM_VALUE_MAX_BYTES,
    );
    if (field.format === 'date-time') return '0'.repeat(maximumCodePoints);
    return '\u0001'.repeat(maximumCodePoints);
  }
  if (field.kind === 'number' || field.kind === 'integer') return -1.7976931348623157e308;
  if (field.kind === 'boolean') return false;
  if (field.kind === 'single_select') {
    return field.options.reduce(
      (longest, option) =>
        serializedByteLength(option.value) > serializedByteLength(longest) ? option.value : longest,
      field.options[0]!.value,
    );
  }
  return [...field.options]
    .sort((left, right) => serializedByteLength(right.value) - serializedByteLength(left.value))
    .slice(0, field.maxItems ?? field.options.length)
    .map((option) => option.value);
}

function serializedByteLength(value: string): number {
  return UTF8.encode(JSON.stringify(value)).byteLength;
}

function assertAcceptedFormAnswerFitsCanonicalOutcome(
  answer: Extract<InteractionFormAnswer, { action: 'accept' }>,
): void {
  serializedLimit(
    {
      kind: 'form_answer',
      action: 'accept',
      values: answer.values,
      committedAt: Number.MAX_SAFE_INTEGER,
    } satisfies Extract<InteractionCanonicalOutcome, { kind: 'form_answer'; action: 'accept' }>,
    INTERACTION_OUTCOME_SERIALIZED_MAX_BYTES,
    'Interaction form outcome',
  );
}

function formFieldWitness(field: InteractionFormField): InteractionFormValue {
  if (field.default !== undefined) return field.default;
  if (field.kind === 'string') {
    const minLength = field.minLength ?? 0;
    let value: string;
    if (field.format === 'email') {
      value = `${'a'.repeat(Math.max(1, minLength - 5))}@b.co`;
    } else if (field.format === 'uri') {
      const base = 'https://a.co/';
      value = `${base}${'a'.repeat(Math.max(0, minLength - base.length))}`;
    } else if (field.format === 'date') {
      value = '2000-01-01';
    } else if (field.format === 'date-time') {
      const base = '2000-01-01T00:00:00';
      const fractionalLength = minLength <= 20 ? 0 : Math.max(1, minLength - 21);
      value = fractionalLength === 0 ? `${base}Z` : `${base}.${'0'.repeat(fractionalLength)}Z`;
    } else {
      value = 'a'.repeat(minLength);
    }
    if (!isInteractionFormFieldValueValid(field, value)) {
      throw new Error(`Interaction form field ${field.name} has no valid bounded value`);
    }
    return value;
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    const lower = field.minimum ?? Number.NEGATIVE_INFINITY;
    const upper = field.maximum ?? Number.POSITIVE_INFINITY;
    const value =
      field.kind === 'integer'
        ? lower > 0
          ? Math.ceil(lower)
          : upper < 0
            ? Math.floor(upper)
            : 0
        : lower > 0
          ? lower
          : upper < 0
            ? upper
            : 0;
    if (!isInteractionFormFieldValueValid(field, value)) {
      throw new Error(`Interaction form field ${field.name} has no valid bounded value`);
    }
    return value;
  }
  if (field.kind === 'boolean') return false;
  if (field.kind === 'single_select') return field.options[0].value;
  return field.options.slice(0, field.minItems ?? 0).map((option) => option.value);
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

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || UTF8.encode(value).byteLength > maxBytes) {
    throw new Error(`Invalid ${label}`);
  }
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

function optionalBoundedCount(
  value: unknown,
  label: string,
  max = INTERACTION_FORM_VALUE_MAX_BYTES,
): number | undefined {
  if (value === undefined) return undefined;
  const count = safeInteger(value, label, false);
  if (count > max) throw new Error(`Invalid ${label}`);
  return count;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return Object.is(value, -0) ? 0 : value;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label);
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

function equalFormValues(
  left: Readonly<Record<string, InteractionFormValue>>,
  right: Readonly<Record<string, InteractionFormValue>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => {
      if (key !== rightKeys[index]) return false;
      const leftValue = left[key];
      const rightValue = right[key];
      return Array.isArray(leftValue) && Array.isArray(rightValue)
        ? leftValue.length === rightValue.length &&
            leftValue.every((candidate, valueIndex) => candidate === rightValue[valueIndex])
        : leftValue === rightValue;
    })
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
