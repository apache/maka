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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import {
  allNonEmpty,
  escapeAttribute,
  estimateRuntimeEventsTokens,
  estimateTokens,
  finitePositive,
  increment,
  nonEmpty,
  sha256,
  stableJsonLength,
  stableStringify,
  tokenizeSearchQuery,
  turnKey,
  uniqueSorted,
  utf8ByteLength,
  optionalNonNegativeFiniteNumber,
} from './context-budget-helpers.js';
import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  type ArchiveRetrievalMode,
  isArchivedToolResultPlaceholder,
  serializeToolResultForArchive,
} from './tool-result-archive.js';
import {
  type ArchivedToolResultReason,
  type SynthesisSourceRef,
  isValidSynthesisSourceRef,
} from './context-source-ref.js';
import { runtimeEventSearchText } from './runtime-event-history-search.js';

export interface SynthesisCachePolicy {
  enabled: boolean;
  /** Source-bearing blocks available for the current replay projection. */
  blocks?: readonly SynthesisCacheBlock[];
  /** Defaults to `lookup`; `read_write` enables host-owned lifecycle callbacks. */
  mode?: 'lookup' | 'read_write';
  /** Defaults to 1 to keep replay bounded and deterministic. */
  maxBlocks?: number;
  /** Defaults to 2048 to keep replay bounded and deterministic. */
  maxEstimatedTokens?: number;
  /** Defaults to 1024 to reject any single over-large synthesis block. */
  maxBlockEstimatedTokens?: number;
  /**
   * When true (default), a newer matching tool result invalidates older synthesis
   * for the same tool/query key.
   */
  invalidateOnNewToolResult?: boolean;
  /** Current schema version accepted by the loader/selector. */
  schemaVersion?: 1;
}

export interface SynthesisCacheBlock {
  kind: 'maka.synthesis_cache_block';
  version: 1;
  blockId: string;
  sessionId: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  sourceRef?: {
    sourceRef?: string;
    repoRoot?: string;
    gitCommit?: string;
    harnessRunId?: string;
  };
  coverage: SynthesisCacheCoverage;
  summary: string;
  limitations: string[];
  sourceRefs: readonly SynthesisSourceRef[];
  estimatedTokens?: number;
  requestShape?: {
    before?: string;
    after?: string;
  };
  invalidation?: {
    schemaVersion: 1;
    sourceBodyHashes: string[];
    invalidateOnNewToolResult: boolean;
  };
  createdFrom:
    | 'gated_archive_retrieval'
    | 'eager_archive_retrieval'
    | 'full_context'
    | 'live_tool_result'
    | 'host_deterministic';
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
}

export interface SynthesisCacheCoverage {
  queryKeys: string[];
  turnIds: string[];
  runtimeEventIds: string[];
  toolNames: string[];
  toolCallIds: string[];
  artifactIds: string[];
  bodySha256: string[];
}

