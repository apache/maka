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
  MODEL_CALL_KINDS,
  type LlmCallRecord,
  type ToolInvocationRecord,
} from '@maka/core/usage-stats/types';
import { isContextBudgetDiagnostic, isPromptSegmentEstimate } from '@maka/core/usage-record-schema';

export type PersistedLlmCallRecord = LlmCallRecord & {
  id: string;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  date: string;
  ts: number;
};

export type PersistedToolInvocationRecord = ToolInvocationRecord & {
  id: string;
  argsSummary?: string;
  bytesIn: number;
  bytesOut: number;
  date: string;
  ts: number;
};

type ExactKeyShape<Value extends object> = {
  readonly [Key in keyof Value]-?: true;
};

function exactKeys<Value extends object>(shape: ExactKeyShape<Value>): ReadonlySet<string> {
  return new Set(Object.keys(shape));
}

const LLM_KEYS = exactKeys<PersistedLlmCallRecord>({
  sessionId: true,
  turnId: true,
  callKind: true,
  callId: true,
  connectionSlug: true,
  providerId: true,
  modelId: true,
  inputTokens: true,
  outputTokens: true,
  cacheHitInputTokens: true,
  cacheMissInputTokens: true,
  cachedInputTokens: true,
  cacheWriteInputTokens: true,
  reasoningTokens: true,
  totalTokens: true,
  rawFinishReason: true,
  rawUsage: true,
  latencyMs: true,
  status: true,
  errorClass: true,
  costUsd: true,
  startedAt: true,
  systemPromptHash: true,
  prefixHash: true,
  prefixChangeReason: true,
  requestShapeHash: true,
  requestShapeChangeReason: true,
  toolSchemaChangeReason: true,
  toolAvailability: true,
  cacheMissInputSource: true,
  promptSegments: true,
  contextBudget: true,
  id: true,
  date: true,
  ts: true,
});
const TOOL_KEYS = exactKeys<PersistedToolInvocationRecord>({
  sessionId: true,
  turnId: true,
  toolCallId: true,
  toolName: true,
  providerId: true,
  modelId: true,
  durationMs: true,
  status: true,
  errorClass: true,
  argsSummary: true,
  resultSummary: true,
  bytesIn: true,
  bytesOut: true,
  startedAt: true,
  id: true,
  date: true,
  ts: true,
});
const PREFIX_CHANGE_REASONS = new Set([
  'first_turn',
  'system_prompt_changed',
  'tool_schema_changed',
  'provider_options_changed',
  'model_or_provider_changed',
  'history_projection_changed',
  'stable',
  'unknown',
]);
const TOOL_SCHEMA_CHANGE_REASONS = new Set([
  'tool_schema_changed',
  'tool_source_enabled',
  'tool_source_state_changed',
]);

export function decodePersistedLlmCallRecord(input: unknown): PersistedLlmCallRecord {
  if (!isRecord(input) || !hasOnlyKeys(input, LLM_KEYS)) throw invalid('invalid LLM row keys');
  if (!strings(input, ['id', 'providerId', 'modelId', 'date'])) {
    throw invalid('invalid required LLM string');
  }
  if (
    !nonNegativeNumbers(input, [
      'inputTokens',
      'outputTokens',
      'cacheHitInputTokens',
      'cacheMissInputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'reasoningTokens',
      'totalTokens',
      'latencyMs',
      'costUsd',
      'startedAt',
      'ts',
    ])
  ) {
    throw invalid('invalid required LLM number');
  }
  if (input.cachedInputTokens !== input.cacheHitInputTokens) {
    throw invalid('cachedInputTokens must equal cacheHitInputTokens');
  }
  if (!['success', 'error', 'aborted'].includes(input.status as string)) {
    throw invalid('invalid LLM status');
  }
  if (
    !optionalStrings(input, [
      'sessionId',
      'turnId',
      'callId',
      'connectionSlug',
      'rawFinishReason',
      'errorClass',
      'systemPromptHash',
      'prefixHash',
      'requestShapeHash',
    ])
  ) {
    throw invalid('invalid optional LLM string');
  }
  if (!optionalEnum(input.callKind, new Set(MODEL_CALL_KINDS))) {
    throw invalid('invalid callKind');
  }
  if (!optionalEnum(input.prefixChangeReason, PREFIX_CHANGE_REASONS)) {
    throw invalid('invalid prefixChangeReason');
  }
  if (!optionalEnum(input.requestShapeChangeReason, PREFIX_CHANGE_REASONS)) {
    throw invalid('invalid requestShapeChangeReason');
  }
  if (!optionalEnum(input.toolSchemaChangeReason, TOOL_SCHEMA_CHANGE_REASONS)) {
    throw invalid('invalid toolSchemaChangeReason');
  }
  if (!optionalEnum(input.cacheMissInputSource, new Set(['explicit', 'derived']))) {
    throw invalid('invalid cacheMissInputSource');
  }
  if (input.rawUsage !== undefined && !isRawUsage(input.rawUsage)) {
    throw invalid('invalid rawUsage');
  }
  if (input.toolAvailability !== undefined && !isToolAvailability(input.toolAvailability)) {
    throw invalid('invalid toolAvailability');
  }
  if (
    input.promptSegments !== undefined &&
    (!Array.isArray(input.promptSegments) ||
      !input.promptSegments.every(
        (segment) => isPromptSegmentEstimate(segment) && hasNoNegativeNumbers(segment),
      ))
  ) {
    throw invalid('invalid promptSegments');
  }
  if (
    input.contextBudget !== undefined &&
    (!isContextBudgetDiagnostic(input.contextBudget) ||
      !contextBudgetCountsAreNonNegative(input.contextBudget))
  ) {
    throw invalid('invalid contextBudget');
  }
  return cloneAndFreeze(input) as unknown as PersistedLlmCallRecord;
}

