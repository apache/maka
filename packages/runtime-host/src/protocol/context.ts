import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { decodeTurnSnapshot, type TurnSnapshot } from './turn.js';

export interface ContextDiagnosticsQueryInput {
  readonly sessionId: string;
}

export interface ContextCompactInput {
  readonly sessionId: string;
  readonly turnId: string;
}

export type ContextCompactResult = TurnSnapshot;

export interface ContextDiagnosticsSegment {
  readonly kind: 'system_instructions' | 'tool_definitions' | 'messages' | 'other';
  readonly bytes: number;
}

/** One tool's schema, sized on its own, so a reader knows which to remove. */
export interface ContextDiagnosticsTool {
  readonly name: string;
  readonly bytes: number;
}

/**
 * What the latest request was made of, in bytes of serialized request (#2323).
 *
 * Bytes cross the wire; `bytes / 4` does not. The estimate is a display rule,
 * made and labelled `≈` where it is shown — a figure rounded into this frame
 * could no longer be labelled at all.
 */
export interface ContextDiagnosticsComposition {
  readonly segments: readonly ContextDiagnosticsSegment[];
  readonly tools?: readonly ContextDiagnosticsTool[];
  readonly remainingTools?: { readonly count: number; readonly bytes: number };
  readonly unlabelledToolBytes?: number;
}

export type ContextDiagnosticsResult =
  | {
      readonly status: 'unavailable';
      readonly reason: 'no_completed_request' | 'trace_unavailable';
    }
  | {
      readonly status: 'available';
      readonly providerId: string;
      readonly modelId: string;
      readonly completedAt: number;
      readonly inputTokens?: number;
      /** Provider-reported cache read for the same request, when it counted one. */
      readonly cacheReadInputTokens?: number;
      readonly contextWindow?: number;
      /**
       * Absent when the durable metering record has no matching capture — a
       * request that cannot explain itself says nothing rather than wearing an
       * older request's breakdown.
       */
      readonly composition?: ContextDiagnosticsComposition;
      readonly compaction?: {
        readonly kind: 'history';
        readonly phase: 'pre_turn' | 'mid_turn';
        readonly eventCount: number;
        readonly turnCount: number;
        readonly estimatedTokens: number;
      };
    };

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'internal_failure',
] as const;

export const CONTEXT_OPERATION_SPECS = {
  'context.diagnostics.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeContextDiagnosticsQueryInput,
    decodeOutput: decodeContextDiagnosticsResult,
  }),
  'context.compact': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [...QUERY_ERRORS, 'session_archived', 'session_busy', 'operation_conflict'] as const,
    decodeInput: decodeContextCompactInput,
    decodeOutput: decodeTurnSnapshot,
    assertOutputForInput: (input, output) => {
      if (input.sessionId !== output.sessionId || input.turnId !== output.turnId) {
        throw invalidProtocolFrame('Context compact changed operation identity');
      }
    },
  }),
} as const;

function decodeContextDiagnosticsQueryInput(value: unknown): ContextDiagnosticsQueryInput {
  const input = requireExactRecord(value, 'Context diagnostics query input', ['sessionId']);
  return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
}

function decodeContextCompactInput(value: unknown): ContextCompactInput {
  const input = requireExactRecord(value, 'Context compact input', ['sessionId', 'turnId']);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    turnId: requireEntityId(input.turnId, 'turnId'),
  };
}

function decodeContextDiagnosticsResult(value: unknown): ContextDiagnosticsResult {
  const record = requireShapedRecord(
    value,
    'Context diagnostics result',
    ['status'],
    [
      'reason',
      'providerId',
      'modelId',
      'completedAt',
      'inputTokens',
      'cacheReadInputTokens',
      'contextWindow',
      'composition',
      'compaction',
    ],
  );
  if (record.status === 'unavailable') {
    const unavailable = requireExactRecord(record, 'Unavailable context diagnostics', [
      'status',
      'reason',
    ]);
    if (
      unavailable.reason !== 'no_completed_request' &&
      unavailable.reason !== 'trace_unavailable'
    ) {
      throw invalidProtocolFrame('Invalid context diagnostics unavailable reason');
    }
    return { status: 'unavailable', reason: unavailable.reason };
  }
  if (record.status !== 'available') {
    throw invalidProtocolFrame('Invalid context diagnostics status');
  }
  const available = requireShapedRecord(
    record,
    'Available context diagnostics',
    ['status', 'providerId', 'modelId', 'completedAt'],
    ['inputTokens', 'cacheReadInputTokens', 'contextWindow', 'composition', 'compaction'],
  );
  return {
    status: 'available',
    providerId: requireString(available.providerId, 'providerId', 512),
    modelId: requireString(available.modelId, 'modelId', 512),
    completedAt: requireCount(available.completedAt, 'completedAt'),
    ...(available.inputTokens === undefined
      ? {}
      : { inputTokens: requireCount(available.inputTokens, 'inputTokens') }),
    ...(available.cacheReadInputTokens === undefined
      ? {}
      : {
          cacheReadInputTokens: requireCount(
            available.cacheReadInputTokens,
            'cacheReadInputTokens',
          ),
        }),
    ...(available.contextWindow === undefined
      ? {}
      : { contextWindow: requirePositiveCount(available.contextWindow, 'contextWindow') }),
    ...(available.composition === undefined
      ? {}
      : { composition: decodeContextDiagnosticsComposition(available.composition) }),
    ...(available.compaction === undefined
      ? {}
      : { compaction: decodeContextDiagnosticsCompaction(available.compaction) }),
  };
}

