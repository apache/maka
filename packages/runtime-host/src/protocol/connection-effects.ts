import {
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  decodeConnectionModelId,
  decodeConnectionTestSummary,
  decodeConnectionVersionBasis,
  RuntimePolicyDomainDecodeError,
  type ConnectionVersionBasis,
  type ModelDiscoverySource,
} from '@maka/core/runtime-policy';
import { requireCount, requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const EFFECT_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
  'persistence_failed',
  'commit_outcome_unknown',
] as const;

export const CONNECTION_EFFECT_CHANGED_DOMAINS = [
  'connection',
  'credential',
  'network_proxy',
] as const;
export type ConnectionEffectChangedDomain = (typeof CONNECTION_EFFECT_CHANGED_DOMAINS)[number];

export const CONNECTION_EFFECT_REJECTION_REASONS = [
  'connection_not_found',
  'connection_disabled',
  'provider_action_unavailable',
  'credential_not_configured',
] as const;
export type ConnectionEffectRejectionReason = (typeof CONNECTION_EFFECT_REJECTION_REASONS)[number];

export const CONNECTION_EFFECT_FAILURE_CLASSES = [
  'auth',
  'timeout',
  'provider_unavailable',
  'network',
  'invalid_response',
  'unknown',
] as const;
export type ConnectionEffectFailureClass = (typeof CONNECTION_EFFECT_FAILURE_CLASSES)[number];

export interface ConnectionModelFetchInput {
  readonly connectionId: string;
}

export interface ConnectionTestRunInput {
  readonly connectionId: string;
  readonly modelId: string | null;
}

interface ConnectionEffectCommitted {
  readonly kind: 'committed';
  readonly catalogRevision: number;
  readonly connection: ConnectionVersionBasis;
}

interface ConnectionEffectRejected {
  readonly kind: 'rejected';
  readonly reason: ConnectionEffectRejectionReason;
}

interface ConnectionEffectSuperseded {
  readonly kind: 'superseded';
  readonly changed: readonly ConnectionEffectChangedDomain[];
}

interface ConnectionEffectFailed {
  readonly kind: 'failed';
  readonly errorClass: ConnectionEffectFailureClass;
}

export type ConnectionModelFetchResult =
  | (ConnectionEffectCommitted & {
      readonly modelCount: number;
      readonly source: ModelDiscoverySource;
      readonly fetchedAt: number;
    })
  | ConnectionEffectRejected
  | ConnectionEffectSuperseded
  | ConnectionEffectFailed;

export type ConnectionTestProjection =
  | {
      readonly kind: 'verified';
      readonly checkedAt: string;
      readonly modelId: string;
      readonly latencyMs: number;
    }
  | {
      readonly kind: 'failed';
      readonly checkedAt: string;
      readonly modelId: string | null;
      readonly latencyMs: number | null;
      readonly statusCode: number | null;
      readonly errorClass: ConnectionEffectFailureClass;
    };

export type ConnectionTestRunResult =
  | (ConnectionEffectCommitted & {
      readonly test: ConnectionTestProjection;
    })
  | ConnectionEffectRejected
  | ConnectionEffectSuperseded;

export const CONNECTION_EFFECT_OPERATION_SPECS = {
  'connection.models.fetch': defineOperation<
    ConnectionModelFetchInput,
    ConnectionModelFetchResult,
    (typeof EFFECT_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: EFFECT_ERRORS,
    decodeInput: decodeConnectionModelFetchInput,
    decodeOutput: decodeConnectionModelFetchResult,
  }),
  'connection.test.run': defineOperation<
    ConnectionTestRunInput,
    ConnectionTestRunResult,
    (typeof EFFECT_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: EFFECT_ERRORS,
    decodeInput: decodeConnectionTestRunInput,
    decodeOutput: decodeConnectionTestRunResult,
  }),
} as const;

export function decodeConnectionModelFetchInput(value: unknown): ConnectionModelFetchInput {
  const input = requireExactRecord(value, 'connection model fetch input', ['connectionId']);
  return { connectionId: requireEntityId(input.connectionId, 'connectionId') };
}

export function decodeConnectionTestRunInput(value: unknown): ConnectionTestRunInput {
  const input = requireExactRecord(value, 'connection test input', ['connectionId', 'modelId']);
  return {
    connectionId: requireEntityId(input.connectionId, 'connectionId'),
    modelId:
      input.modelId === null ? null : decodeDomain(() => decodeConnectionModelId(input.modelId)),
  };
}

export function decodeConnectionModelFetchResult(value: unknown): ConnectionModelFetchResult {
  const result = requireRecord(value, 'connection model fetch result');
  if (result.kind === 'committed') {
    const committed = requireExactRecord(result, 'connection model fetch committed result', [
      'kind',
      'catalogRevision',
      'connection',
      'modelCount',
      'source',
      'fetchedAt',
    ]);
    return {
      ...decodeCommitted(committed, 'connection model fetch committed result'),
      modelCount: boundedInteger(
        committed.modelCount,
        'model count',
        1,
        CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
      ),
      source: modelDiscoverySource(committed.source),
      fetchedAt: requireCount(committed.fetchedAt, 'models fetched at'),
    };
  }
  if (result.kind === 'failed') {
    const failed = requireExactRecord(result, 'connection model fetch failed result', [
      'kind',
      'errorClass',
    ]);
    return { kind: 'failed', errorClass: effectFailureClass(failed.errorClass) };
  }
  return decodeNonEffectResult(result, 'connection model fetch result');
}

