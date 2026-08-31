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
  LATEST_CONTEXT_PROJECTION_TYPE,
  type AgentRunEvent,
  type LatestContextProjectionInput,
} from '@maka/core/agent-run';

export { LATEST_CONTEXT_PROJECTION_TYPE };
import type {
  ContextDiagnosticsCompaction,
  ContextDiagnosticsComposition,
} from './context-diagnostics.js';
import { foldPromptComposition, type SizedRequestSegment } from './prompt-composition.js';

/**
 * One request's context, frozen by the transaction that committed it (#2323).
 *
 * The reason this is a record rather than a read-time join: the canonical
 * attempt owns the request facts, while the compaction boundary has its own
 * recovery lifecycle. Reading independent "latest" records would produce a
 * snapshot whose parts describe different moments.
 *
 * So the facts are copied into one derived row by the same storage transaction
 * that commits the canonical completed-main attempt. There is one durable
 * authority for the request — the attempt — and this is a product of it, not a
 * second record racing it. A failed or aborted attempt, or a compaction's own
 * request, never authorises a write, so the last good answer stands.
 */

export const LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 2 as const;

export interface LatestContextSnapshot {
  schemaVersion: typeof LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  /** The request this describes. Frozen so every field below belongs to it. */
  attemptId: string;
  providerId: string;
  modelId: string;
  completedAt: number;
  /** Provider-reported, as metered. Absent stays absent (#1679). */
  inputTokens?: number;
  cacheReadInputTokens?: number;
  /** The window this call was metered against, frozen at call time. */
  contextWindow?: number;
  /**
   * What the prompt was made of. Absent when THIS canonical attempt carries no
   * prepared-request observation — a request explains itself or says nothing,
   * never borrows another request's breakdown.
   */
  composition?: ContextDiagnosticsComposition;
  /** The boundary that applied when this request was built, if any. */
  compaction?: ContextDiagnosticsCompaction;
}

/**
 * The derived row for one completed main request, ready to commit alongside
 * the attempt that authorises it.
 *
 * `orderedAt` is the request's own completion, so a row arriving late from an
 * overlapping turn cannot move the answer backwards.
 */
export function latestContextProjectionInput(
  attempt: LatestContextFacts,
  segments: readonly SizedRequestSegment[] | undefined,
  compaction: ContextDiagnosticsCompaction | undefined,
): LatestContextProjectionInput {
  const composition = segments ? foldPromptComposition(segments) : undefined;
  const snapshot: LatestContextSnapshot = {
    schemaVersion: LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    attemptId: attempt.attemptId,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    completedAt: attempt.completedAt,
    ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
    ...(attempt.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: attempt.cacheReadInputTokens }
      : {}),
    ...(attempt.contextWindow !== undefined ? { contextWindow: attempt.contextWindow } : {}),
    ...(composition ? { composition } : {}),
    ...(compaction ? { compaction } : {}),
  };
  return {
    attemptId: attempt.attemptId,
    orderedAt: attempt.completedAt,
    snapshot: snapshot as unknown as Record<string, unknown>,
  };
}

/** The metered facts a snapshot freezes, as the canonical attempt carries them. */
export interface LatestContextFacts {
  attemptId: string;
  providerId: string;
  modelId: string;
  completedAt: number;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow?: number;
}

/**
 * Reads a snapshot back off the ledger.
 *
 * Only the current observation-backed schema is trusted. Older projections
 * were derived from the retired capture-event path; newer projections may
 * change semantics this build cannot safely infer. Either case falls back to the
 * canonical ledger and repairs the derived row.
 */
export function readLatestContextSnapshot(
  event: Pick<AgentRunEvent, 'type' | 'data'> | undefined,
): LatestContextSnapshot | undefined {
  if (!event) return undefined;
  const record = shapedRecord(
    event.data,
    ['schemaVersion', 'attemptId', 'providerId', 'modelId', 'completedAt'],
    ['inputTokens', 'cacheReadInputTokens', 'contextWindow', 'composition', 'compaction'],
  );
  if (!record) return undefined;
  if (
    record.schemaVersion !== LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION ||
    !isBoundedString(record.attemptId, 512) ||
    !isBoundedString(record.providerId, 512) ||
    !isBoundedString(record.modelId, 512) ||
    !isCount(record.completedAt) ||
    !isOptionalCount(record.inputTokens) ||
    !isOptionalCount(record.cacheReadInputTokens) ||
    (record.contextWindow !== undefined &&
      (!isCount(record.contextWindow) || record.contextWindow === 0)) ||
    (record.composition !== undefined && !isContextDiagnosticsComposition(record.composition)) ||
    (record.compaction !== undefined && !isContextDiagnosticsCompaction(record.compaction))
  ) {
    return undefined;
  }
  return record as unknown as LatestContextSnapshot;
}