export interface SynthesisCacheReplayResult {
  events: RuntimeEvent[];
  selectedBlocks: SynthesisCacheBlock[];
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

export interface BuildSynthesisCacheBlocksInput {
  sessionId: string;
  query: string;
  hydratedRuntimeEvents: readonly RuntimeEvent[];
  retrievedArchiveRefs: readonly SynthesisSourceRef[];
  archiveRetrievalMode: ArchiveRetrievalMode;
  limits: {
    maxBlocks: number;
    maxBlockEstimatedTokens: number;
    maxEstimatedTokens: number;
    charsPerToken: number;
  };
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  now?: number;
}

export interface BuildSynthesisCacheBlocksResult {
  blocks: SynthesisCacheBlock[];
  skipped: number;
  skippedReasonCounts?: Record<string, number>;
}

export function selectSynthesisCacheForReplay(
  events: readonly RuntimeEvent[],
  query: string,
  policy: SynthesisCachePolicy | undefined,
  options: { sessionId: string; charsPerToken?: number } = { sessionId: '' },
): SynthesisCacheReplayResult {
  if (policy?.enabled !== true) {
    return { events: [...events], selectedBlocks: [], diagnosticPatch: {} };
  }

  const charsPerToken = options.charsPerToken ?? 4;
  const blocks = policy.blocks ?? [];
  const maxBlocks = finitePositive(policy.maxBlocks) ?? 1;
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 2_048;
  const maxBlockEstimatedTokens = finitePositive(policy.maxBlockEstimatedTokens) ?? 1_024;
  const selectedBlocks: SynthesisCacheBlock[] = [];
  let selectedTokenEstimate = 0;
  const skippedReasonCounts: Record<string, number> = {};
  const invalidationReasonCounts: Record<string, number> = {};
  const rawEvidenceReason = rawEvidenceRequestReason(query);
  const sourceIndex = buildSynthesisSourceIndex(events);

  for (const block of blocks) {
    if (selectedBlocks.length >= maxBlocks) {
      increment(skippedReasonCounts, 'max_blocks');
      continue;
    }
    const validationReason = validateSynthesisCacheBlock(block, sourceIndex, options.sessionId);
    if (validationReason) {
      increment(invalidationReasonCounts, validationReason);
      continue;
    }
    const blockTokenEstimate =
      block.estimatedTokens ??
      estimateTokens(renderSynthesisCacheBlock(block).length, charsPerToken);
    if (blockTokenEstimate > maxBlockEstimatedTokens) {
      increment(skippedReasonCounts, 'max_block_tokens');
      continue;
    }
    if (selectedTokenEstimate + blockTokenEstimate > maxEstimatedTokens) {
      increment(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    if (!synthesisBlockCoversQuery(block, query)) {
      increment(skippedReasonCounts, 'coverage_miss');
      continue;
    }
    if (rawEvidenceReason) {
      increment(skippedReasonCounts, rawEvidenceReason);
      continue;
    }
    const newerReason =
      policy.invalidateOnNewToolResult === false
        ? undefined
        : newerRelevantToolResultReason(block, events, query);
    if (newerReason) {
      increment(invalidationReasonCounts, newerReason);
      continue;
    }
    selectedBlocks.push(block);
    selectedTokenEstimate += blockTokenEstimate;
  }

  const skipped = Object.values(skippedReasonCounts).reduce((total, count) => total + count, 0);
  const invalidated = Object.values(invalidationReasonCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const diagnosticPatch: Partial<ContextBudgetDiagnostic> = {
    synthesisCacheEnabled: true,
    synthesisCacheMode:
      selectedBlocks.length > 0 ? (policy.mode ?? 'lookup') : 'fallback_archive_retrieval',
    synthesisCacheBlocksAvailable: blocks.length,
    synthesisCacheBlocksSelected: selectedBlocks.length,
    ...(selectedBlocks.length > 0
      ? {
          synthesisCacheBlockIds: selectedBlocks.map((block) => block.blockId),
          synthesisCacheEstimatedTokens: selectedTokenEstimate,
          highWaterName: selectedBlocks[0]!.highWaterName,
          highWaterSeq: selectedBlocks[0]!.highWaterSeq,
          highWaterReason: 'synthesis_cache_select',
        }
      : {}),
    ...(skipped > 0
      ? {
          synthesisCacheSkipped: skipped,
          synthesisCacheSkippedReasonCounts: skippedReasonCounts,
        }
      : {}),
    ...(invalidated > 0
      ? {
          synthesisCacheInvalidated: invalidated,
          synthesisCacheInvalidationReasonCounts: invalidationReasonCounts,
        }
      : {}),
  };

  if (selectedBlocks.length === 0) {
    return { events: [...events], selectedBlocks, diagnosticPatch };
  }

  const coveredEventIds = new Set<string>();
  const coveredToolCallIds = new Set<string>();
  const insertions = new Map<number, RuntimeEvent[]>();
  for (const block of selectedBlocks) {
    const blockEventIds = new Set(block.coverage.runtimeEventIds);
    const blockToolCallIds = new Set(block.coverage.toolCallIds);
    for (const eventId of block.coverage.runtimeEventIds) coveredEventIds.add(eventId);
    for (const toolCallId of block.coverage.toolCallIds) coveredToolCallIds.add(toolCallId);
    for (const ref of block.sourceRefs) {
      if ('runtimeEventId' in ref) {
        coveredEventIds.add(ref.runtimeEventId);
        blockEventIds.add(ref.runtimeEventId);
      }
      if ('toolCallId' in ref) {
        coveredToolCallIds.add(ref.toolCallId);
        blockToolCallIds.add(ref.toolCallId);
      }
    }
    const insertionIndex = events.findIndex(
      (event) =>
        blockEventIds.has(event.id) ||
        (event.content?.kind === 'function_call' && blockToolCallIds.has(event.content.id)),
    );
    if (insertionIndex < 0) {
      throw new Error('validated synthesis cache block has no covered replay event');
    }
    const synthetic = synthesisBlockRuntimeEvent(block, options.sessionId);
    const existing = insertions.get(insertionIndex);
    if (existing) existing.push(synthetic);
    else insertions.set(insertionIndex, [synthetic]);
  }
  const replayEvents: RuntimeEvent[] = [];
  for (const [index, event] of events.entries()) {
    const synthetic = insertions.get(index);
    if (synthetic) replayEvents.push(...synthetic);
    if (
      coveredEventIds.has(event.id) ||
      (event.content?.kind === 'function_call' && coveredToolCallIds.has(event.content.id))
    ) {
      continue;
    }
    replayEvents.push(event);
  }
  return {
    events: replayEvents,
    selectedBlocks,
    diagnosticPatch,
  };
}

export function renderSynthesisCacheBlock(block: SynthesisCacheBlock): string {
  const sourceText = block.sourceRefs.map((ref) => renderSynthesisSourceRef(ref)).join('; ');
  return [
    `<maka_synthesis_cache_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}">`,
    `summary: ${block.summary}`,
    `coverage: queryKeys=[${block.coverage.queryKeys.join(', ')}], turnIds=[${block.coverage.turnIds.join(', ')}], runtimeEventIds=[${block.coverage.runtimeEventIds.join(', ')}], artifactIds=[${block.coverage.artifactIds.join(', ')}]`,
    `limitations: ${block.limitations.join('; ')}`,
    `sources: ${sourceText}`,
    '</maka_synthesis_cache_block>',
  ].join('\n');
}

export function buildSynthesisCacheBlocksFromHydratedArchives(
  input: BuildSynthesisCacheBlocksInput,
): BuildSynthesisCacheBlocksResult {
  const skippedReasonCounts: Record<string, number> = {};
  const eventsById = new Map(input.hydratedRuntimeEvents.map((event) => [event.id, event]));
  const archiveRefs = input.retrievedArchiveRefs.filter(
    (ref): ref is Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }> =>
      ref.kind === 'archived_tool_result' &&
      eventsById.get(ref.runtimeEventId)?.modelVisibility !== 'hidden',
  );
  if (archiveRefs.length === 0) {
    increment(skippedReasonCounts, 'source_missing');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }

  const maxBlocks = finitePositive(input.limits.maxBlocks) ?? 1;
  const maxBlockEstimatedTokens = finitePositive(input.limits.maxBlockEstimatedTokens) ?? 1_024;
  const maxEstimatedTokens = finitePositive(input.limits.maxEstimatedTokens) ?? 2_048;
  const charsPerToken = input.limits.charsPerToken ?? 4;
  const coverage = deriveSynthesisCoverageFromSourceRefs(archiveRefs);
  const excerpts = buildSynthesisArchiveExcerpts(input.hydratedRuntimeEvents, archiveRefs);
  if (excerpts.length === 0) {
    increment(skippedReasonCounts, 'source_missing');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }

  const queryKeys = deriveSynthesisQueryKeys(input.query, archiveRefs, excerpts);
  if (queryKeys.length === 0) {
    increment(skippedReasonCounts, 'coverage_miss');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }

  const blockDraft = {
    sessionId: input.sessionId,
    coverage: { ...coverage, queryKeys },
    sourceRefs: archiveRefs,
    excerpts,
    mode: input.archiveRetrievalMode,
  };
  const createdAt = Math.max(
    input.now ?? 0,
    ...input.hydratedRuntimeEvents
      .filter((event) => coverage.runtimeEventIds.includes(event.id))
      .map((event) => event.ts),
  );
  const highWaterSeq = Math.max(
    1,
    ...input.hydratedRuntimeEvents
      .filter((event) => coverage.runtimeEventIds.includes(event.id))
      .map((event) => event.ts),
  );
  const block: SynthesisCacheBlock = {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId: stableSynthesisBlockId(blockDraft),
    sessionId: input.sessionId,
    createdAt,
    highWaterName: 'synthesis-cache-after-archive-retrieval',
    highWaterSeq,
    coverage: { ...coverage, queryKeys },
    summary: buildBoundedSynthesisSummary(excerpts),
    limitations: [
      'Deterministic synthesis from archived tool-result excerpts only.',
      'Raw output is not included; request raw evidence to retrieve the archive.',
    ],
    sourceRefs: archiveRefs,
    createdFrom:
      input.archiveRetrievalMode === 'history_search_gated'
        ? 'gated_archive_retrieval'
        : 'eager_archive_retrieval',
    ...(input.requestShapeHashBefore
      ? { requestShapeHashBefore: input.requestShapeHashBefore }
      : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
    ...(input.requestShapeHashBefore || input.requestShapeHashAfter
      ? {
          requestShape: {
            ...(input.requestShapeHashBefore ? { before: input.requestShapeHashBefore } : {}),
            ...(input.requestShapeHashAfter ? { after: input.requestShapeHashAfter } : {}),
          },
        }
      : {}),
    invalidation: {
      schemaVersion: 1,
      sourceBodyHashes: coverage.bodySha256,
      invalidateOnNewToolResult: true,
    },
  };
  block.estimatedTokens = estimateTokens(renderSynthesisCacheBlock(block).length, charsPerToken);
  if (
    block.estimatedTokens > maxBlockEstimatedTokens ||
    block.estimatedTokens > maxEstimatedTokens
  ) {
    increment(skippedReasonCounts, 'max_block_tokens');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }
  return { blocks: [block].slice(0, maxBlocks), skipped: 0 };
}

export function deriveSynthesisCoverageFromSourceRefs(
  refs: readonly SynthesisSourceRef[],
): SynthesisCacheCoverage {
  const archiveRefs = refs.filter(
    (ref): ref is Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }> =>
      ref.kind === 'archived_tool_result',
  );
  return {
    queryKeys: [],
    turnIds: uniqueSorted(archiveRefs.map((ref) => ref.turnId)),
    runtimeEventIds: uniqueSorted(archiveRefs.map((ref) => ref.runtimeEventId)),
    toolNames: uniqueSorted(archiveRefs.map((ref) => ref.toolName)),
    toolCallIds: uniqueSorted(archiveRefs.map((ref) => ref.toolCallId)),
    artifactIds: uniqueSorted(archiveRefs.map((ref) => ref.artifactId)),
    bodySha256: uniqueSorted(archiveRefs.map((ref) => ref.bodySha256)),
  };
}

export function stableSynthesisBlockId(value: unknown): string {
  return `synth-${sha256(stableStringify(value)).slice(0, 32)}`;
}

export function validateSynthesisCacheBlockShape(
  value: unknown,
  sessionId?: string,
): value is SynthesisCacheBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Partial<SynthesisCacheBlock>;
  return (
    block.kind === 'maka.synthesis_cache_block' &&
    block.version === 1 &&
    nonEmpty(block.blockId) &&
    nonEmpty(block.sessionId) &&
    (sessionId === undefined || block.sessionId === sessionId) &&
    Number.isFinite(block.createdAt) &&
    nonEmpty(block.highWaterName) &&
    Number.isFinite(block.highWaterSeq) &&
    !!block.coverage &&
    Array.isArray(block.coverage.queryKeys) &&
    Array.isArray(block.coverage.turnIds) &&
    Array.isArray(block.coverage.runtimeEventIds) &&
    Array.isArray(block.coverage.toolNames) &&
    Array.isArray(block.coverage.toolCallIds) &&
    Array.isArray(block.coverage.artifactIds) &&
    Array.isArray(block.coverage.bodySha256) &&
    typeof block.summary === 'string' &&
    block.summary.length > 0 &&
    Array.isArray(block.limitations) &&
    Array.isArray(block.sourceRefs) &&
    block.sourceRefs.length > 0 &&
    block.sourceRefs.every(isValidSynthesisSourceRef) &&
    optionalNonNegativeFiniteNumber(block.estimatedTokens)
  );
}

function buildSynthesisArchiveExcerpts(
  events: readonly RuntimeEvent[],
  refs: ReadonlyArray<Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }>>,
): Array<{ runtimeEventId: string; toolName: string; text: string }> {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  return [...refs]
    .sort(
      (a, b) =>
        a.turnId.localeCompare(b.turnId) || a.runtimeEventId.localeCompare(b.runtimeEventId),
    )
    .map((ref) => {
      const event = eventsById.get(ref.runtimeEventId);
      if (event?.modelVisibility === 'hidden' || event?.content?.kind !== 'function_response') {
        return undefined;
      }
      if (isArchivedToolResultPlaceholder(event.content.result)) return undefined;
      const serialized = serializeToolResultForArchive(event.content.result);
      return {
        runtimeEventId: ref.runtimeEventId,
        toolName: ref.toolName,
        text: serialized.slice(0, 1_200),
      };
    })
    .filter(
      (item): item is { runtimeEventId: string; toolName: string; text: string } =>
        item !== undefined,
    );
}

function deriveSynthesisQueryKeys(
  query: string,
  refs: ReadonlyArray<Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }>>,
  excerpts: ReadonlyArray<{ text: string }>,
): string[] {
  const candidates = new Set<string>();
  for (const token of tokenizeSearchQuery(query)) {
    const key = normalizeSynthesisQueryKey(token);
    if (isUsefulSynthesisQueryKey(key)) candidates.add(key);
  }
  for (const ref of refs) {
    const toolCallId = normalizeSynthesisQueryKey(ref.toolCallId);
    if (isUsefulSynthesisQueryKey(toolCallId)) candidates.add(toolCallId);
  }
  const excerptText = excerpts.map((excerpt) => excerpt.text.toLowerCase()).join('\n');
  for (const match of excerptText.matchAll(/\b[a-z][a-z0-9_-]{2,64}\b/g)) {
    if (candidates.size >= 12) break;
    const key = normalizeSynthesisQueryKey(match[0]);
    if (isUsefulSynthesisQueryKey(key)) candidates.add(key);
  }
  return [...candidates].sort().slice(0, 12);
}

