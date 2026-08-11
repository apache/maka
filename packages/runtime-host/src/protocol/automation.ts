import {
  AUTOMATION_CRON_EXPRESSION_LIMIT,
  AUTOMATION_CRON_EXPRESSION_MAX_BYTES as CORE_AUTOMATION_CRON_EXPRESSION_MAX_BYTES,
  AUTOMATION_LAST_ERROR_LIMIT,
  AUTOMATION_MAX_CLIENT_CAPABILITY_REQUIREMENTS,
  AUTOMATION_NAME_LIMIT,
  AUTOMATION_NAME_MAX_BYTES as CORE_AUTOMATION_NAME_MAX_BYTES,
  AUTOMATION_PROMPT_LIMIT,
  AUTOMATION_PROMPT_MAX_BYTES as CORE_AUTOMATION_PROMPT_MAX_BYTES,
  isAutomationTextWithinLimit,
  type AutomationSchedule,
  type AutomationStatus,
  type AutomationWaitingState,
} from '@maka/core/automation';
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

export const AUTOMATION_PAGE_MAX_ITEMS = 64;
export const AUTOMATION_RESULT_MAX_BYTES = 48 * 1024;
export const AUTOMATION_NAME_MAX_BYTES = CORE_AUTOMATION_NAME_MAX_BYTES;
export const AUTOMATION_PROMPT_MAX_BYTES = CORE_AUTOMATION_PROMPT_MAX_BYTES;
export const AUTOMATION_CRON_EXPRESSION_MAX_BYTES = CORE_AUTOMATION_CRON_EXPRESSION_MAX_BYTES;
export const AUTOMATION_MAX_FIRES = 10_000;
export const AUTOMATION_MAX_CAPABILITY_REQUIREMENTS = AUTOMATION_MAX_CLIENT_CAPABILITY_REQUIREMENTS;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'invalid_request',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [
  ...QUERY_ERRORS,
  'session_archived',
  'session_busy',
  'operation_conflict',
  'persistence_failed',
] as const;

export interface AutomationProjection {
  readonly id: string;
  readonly name: string;
  readonly status: AutomationStatus;
  readonly prompt: string;
  readonly sessionId: string;
  readonly schedule: AutomationSchedule;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextFireAt: number | null;
  readonly lastFireAt: number | null;
  readonly lastRunId: string | null;
  readonly fireCount: number;
  readonly maxFires: number | null;
  readonly expiresAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly deferredFireCount: number;
  readonly firePending: boolean;
  readonly waiting: AutomationWaitingState | null;
}

export type AutomationQueryInput =
  | { readonly kind: 'list_start'; readonly sessionId: string }
  | {
      readonly kind: 'list_continue';
      readonly sessionId: string;
      readonly revision: number;
      readonly cursor: string;
    }
  | { readonly kind: 'get'; readonly sessionId: string; readonly automationId: string };

export type AutomationQueryResult =
  | {
      readonly kind: 'page';
      readonly sessionId: string;
      readonly revision: number;
      readonly automations: readonly AutomationProjection[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly kind: 'automation';
      readonly sessionId: string;
      readonly revision: number;
      readonly automation: AutomationProjection | null;
    };

export type AutomationMutateInput =
  | {
      readonly kind: 'create';
      readonly sessionId: string;
      readonly name: string;
      readonly prompt: string;
      readonly schedule: AutomationSchedule;
      readonly maxFires?: number;
      readonly requiredCapabilityGroups?: readonly string[];
    }
  | {
      readonly kind: 'delete' | 'pause' | 'resume';
      readonly sessionId: string;
      readonly automationId: string;
    };

export type AutomationMutationRejection =
  | 'not_owned'
  | 'not_active'
  | 'not_paused'
  | 'fire_pending'
  | 'fire_budget_exhausted'
  | 'limit_reached'
  | 'invalid_schedule';

export type AutomationMutateResult =
  | {
      readonly kind: 'committed';
      readonly revision: number;
      readonly automation: AutomationProjection | null;
    }
  | { readonly kind: 'rejected'; readonly reason: AutomationMutationRejection };

export const AUTOMATION_OPERATION_SPECS = {
  'automation.query': defineOperation<
    AutomationQueryInput,
    AutomationQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeAutomationQueryInput,
    decodeOutput: decodeAutomationQueryResult,
  }),
  'automation.mutate': defineOperation<
    AutomationMutateInput,
    AutomationMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeAutomationMutateInput,
    decodeOutput: decodeAutomationMutateResult,
  }),
} as const;