/**
 * The tool list is bounded on the wire for the same reason the evidence reads
 * are: a Host answer is built in memory, and a registry that grew without limit
 * would be a frame nobody sized.
 */
const MAX_COMPOSITION_TOOLS = 256;

function decodeContextDiagnosticsComposition(value: unknown): ContextDiagnosticsComposition {
  const composition = requireShapedRecord(
    value,
    'Context diagnostics composition',
    ['segments'],
    ['tools', 'remainingTools', 'unlabelledToolBytes'],
  );
  if (!Array.isArray(composition.segments) || composition.segments.length > 4) {
    throw invalidProtocolFrame('Invalid context diagnostics segments');
  }
  if (
    composition.tools !== undefined &&
    (!Array.isArray(composition.tools) || composition.tools.length > MAX_COMPOSITION_TOOLS)
  ) {
    throw invalidProtocolFrame('Invalid context diagnostics tools');
  }
  return {
    segments: composition.segments.map(decodeContextDiagnosticsSegment),
    ...(composition.tools === undefined
      ? {}
      : { tools: composition.tools.map(decodeContextDiagnosticsTool) }),
    ...(composition.remainingTools === undefined
      ? {}
      : { remainingTools: decodeContextDiagnosticsRemainder(composition.remainingTools) }),
    ...(composition.unlabelledToolBytes === undefined
      ? {}
      : {
          unlabelledToolBytes: requireCount(composition.unlabelledToolBytes, 'unlabelledToolBytes'),
        }),
  };
}

function decodeContextDiagnosticsRemainder(value: unknown): { count: number; bytes: number } {
  const remainder = requireExactRecord(value, 'Context diagnostics tool remainder', [
    'count',
    'bytes',
  ]);
  return {
    count: requireCount(remainder.count, 'count'),
    bytes: requireCount(remainder.bytes, 'bytes'),
  };
}

function decodeContextDiagnosticsTool(value: unknown): ContextDiagnosticsTool {
  const tool = requireExactRecord(value, 'Context diagnostics tool', ['name', 'bytes']);
  return {
    name: requireString(tool.name, 'name', 512),
    bytes: requireCount(tool.bytes, 'bytes'),
  };
}

function decodeContextDiagnosticsSegment(value: unknown): ContextDiagnosticsSegment {
  const segment = requireExactRecord(value, 'Context diagnostics segment', ['kind', 'bytes']);
  if (
    segment.kind !== 'system_instructions' &&
    segment.kind !== 'tool_definitions' &&
    segment.kind !== 'messages' &&
    segment.kind !== 'other'
  ) {
    throw invalidProtocolFrame('Invalid context diagnostics segment kind');
  }
  return { kind: segment.kind, bytes: requireCount(segment.bytes, 'bytes') };
}

function decodeContextDiagnosticsCompaction(
  value: unknown,
): NonNullable<Extract<ContextDiagnosticsResult, { status: 'available' }>['compaction']> {
  const compaction = requireExactRecord(value, 'Context diagnostics compaction', [
    'kind',
    'phase',
    'eventCount',
    'turnCount',
    'estimatedTokens',
  ]);
  if (
    compaction.kind !== 'history' ||
    (compaction.phase !== 'pre_turn' && compaction.phase !== 'mid_turn')
  ) {
    throw invalidProtocolFrame('Invalid context diagnostics compaction');
  }
  return {
    kind: 'history',
    phase: compaction.phase,
    eventCount: requireCount(compaction.eventCount, 'eventCount'),
    turnCount: requireCount(compaction.turnCount, 'turnCount'),
    estimatedTokens: requireCount(compaction.estimatedTokens, 'estimatedTokens'),
  };
}

function requirePositiveCount(value: unknown, name: string): number {
  const count = requireCount(value, name);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${name}`);
  return count;
}