function buildBoundedSynthesisSummary(
  excerpts: ReadonlyArray<{ runtimeEventId: string; toolName: string; text: string }>,
): string {
  const lines: string[] = [];
  for (const excerpt of excerpts) {
    const normalized = excerpt.text.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    lines.push(`${excerpt.toolName}/${excerpt.runtimeEventId}: ${normalized.slice(0, 700)}`);
  }
  return lines.join('\n').slice(0, 2_000);
}

const SYNTHESIS_QUERY_KEY_STOPWORDS = new Set([
  'acknowledge',
  'and',
  'answer',
  'archive',
  'archived',
  'available',
  'call',
  'context',
  'current',
  'debug',
  'do',
  'evidence',
  'exactly',
  'false',
  'for',
  'from',
  'index',
  'is',
  'json',
  'key',
  'kind',
  'lookup',
  'noise',
  'not',
  'only',
  'output',
  'payload',
  'phase',
  'phase7',
  'phase8',
  'phase9',
  'prior',
  'raw',
  'recover',
  'recovery',
  'repeat',
  'result',
  'row',
  'rows',
  'sentinel',
  'show',
  'stable',
  'stale',
  'store',
  'target',
  'text',
  'the',
  'this',
  'tool',
  'tools',
  'true',
  'value',
  'was',
  'were',
]);