export function decodeAutomationQueryInput(value: unknown): AutomationQueryInput {
  const record = requireRecord(value, 'Automation query input');
  if (record.kind === 'list_start') {
    const input = requireExactRecord(record, 'Automation list start input', ['kind', 'sessionId']);
    return { kind: 'list_start', sessionId: requireEntityId(input.sessionId, 'sessionId') };
  }
  if (record.kind === 'list_continue') {
    const input = requireExactRecord(record, 'Automation list continuation input', [
      'kind',
      'sessionId',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      revision: requireCount(input.revision, 'Automation revision'),
      cursor: requireEntityId(input.cursor, 'Automation cursor'),
    };
  }
  if (record.kind === 'get') {
    const input = requireExactRecord(record, 'Automation get input', [
      'kind',
      'sessionId',
      'automationId',
    ]);
    return {
      kind: 'get',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      automationId: requireEntityId(input.automationId, 'automationId'),
    };
  }
  throw invalidProtocolFrame('Invalid Automation query kind');
}

export function decodeAutomationQueryResult(value: unknown): AutomationQueryResult {
  const record = requireRecord(value, 'Automation query result');
  if (record.kind === 'revision_changed') {
    const result = requireExactRecord(record, 'Automation revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: requireCount(result.expected, 'expected Automation revision'),
      actual: requireCount(result.actual, 'actual Automation revision'),
    };
  }
  if (record.kind === 'automation') {
    const result = requireExactRecord(record, 'Automation get result', [
      'kind',
      'sessionId',
      'revision',
      'automation',
    ]);
    const decoded: AutomationQueryResult = {
      kind: 'automation',
      sessionId: requireEntityId(result.sessionId, 'sessionId'),
      revision: requireCount(result.revision, 'Automation revision'),
      automation: result.automation === null ? null : decodeAutomationProjection(result.automation),
    };
    requireEncodedByteLimit(decoded, 'Automation get result', AUTOMATION_RESULT_MAX_BYTES);
    return decoded;
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid Automation query result kind');
  const result = requireExactRecord(record, 'Automation page result', [
    'kind',
    'sessionId',
    'revision',
    'automations',
    'nextCursor',
  ]);
  if (!Array.isArray(result.automations) || result.automations.length > AUTOMATION_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Automation page exceeds item limit');
  }
  const decoded: AutomationQueryResult = {
    kind: 'page',
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    revision: requireCount(result.revision, 'Automation revision'),
    automations: result.automations.map(decodeAutomationProjection),
    nextCursor:
      result.nextCursor === null
        ? null
        : requireEntityId(result.nextCursor, 'Automation next cursor'),
  };
  requireEncodedByteLimit(decoded, 'Automation page result', AUTOMATION_RESULT_MAX_BYTES);
  return decoded;
}

export function decodeAutomationMutateInput(value: unknown): AutomationMutateInput {
  const record = requireRecord(value, 'Automation mutation input');
  if (record.kind === 'create') {
    const input = requireShapedRecord(
      record,
      'Automation create input',
      ['kind', 'sessionId', 'name', 'prompt', 'schedule'],
      ['maxFires', 'requiredCapabilityGroups'],
    );
    const maxFires =
      input.maxFires === undefined ? undefined : positiveCount(input.maxFires, 'maxFires');
    if (maxFires !== undefined && maxFires > AUTOMATION_MAX_FIRES) {
      throw invalidProtocolFrame('Automation maxFires is out of range');
    }
    const requiredCapabilityGroups = decodeRequiredCapabilityGroups(input.requiredCapabilityGroups);
    return {
      kind: 'create',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      name: requireAutomationText(input.name, 'Automation name', AUTOMATION_NAME_LIMIT, true),
      prompt: requireAutomationText(
        input.prompt,
        'Automation prompt',
        AUTOMATION_PROMPT_LIMIT,
        true,
      ),
      schedule: decodeAutomationSchedule(input.schedule),
      ...(maxFires === undefined ? {} : { maxFires }),
      ...(requiredCapabilityGroups === undefined ? {} : { requiredCapabilityGroups }),
    };
  }
  if (record.kind === 'delete' || record.kind === 'pause' || record.kind === 'resume') {
    const input = requireExactRecord(record, 'Automation mutation input', [
      'kind',
      'sessionId',
      'automationId',
    ]);
    return {
      kind: record.kind,
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      automationId: requireEntityId(input.automationId, 'automationId'),
    };
  }
  throw invalidProtocolFrame('Invalid Automation mutation kind');
}

function decodeRequiredCapabilityGroups(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AUTOMATION_MAX_CAPABILITY_REQUIREMENTS) {
    throw invalidProtocolFrame('Invalid Automation required capability groups');
  }
  const groups = value.map((group) => requireEntityId(group, 'capability group id'));
  if (new Set(groups).size !== groups.length) {
    throw invalidProtocolFrame('Duplicate Automation required capability group');
  }
  return groups;
}

export function decodeAutomationMutateResult(value: unknown): AutomationMutateResult {
  const record = requireRecord(value, 'Automation mutation result');
  if (record.kind === 'rejected') {
    const result = requireExactRecord(record, 'Automation rejected result', ['kind', 'reason']);
    if (!isMutationRejection(result.reason)) {
      throw invalidProtocolFrame('Invalid Automation rejection reason');
    }
    return { kind: 'rejected', reason: result.reason };
  }
  if (record.kind !== 'committed') {
    throw invalidProtocolFrame('Invalid Automation mutation result kind');
  }
  const result = requireExactRecord(record, 'Automation committed result', [
    'kind',
    'revision',
    'automation',
  ]);
  const decoded: AutomationMutateResult = {
    kind: 'committed',
    revision: requireCount(result.revision, 'Automation revision'),
    automation: result.automation === null ? null : decodeAutomationProjection(result.automation),
  };
  requireEncodedByteLimit(decoded, 'Automation mutation result', AUTOMATION_RESULT_MAX_BYTES);
  return decoded;
}

export function decodeAutomationProjection(value: unknown): AutomationProjection {
  const record = requireExactRecord(value, 'Automation projection', [
    'id',
    'name',
    'status',
    'prompt',
    'sessionId',
    'schedule',
    'createdAt',
    'updatedAt',
    'nextFireAt',
    'lastFireAt',
    'lastRunId',
    'fireCount',
    'maxFires',
    'expiresAt',
    'lastError',
    'consecutiveFailures',
    'deferredFireCount',
    'firePending',
    'waiting',
  ]);
  if (
    record.status !== 'active' &&
    record.status !== 'paused' &&
    record.status !== 'completed' &&
    record.status !== 'expired'
  ) {
    throw invalidProtocolFrame('Invalid Automation projection status');
  }
  if (typeof record.firePending !== 'boolean') {
    throw invalidProtocolFrame('Invalid Automation projection flag');
  }
  return {
    id: requireEntityId(record.id, 'Automation id'),
    name: requireAutomationText(record.name, 'Automation name', AUTOMATION_NAME_LIMIT),
    status: record.status,
    prompt: requireAutomationText(record.prompt, 'Automation prompt', AUTOMATION_PROMPT_LIMIT),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    schedule: decodeAutomationSchedule(record.schedule),
    createdAt: requireCount(record.createdAt, 'createdAt'),
    updatedAt: requireCount(record.updatedAt, 'updatedAt'),
    nextFireAt: nullableCount(record.nextFireAt, 'nextFireAt'),
    lastFireAt: nullableCount(record.lastFireAt, 'lastFireAt'),
    lastRunId: record.lastRunId === null ? null : requireEntityId(record.lastRunId, 'lastRunId'),
    fireCount: requireCount(record.fireCount, 'fireCount'),
    maxFires: nullablePositiveCount(record.maxFires, 'maxFires'),
    expiresAt: nullableCount(record.expiresAt, 'expiresAt'),
    lastError:
      record.lastError === null
        ? null
        : requireAutomationText(record.lastError, 'lastError', AUTOMATION_LAST_ERROR_LIMIT),
    consecutiveFailures: requireCount(record.consecutiveFailures, 'consecutiveFailures'),
    deferredFireCount: requireCount(record.deferredFireCount, 'deferredFireCount'),
    firePending: record.firePending,
    waiting: record.waiting === null ? null : decodeAutomationWaitingState(record.waiting),
  };
}

function decodeAutomationWaitingState(value: unknown): AutomationWaitingState {
  const record = requireExactRecord(value, 'Automation waiting state', [
    'reason',
    'since',
    'message',
  ]);
  if (record.reason !== 'client_capability_provider_unavailable') {
    throw invalidProtocolFrame('Invalid Automation waiting reason');
  }
  return {
    reason: record.reason,
    since: requireCount(record.since, 'Automation waiting since'),
    message: requireAutomationText(
      record.message,
      'Automation waiting message',
      AUTOMATION_LAST_ERROR_LIMIT,
    ),
  };
}

function decodeAutomationSchedule(value: unknown): AutomationSchedule {
  const record = requireRecord(value, 'Automation schedule');
  if (record.type === 'cron') {
    const schedule = requireExactRecord(record, 'cron Automation schedule', ['type', 'expression']);
    return {
      type: 'cron',
      expression: requireAutomationText(
        schedule.expression,
        'cron expression',
        AUTOMATION_CRON_EXPRESSION_LIMIT,
      ),
    };
  }
  if (record.type === 'interval') {
    const schedule = requireExactRecord(record, 'interval Automation schedule', [
      'type',
      'seconds',
    ]);
    const seconds = positiveCount(schedule.seconds, 'interval seconds');
    if (seconds < 10 || seconds > 86_400) {
      throw invalidProtocolFrame('Automation interval is out of range');
    }
    return { type: 'interval', seconds };
  }
  if (record.type === 'once') {
    const schedule = requireExactRecord(record, 'one-shot Automation schedule', [
      'type',
      'delaySeconds',
    ]);
    const delaySeconds = positiveCount(schedule.delaySeconds, 'one-shot delay');
    if (delaySeconds < 5 || delaySeconds > 86_400) {
      throw invalidProtocolFrame('Automation one-shot delay is out of range');
    }
    return { type: 'once', delaySeconds };
  }
  throw invalidProtocolFrame('Invalid Automation schedule kind');
}

function positiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function requireAutomationText(
  value: unknown,
  label: string,
  limit: Parameters<typeof isAutomationTextWithinLimit>[1],
  nonblank = false,
): string {
  const decoded = requireUtf8String(value, label, limit.maxBytes);
  if (!isAutomationTextWithinLimit(decoded, limit, { nonblank })) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return decoded;
}

function nullableCount(value: unknown, label: string): number | null {
  return value === null ? null : requireCount(value, label);
}

function nullablePositiveCount(value: unknown, label: string): number | null {
  return value === null ? null : positiveCount(value, label);
}

function isMutationRejection(value: unknown): value is AutomationMutationRejection {
  return (
    value === 'not_owned' ||
    value === 'not_active' ||
    value === 'not_paused' ||
    value === 'fire_pending' ||
    value === 'fire_budget_exhausted' ||
    value === 'limit_reached' ||
    value === 'invalid_schedule'
  );
}
