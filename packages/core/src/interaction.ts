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
export const INTERACTION_ANSWER_SERIALIZED_MAX_BYTES = 8 * 1024;
export const INTERACTION_OUTCOME_SERIALIZED_MAX_BYTES = 8 * 1024;

export const INTERACTION_CLOSURE_REASONS = [
  'turn_stopped',
  'turn_terminal',
  'timed_out',
  'host_restarted',
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

export type InteractionRequest = InteractionPermissionRequest | InteractionQuestionRequest;

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

export type InteractionAnswer = InteractionPermissionAnswer | InteractionQuestionAnswer;

export type InteractionCanonicalPermissionOutcome = {
  readonly kind: 'permission_answer';
  readonly reviewer: ApprovalsReviewer;
  readonly riskLevel?: ApprovalRiskLevel;
  readonly committedAt: number;
} & InteractionPermissionDecisionFields;

export interface InteractionCanonicalQuestionOutcome {
  readonly kind: 'question_answer';
  readonly answers: readonly (string | null)[];
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
const PERMISSION_ANSWER_SHAPE = defineObjectShape<InteractionPermissionAnswer>()(
  ['kind', 'decision', 'rememberForTurn'],
  [],
);
const QUESTION_ANSWER_SHAPE = defineObjectShape<InteractionQuestionAnswer>()(
  ['kind', 'answers'],
  [],
);
const PERMISSION_OUTCOME_SHAPE = defineObjectShape<InteractionCanonicalPermissionOutcome>()(
  ['kind', 'reviewer', 'committedAt', 'decision', 'rememberForTurn'],
  ['riskLevel'],
);
const QUESTION_OUTCOME_SHAPE = defineObjectShape<InteractionCanonicalQuestionOutcome>()(
  ['kind', 'answers', 'committedAt'],
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
  } else {
    throw new Error('Invalid Interaction request kind');
  }
  serializedLimit(request, INTERACTION_REQUEST_MAX_BYTES, 'Interaction request');
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
    const common = {
      kind: 'permission_answer' as const,
      reviewer: oneOf(record.reviewer, APPROVALS_REVIEWERS, 'reviewer'),
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
      : outcome.kind === 'question_answer')
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
  return answer.kind === 'question'
    ? request.kind === 'question' &&
        interactionQuestionAnswerCountMatchesRequest(request, answer.answers)
    : interactionRememberForTurnIsEligible(request, answer);
}

export function isInteractionCanonicalOutcomeValidForRequest(
  request: InteractionRequest,
  outcome: InteractionCanonicalOutcome,
): boolean {
  if (!interactionOutcomeMatchesRequestKind(request, outcome)) return false;
  if (outcome.kind === 'closure')
    return request.kind === 'permission' || outcome.reason !== 'timed_out';
  return outcome.kind === 'permission_answer'
    ? interactionRememberForTurnIsEligible(request, outcome)
    : request.kind === 'question' &&
        interactionQuestionAnswerCountMatchesRequest(request, outcome.answers);
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