function normalizeSynthesisQueryKey(term: string): string {
  return term.toLowerCase().replace(/^[._/:-]+|[._/:-]+$/g, '');
}

function isUsefulSynthesisQueryKey(term: string): boolean {
  return term.length >= 3 && !SYNTHESIS_QUERY_KEY_STOPWORDS.has(term) && !/^\d+$/.test(term);
}

function buildSynthesisSourceIndex(events: readonly RuntimeEvent[]): Map<string, RuntimeEvent> {
  return new Map(events.map((event) => [event.id, event]));
}

function validateSynthesisCacheBlock(
  block: SynthesisCacheBlock,
  sourceIndex: ReadonlyMap<string, RuntimeEvent>,
  sessionId: string,
): string | undefined {
  if (block.kind !== 'maka.synthesis_cache_block' || block.version !== 1) {
    return 'invalid_schema_version';
  }
  if (sessionId.length > 0 && block.sessionId !== sessionId) {
    return 'session_mismatch';
  }
  if (
    !nonEmpty(block.blockId) ||
    !nonEmpty(block.sessionId) ||
    !Number.isFinite(block.createdAt) ||
    !nonEmpty(block.highWaterName) ||
    !Number.isFinite(block.highWaterSeq) ||
    !nonEmpty(block.summary) ||
    !Array.isArray(block.limitations) ||
    block.sourceRefs.length === 0
  ) {
    return 'source_missing';
  }
  if (
    block.coverage.queryKeys.length === 0 ||
    block.coverage.turnIds.length === 0 ||
    block.coverage.runtimeEventIds.length === 0 ||
    block.coverage.artifactIds.length === 0 ||
    block.coverage.bodySha256.length === 0 ||
    !allNonEmpty(block.coverage.queryKeys) ||
    !allNonEmpty(block.coverage.turnIds) ||
    !allNonEmpty(block.coverage.runtimeEventIds) ||
    !allNonEmpty(block.coverage.toolNames) ||
    !allNonEmpty(block.coverage.toolCallIds) ||
    !allNonEmpty(block.coverage.artifactIds) ||
    !allNonEmpty(block.coverage.bodySha256)
  ) {
    return 'source_missing';
  }

  for (const ref of block.sourceRefs) {
    const event = sourceIndex.get(ref.runtimeEventId);
    if (!event) return ref.kind === 'archived_tool_result' ? 'source_missing' : 'coverage_miss';
    if (
      ref.sessionId !== block.sessionId ||
      (sessionId.length > 0 && ref.sessionId !== sessionId)
    ) {
      return 'session_mismatch';
    }
    if (event.turnId !== ref.turnId) return 'source_hash_mismatch';
    if (ref.kind === 'archived_tool_result') {
      if (
        !nonEmpty(ref.artifactId) ||
        !nonEmpty(ref.bodySha256) ||
        !nonEmpty(ref.toolCallId) ||
        !nonEmpty(ref.toolName) ||
        ref.originalEstimatedTokens <= 0 ||
        ref.originalBytes <= 0 ||
        ref.placeholderReason !== 'stale_tool_result_pruned_before_compact'
      ) {
        return 'source_missing';
      }
      if (event.content?.kind !== 'function_response') return 'source_hash_mismatch';
      if (!isArchivedToolResultPlaceholder(event.content.result)) return 'source_hash_mismatch';
      const placeholder = event.content.result;
      if (
        placeholder.artifactId !== ref.artifactId ||
        placeholder.bodySha256 !== ref.bodySha256 ||
        placeholder.toolCallId !== ref.toolCallId ||
        placeholder.toolName !== ref.toolName ||
        placeholder.originalEstimatedTokens !== ref.originalEstimatedTokens ||
        placeholder.originalBytes !== ref.originalBytes ||
        placeholder.reason !== ref.placeholderReason
      ) {
        return 'source_hash_mismatch';
      }
    }
  }
  return undefined;
}