export function decodeConnectionTestRunResult(value: unknown): ConnectionTestRunResult {
  const result = requireRecord(value, 'connection test result');
  if (result.kind === 'committed') {
    const committed = requireExactRecord(result, 'connection test committed result', [
      'kind',
      'catalogRevision',
      'connection',
      'test',
    ]);
    return {
      ...decodeCommitted(committed, 'connection test committed result'),
      test: decodeConnectionTestProjection(committed.test),
    };
  }
  return decodeNonEffectResult(result, 'connection test result');
}

function decodeConnectionTestProjection(value: unknown): ConnectionTestProjection {
  const projection = requireRecord(value, 'connection test projection');
  if (projection.kind === 'verified') {
    const verified = requireExactRecord(projection, 'verified connection test projection', [
      'kind',
      'checkedAt',
      'modelId',
      'latencyMs',
    ]);
    return {
      kind: 'verified',
      checkedAt: connectionTestCheckedAt(verified.checkedAt),
      modelId: decodeDomain(() => decodeConnectionModelId(verified.modelId)),
      latencyMs: requireCount(verified.latencyMs, 'connection test latency'),
    };
  }
  const failed = requireExactRecord(projection, 'failed connection test projection', [
    'kind',
    'checkedAt',
    'modelId',
    'latencyMs',
    'statusCode',
    'errorClass',
  ]);
  if (failed.kind !== 'failed') throw invalidProtocolFrame('Invalid connection test projection');
  return {
    kind: 'failed',
    checkedAt: connectionTestCheckedAt(failed.checkedAt),
    modelId:
      failed.modelId === null ? null : decodeDomain(() => decodeConnectionModelId(failed.modelId)),
    latencyMs:
      failed.latencyMs === null ? null : requireCount(failed.latencyMs, 'connection test latency'),
    statusCode:
      failed.statusCode === null
        ? null
        : boundedInteger(failed.statusCode, 'connection test status code', 100, 599),
    errorClass: effectFailureClass(failed.errorClass),
  };
}

function connectionTestCheckedAt(value: unknown): string {
  return decodeDomain(() => decodeConnectionTestSummary({ status: 'verified', checkedAt: value }))
    .checkedAt;
}

function decodeCommitted(value: Record<string, unknown>, label: string): ConnectionEffectCommitted {
  if (value.kind !== 'committed') throw invalidProtocolFrame(`Invalid ${label}`);
  return {
    kind: 'committed',
    catalogRevision: requireCount(value.catalogRevision, 'connection catalog revision'),
    connection: decodeDomain(() => decodeConnectionVersionBasis(value.connection)),
  };
}

function decodeNonEffectResult(
  value: Record<string, unknown>,
  label: string,
): ConnectionEffectRejected | ConnectionEffectSuperseded {
  if (value.kind === 'rejected') {
    const rejected = requireExactRecord(value, label, ['kind', 'reason']);
    return { kind: 'rejected', reason: rejectionReason(rejected.reason) };
  }
  if (value.kind === 'superseded') {
    const superseded = requireExactRecord(value, label, ['kind', 'changed']);
    if (
      !Array.isArray(superseded.changed) ||
      superseded.changed.length === 0 ||
      superseded.changed.length > CONNECTION_EFFECT_CHANGED_DOMAINS.length
    ) {
      throw invalidProtocolFrame('Invalid connection effect changed domains');
    }
    const changed = superseded.changed.map(effectChangedDomain);
    if (new Set(changed).size !== changed.length) {
      throw invalidProtocolFrame('Duplicate connection effect changed domain');
    }
    return { kind: 'superseded', changed };
  }
  throw invalidProtocolFrame(`Invalid ${label}`);
}

function rejectionReason(value: unknown): ConnectionEffectRejectionReason {
  if (
    typeof value === 'string' &&
    (CONNECTION_EFFECT_REJECTION_REASONS as readonly string[]).includes(value)
  ) {
    return value as ConnectionEffectRejectionReason;
  }
  throw invalidProtocolFrame('Invalid connection effect rejection reason');
}

function effectChangedDomain(value: unknown): ConnectionEffectChangedDomain {
  if (
    typeof value === 'string' &&
    (CONNECTION_EFFECT_CHANGED_DOMAINS as readonly string[]).includes(value)
  ) {
    return value as ConnectionEffectChangedDomain;
  }
  throw invalidProtocolFrame('Invalid connection effect changed domain');
}

function effectFailureClass(value: unknown): ConnectionEffectFailureClass {
  if (
    typeof value === 'string' &&
    (CONNECTION_EFFECT_FAILURE_CLASSES as readonly string[]).includes(value)
  ) {
    return value as ConnectionEffectFailureClass;
  }
  throw invalidProtocolFrame('Invalid connection effect failure class');
}

function modelDiscoverySource(value: unknown): ModelDiscoverySource {
  if (value === 'fetched' || value === 'fallback') return value;
  throw invalidProtocolFrame('Invalid model discovery source');
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}

function decodeDomain<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RuntimePolicyDomainDecodeError) {
      throw invalidProtocolFrame(error.message);
    }
    throw error;
  }
}