export function decodePersistedToolInvocationRecord(input: unknown): PersistedToolInvocationRecord {
  if (!isRecord(input) || !hasOnlyKeys(input, TOOL_KEYS)) throw invalid('invalid tool row keys');
  if (!strings(input, ['id', 'toolName', 'date'])) {
    throw invalid('invalid required tool string');
  }
  if (!nonNegativeNumbers(input, ['durationMs', 'bytesIn', 'bytesOut', 'startedAt', 'ts'])) {
    throw invalid('invalid required tool number');
  }
  if (!['success', 'error', 'aborted'].includes(input.status as string)) {
    throw invalid('invalid tool status');
  }
  if (
    !optionalStrings(input, [
      'sessionId',
      'turnId',
      'toolCallId',
      'providerId',
      'modelId',
      'errorClass',
      'argsSummary',
    ])
  ) {
    throw invalid('invalid optional tool string');
  }
  if (input.resultSummary !== undefined && !isToolResultSummary(input.resultSummary)) {
    throw invalid('invalid tool resultSummary');
  }
  return cloneAndFreeze(input) as unknown as PersistedToolInvocationRecord;
}

const RAW_USAGE_KEYS = new Set([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens',
  'prompt_tokens_details',
  'completion_tokens_details',
]);
const RAW_USAGE_NUMBERS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens',
] as const;

function isRawUsage(input: unknown): boolean {
  return (
    isRecord(input) &&
    hasOnlyKeys(input, RAW_USAGE_KEYS) &&
    optionalNonNegativeNumbers(input, RAW_USAGE_NUMBERS) &&
    isTokenDetails(input.prompt_tokens_details, 'cached_tokens') &&
    isTokenDetails(input.completion_tokens_details, 'reasoning_tokens')
  );
}

function isTokenDetails(input: unknown, key: string): boolean {
  return (
    input === undefined ||
    (isRecord(input) && hasOnlyKeys(input, new Set([key])) && optionalNonNegative(input[key]))
  );
}

const TOOL_AVAILABILITY_NUMBERS = [
  'visibleToolCount',
  'fullToolCount',
  'hiddenToolCount',
  'visibleToolSchemaChars',
  'fullToolSchemaChars',
  'toolSchemaCharReduction',
  'estimatedToolSchemaTokenReduction',
] as const;
const TOOL_AVAILABILITY_KEYS = new Set([
  'mode',
  'enabledSourceIds',
  'availableSourceIds',
  'connectorToolName',
  'visibleToolNamesBySource',
  ...TOOL_AVAILABILITY_NUMBERS,
]);

function isToolAvailability(input: unknown): boolean {
  return (
    isRecord(input) &&
    hasOnlyKeys(input, TOOL_AVAILABILITY_KEYS) &&
    input.mode === 'economy' &&
    isStringArray(input.enabledSourceIds) &&
    optionalStringArray(input.availableSourceIds) &&
    optionalString(input.connectorToolName) &&
    (input.visibleToolNamesBySource === undefined ||
      (isRecord(input.visibleToolNamesBySource) &&
        Object.values(input.visibleToolNamesBySource).every(isStringArray))) &&
    optionalNonNegativeNumbers(input, TOOL_AVAILABILITY_NUMBERS)
  );
}

function isToolResultSummary(input: unknown): boolean {
  const numberKeys = [
    'itemCount',
    'startedItemCount',
    'completedItemCount',
    'failedItemCount',
    'cancelledItemCount',
    'artifactCount',
  ] as const;
  return (
    isRecord(input) &&
    hasOnlyKeys(input, new Set(['kind', 'status', ...numberKeys])) &&
    typeof input.kind === 'string' &&
    optionalString(input.status) &&
    optionalNonNegativeNumbers(input, numberKeys)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function strings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}

function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => optionalString(value[key]));
}

function nonNegativeNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isNonNegativeFinite(value[key]));
}

function optionalNonNegativeNumbers(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => optionalNonNegative(value[key]));
}

function optionalNonNegative(value: unknown): boolean {
  return value === undefined || isNonNegativeFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalEnum(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === undefined || (typeof value === 'string' && allowed.has(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hasNoNegativeNumbers(value: unknown): boolean {
  if (typeof value === 'number') return value >= 0;
  if (Array.isArray(value)) return value.every(hasNoNegativeNumbers);
  if (isRecord(value)) return Object.values(value).every(hasNoNegativeNumbers);
  return true;
}

function contextBudgetCountsAreNonNegative(value: unknown): boolean {
  if (!isRecord(value)) return hasNoNegativeNumbers(value);
  return Object.entries(value).every(([key, entry]) =>
    key === 'compactionDecisions'
      ? entry === undefined ||
        (Array.isArray(entry) && entry.every(compactionDecisionCountsAreNonNegative))
      : hasNoNegativeNumbers(entry),
  );
}

function compactionDecisionCountsAreNonNegative(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => key === 'estimatedTokensSaved' || hasNoNegativeNumbers(entry),
  );
}

function cloneAndFreeze<T>(value: T): T {
  let clone: T;
  try {
    clone = structuredClone(value);
  } catch (error) {
    throw invalid(`record must be structured-cloneable: ${String(error)}`);
  }
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): Error {
  return new Error(`Invalid telemetry record: ${message}`);
}