function synthesisBlockCoversQuery(block: SynthesisCacheBlock, query: string): boolean {
  return block.coverage.queryKeys.some((key) => queryContainsCoveredKey(query, key));
}

function queryContainsCoveredKey(query: string, key: string): boolean {
  const normalizedQuery = query.toLowerCase();
  const normalizedKey = key.toLowerCase().trim();
  if (normalizedKey.length === 0) return false;
  let index = normalizedQuery.indexOf(normalizedKey);
  while (index >= 0) {
    const before = index === 0 ? '' : normalizedQuery[index - 1]!;
    const after = normalizedQuery[index + normalizedKey.length] ?? '';
    if (!isQueryKeyContinuation(before) && !isQueryKeyContinuation(after)) {
      return true;
    }
    index = normalizedQuery.indexOf(normalizedKey, index + normalizedKey.length);
  }
  return false;
}

function isQueryKeyContinuation(char: string): boolean {
  return /^[a-z0-9_-]$/.test(char);
}

export function rawEvidenceRequestReason(
  query: string,
): 'raw_evidence_requested' | 'exact_output_requested' | undefined {
  const normalized = query.toLowerCase();
  if (/\b(exact|verbatim|original wording|word-for-word|full output)\b/.test(normalized)) {
    return 'exact_output_requested';
  }
  if (
    /\b(raw|evidence|proof|show how|debug|source|archive|tool output|original tool)\b/.test(
      normalized,
    )
  ) {
    return 'raw_evidence_requested';
  }
  return undefined;
}

