import type { LlmCallRecord, ToolInvocationRecord } from '@maka/core/usage-stats/types';
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

export interface TelemetryFile {
  readonly version: 1;
  readonly usageRecords: readonly PersistedLlmCallRecord[];
  readonly toolInvocations: readonly PersistedToolInvocationRecord[];
}

export interface DecodedTelemetryFile {
  readonly file: TelemetryFile;
  readonly legacyPricingOverrides: readonly unknown[];
  readonly requiresCanonicalPublication: boolean;
}

type ExactKeyShape<Value extends object> = {
  readonly [Key in keyof Value]-?: true;
};

function exactKeys<Value extends object>(shape: ExactKeyShape<Value>): ReadonlySet<string> {
  return new Set(Object.keys(shape));
}

const FILE_KEYS = new Set(['version', 'usageRecords', 'toolInvocations']);
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

export function emptyTelemetryFile(): TelemetryFile {
  return { version: 1, usageRecords: [], toolInvocations: [] };
}

export function decodeTelemetryFile(input: unknown): DecodedTelemetryFile {
  if (!isRecord(input)) throw invalid('expected an object');
  if (input.version === undefined) return decodeLegacyTelemetryFile(input);
  if (!hasOnlyKeys(input, FILE_KEYS)) {
    throw invalid('expected exactly version, usageRecords, toolInvocations');
  }
  if (input.version !== 1) throw invalid('expected version 1');
  assertArray(input, 'usageRecords');
  assertArray(input, 'toolInvocations');
  return {
    file: {
      version: 1,
      usageRecords: input.usageRecords.map(decodePersistedLlmCallRecord),
      toolInvocations: input.toolInvocations.map(decodePersistedToolInvocationRecord),
    },
    legacyPricingOverrides: [],
    requiresCanonicalPublication: false,
  };
}

function decodeLegacyTelemetryFile(input: Record<string, unknown>): DecodedTelemetryFile {
  const hasKnownSection =
    'usageRecords' in input || 'toolInvocations' in input || 'pricingOverrides' in input;
  if (!hasKnownSection) throw invalid('expected known telemetry sections');
  assertOptionalArray(input, 'usageRecords');
  assertOptionalArray(input, 'toolInvocations');
  assertOptionalArray(input, 'pricingOverrides');
  const usageRecords = (input.usageRecords ?? []) as unknown[];
  const toolInvocations = (input.toolInvocations ?? []) as unknown[];
  const pricingOverrides = (input.pricingOverrides ?? []) as unknown[];
  return {
    file: {
      version: 1,
      usageRecords: usageRecords.map((row) =>
        decodePersistedLlmCallRecord(normalizeLlmCallRecord(row)),
      ),
      toolInvocations: toolInvocations.map((row) =>
        decodePersistedToolInvocationRecord(normalizeToolInvocationRecord(row)),
      ),
    },
    legacyPricingOverrides: pricingOverrides,
    requiresCanonicalPublication: true,
  };
}

export function normalizeLlmCallRecord(input: unknown): PersistedLlmCallRecord {
  if (!isRecord(input)) throw invalid('LLM record must be an object');
  const row = input as Partial<PersistedLlmCallRecord>;
  const inputTokens = finiteNumber(row.inputTokens) ?? 0;
  const outputTokens = finiteNumber(row.outputTokens) ?? 0;
  const cacheHitInputTokens =
    finiteNumber(row.cacheHitInputTokens) ?? finiteNumber(row.cachedInputTokens) ?? 0;
  const cacheWriteInputTokens = finiteNumber(row.cacheWriteInputTokens) ?? 0;
  const cacheMissInputTokens =
    finiteNumber(row.cacheMissInputTokens) ??
    Math.max(0, inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
  const reasoningTokens = finiteNumber(row.reasoningTokens) ?? 0;
  const ts = finiteNumber(row.ts) ?? finiteNumber(row.startedAt) ?? 0;
  return {
    ...pickKnown(input, LLM_KEYS),
    id: typeof row.id === 'string' ? row.id : `usage_${row.turnId ?? ts}`,
    providerId: typeof row.providerId === 'string' ? row.providerId : 'unknown',
    modelId: typeof row.modelId === 'string' ? row.modelId : 'unknown',
    inputTokens,
    outputTokens,
    cacheHitInputTokens,
    cacheMissInputTokens,
    cachedInputTokens: cacheHitInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens: finiteNumber(row.totalTokens) ?? inputTokens + outputTokens + reasoningTokens,
    costUsd: finiteNumber(row.costUsd) ?? 0,
    latencyMs: finiteNumber(row.latencyMs) ?? 0,
    status: row.status === 'error' || row.status === 'aborted' ? row.status : 'success',
    startedAt: finiteNumber(row.startedAt) ?? ts,
    date: typeof row.date === 'string' ? row.date : new Date(ts).toISOString().slice(0, 10),
    ts,
  } as PersistedLlmCallRecord;
}

export function normalizeToolInvocationRecord(input: unknown): PersistedToolInvocationRecord {
  if (!isRecord(input)) throw invalid('tool invocation must be an object');
  const row = input as Partial<PersistedToolInvocationRecord>;
  const ts = finiteNumber(row.ts) ?? finiteNumber(row.startedAt) ?? 0;
  return {
    ...pickKnown(input, TOOL_KEYS),
    id: typeof row.id === 'string' ? row.id : `tool_${row.toolCallId ?? row.turnId ?? ts}`,
    toolName: typeof row.toolName === 'string' ? row.toolName : 'unknown',
    durationMs: finiteNumber(row.durationMs) ?? 0,
    status: row.status === 'error' || row.status === 'aborted' ? row.status : 'success',
    bytesIn: finiteNumber(row.bytesIn) ?? 0,
    bytesOut: finiteNumber(row.bytesOut) ?? 0,
    startedAt: finiteNumber(row.startedAt) ?? ts,
    date: typeof row.date === 'string' ? row.date : new Date(ts).toISOString().slice(0, 10),
    ts,
  } as PersistedToolInvocationRecord;
}

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
  if (!optionalEnum(input.callKind, new Set(['main', 'semantic_compact', 'history_compact']))) {
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

function assertArray(
  value: Record<string, unknown>,
  key: 'usageRecords' | 'toolInvocations',
): asserts value is Record<string, unknown> & Record<typeof key, unknown[]> {
  if (!Array.isArray(value[key])) throw invalid(`${key} must be an array`);
}

function assertOptionalArray(
  value: Record<string, unknown>,
  key: 'usageRecords' | 'toolInvocations' | 'pricingOverrides',
): void {
  if (key in value && !Array.isArray(value[key])) throw invalid(`${key} must be an array`);
}

function pickKnown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
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

function finiteNumber(value: unknown): number | undefined {
  return isNonNegativeFinite(value) ? value : undefined;
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
  return new Error(`Invalid telemetry file: ${message}`);
}
