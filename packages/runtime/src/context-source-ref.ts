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

/**
 * Shared provenance contract for context-compaction source references.
 *
 * `SynthesisSourceRef` historically lived in the synthesis-cache module, but
 * its four kinds are produced by several independent subsystems (archive
 * retrieval, history-compact blocks, history search) and consumed by both
 * synthesis-cache and history-compact. Extracting the contract into a leaf
 * lets every producer/consumer depend on it without reaching across domain
 * modules. `SynthesisSourceRef` is retained as a compatibility alias.
 */
import { nonEmpty } from './context-budget-helpers.js';

export type ArchivedToolResultReason = 'stale_tool_result_pruned_before_compact';

export interface ArchivedToolResultSourceRef {
  kind: 'archived_tool_result';
  sessionId: string;
  turnId: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  placeholderReason: ArchivedToolResultReason;
}

export interface RuntimeEventSourceRef {
  kind: 'runtime_event';
  sessionId: string;
  turnId: string;
  runtimeEventId: string;
  role: 'user' | 'model' | 'tool' | 'system';
  contentKind: string;
}

export interface HistorySearchHitSourceRef {
  kind: 'history_search_hit';
  sessionId: string;
  turnId: string;
  runtimeEventId: string;
  score: number;
  matchedTerms: string[];
}

export interface LiveToolResultSourceRef {
  kind: 'live_tool_result';
  sessionId: string;
  turnId: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  argsSha256: string;
  resultSha256: string;
  artifactId?: string;
}

export type ContextSourceRef =
  | ArchivedToolResultSourceRef
  | RuntimeEventSourceRef
  | HistorySearchHitSourceRef
  | LiveToolResultSourceRef;

/** Compatibility alias; new code should use {@link ContextSourceRef}. */
export type SynthesisSourceRef = ContextSourceRef;

export function isValidSynthesisSourceRef(value: unknown): value is SynthesisSourceRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<SynthesisSourceRef>;
  if (ref.kind === 'archived_tool_result') {
    const archived = ref as Partial<Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }>>;
    return (
      nonEmpty(archived.sessionId) &&
      nonEmpty(archived.turnId) &&
      nonEmpty(archived.runtimeEventId) &&
      nonEmpty(archived.toolCallId) &&
      nonEmpty(archived.toolName) &&
      nonEmpty(archived.artifactId) &&
      nonEmpty(archived.bodySha256) &&
      Number.isFinite(archived.originalEstimatedTokens) &&
      Number.isFinite(archived.originalBytes) &&
      archived.placeholderReason === 'stale_tool_result_pruned_before_compact'
    );
  }
  if (
    ref.kind === 'runtime_event' ||
    ref.kind === 'history_search_hit' ||
    ref.kind === 'live_tool_result'
  ) {
    return (
      nonEmpty((ref as { sessionId?: string }).sessionId) &&
      nonEmpty((ref as { turnId?: string }).turnId) &&
      nonEmpty((ref as { runtimeEventId?: string }).runtimeEventId)
    );
  }
  return false;
}