function newerRelevantToolResultReason(
  block: SynthesisCacheBlock,
  events: readonly RuntimeEvent[],
  query: string,
): 'new_relevant_tool_result' | undefined {
  const sourceEventIds = new Set(block.coverage.runtimeEventIds);
  const toolNames = new Set(block.coverage.toolNames);
  const sourceTimes = events
    .filter((event) => sourceEventIds.has(event.id))
    .map((event) => event.ts);
  const newestSourceTs = sourceTimes.length > 0 ? Math.max(...sourceTimes) : block.createdAt;
  const keys = block.coverage.queryKeys.map((key) => key.toLowerCase());
  const queryText = query.toLowerCase();
  for (const event of events) {
    if (event.ts <= newestSourceTs || event.content?.kind !== 'function_response') continue;
    if (sourceEventIds.has(event.id) || !toolNames.has(event.content.name)) continue;
    const eventText = runtimeEventSearchText(event).toLowerCase();
    if (keys.some((key) => eventText.includes(key) || queryText.includes(key))) {
      return 'new_relevant_tool_result';
    }
  }
  return undefined;
}

function synthesisBlockRuntimeEvent(block: SynthesisCacheBlock, sessionId: string): RuntimeEvent {
  return {
    id: `synthesis-cache:${block.blockId}`,
    sessionId,
    runId: `synthesis-cache:${block.blockId}`,
    turnId: `synthesis-cache:${block.highWaterSeq}`,
    invocationId: `synthesis-cache:${block.blockId}`,
    ts: block.createdAt,
    partial: false,
    role: 'model',
    author: 'system',
    content: {
      kind: 'text',
      text: renderSynthesisCacheBlock(block),
    },
    refs: {
      artifactId: block.coverage.artifactIds[0],
    },
  };
}

function renderSynthesisSourceRef(ref: SynthesisSourceRef): string {
  switch (ref.kind) {
    case 'archived_tool_result':
      return `archived_tool_result(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, artifactId=${ref.artifactId}, bodySha256=${ref.bodySha256}, toolName=${ref.toolName})`;
    case 'runtime_event':
      return `runtime_event(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, role=${ref.role}, contentKind=${ref.contentKind})`;
    case 'history_search_hit':
      return `history_search_hit(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, score=${ref.score}, matchedTerms=${ref.matchedTerms.join('|')})`;
    case 'live_tool_result':
      return `live_tool_result(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, toolName=${ref.toolName}, resultSha256=${ref.resultSha256})`;
  }
}