function isContextDiagnosticsComposition(value: unknown): value is ContextDiagnosticsComposition {
  const composition = shapedRecord(
    value,
    ['segments'],
    ['tools', 'remainingTools', 'unlabelledToolBytes'],
  );
  if (
    !composition ||
    !Array.isArray(composition.segments) ||
    composition.segments.length === 0 ||
    composition.segments.length > 4 ||
    !composition.segments.every(isContextDiagnosticsSegment) ||
    (composition.tools !== undefined &&
      (!Array.isArray(composition.tools) ||
        composition.tools.length === 0 ||
        composition.tools.length > 64 ||
        !composition.tools.every(isContextDiagnosticsTool))) ||
    (composition.remainingTools !== undefined &&
      !isContextDiagnosticsRemainder(composition.remainingTools)) ||
    !isOptionalCount(composition.unlabelledToolBytes) ||
    (composition.unlabelledToolBytes !== undefined && composition.unlabelledToolBytes === 0)
  ) {
    return false;
  }
  const valid = composition as unknown as ContextDiagnosticsComposition;
  const segmentOrder = ['system_instructions', 'tool_definitions', 'messages', 'other'];
  const order = valid.segments.map((segment) => segmentOrder.indexOf(segment.kind));
  if (order.some((value, index) => index > 0 && value <= order[index - 1]!)) return false;

  const toolDefinitions = valid.segments.find((segment) => segment.kind === 'tool_definitions');
  const tools = valid.tools ?? [];
  if (
    tools.some(
      (tool, index) =>
        index > 0 &&
        (tools[index - 1]!.bytes < tool.bytes ||
          (tools[index - 1]!.bytes === tool.bytes &&
            tools[index - 1]!.name.localeCompare(tool.name) >= 0)),
    ) ||
    new Set(tools.map((tool) => tool.name)).size !== tools.length
  ) {
    return false;
  }
  const describedToolBytes =
    tools.reduce((total, tool) => total + tool.bytes, 0) +
    (valid.remainingTools?.bytes ?? 0) +
    (valid.unlabelledToolBytes ?? 0);
  return toolDefinitions
    ? describedToolBytes === toolDefinitions.bytes
    : describedToolBytes === 0 && valid.remainingTools === undefined;
}

function isContextDiagnosticsSegment(value: unknown): boolean {
  const segment = shapedRecord(value, ['kind', 'bytes'], []);
  return Boolean(
    segment &&
      (segment.kind === 'system_instructions' ||
        segment.kind === 'tool_definitions' ||
        segment.kind === 'messages' ||
        segment.kind === 'other') &&
      isCount(segment.bytes) &&
      segment.bytes > 0,
  );
}

function isContextDiagnosticsTool(value: unknown): boolean {
  const tool = shapedRecord(value, ['name', 'bytes'], []);
  return Boolean(tool && isBoundedString(tool.name, 512) && isCount(tool.bytes) && tool.bytes > 0);
}

function isContextDiagnosticsRemainder(value: unknown): boolean {
  const remainder = shapedRecord(value, ['count', 'bytes'], []);
  return Boolean(
    remainder &&
      isCount(remainder.count) &&
      remainder.count > 0 &&
      isCount(remainder.bytes) &&
      remainder.bytes > 0,
  );
}

function isContextDiagnosticsCompaction(value: unknown): value is ContextDiagnosticsCompaction {
  const compaction = shapedRecord(
    value,
    ['kind', 'phase', 'eventCount', 'turnCount', 'estimatedTokens'],
    [],
  );
  return Boolean(
    compaction &&
      compaction.kind === 'history' &&
      (compaction.phase === 'pre_turn' || compaction.phase === 'mid_turn') &&
      isCount(compaction.eventCount) &&
      compaction.eventCount > 0 &&
      isCount(compaction.turnCount) &&
      compaction.turnCount > 0 &&
      isCount(compaction.estimatedTokens),
  );
}

function shapedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    return undefined;
  }
  return record;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || isCount(value);
}
