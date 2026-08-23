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

import { createHash } from 'node:crypto';
import type { ModelMessage } from './model-protocol.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { estimateTokens } from './context-budget-helpers.js';
import { serializeToolResultForArchive } from './tool-result-archive.js';
import {
  type ActiveArchivedToolResultPlaceholder,
  isActiveArchivedToolResultPlaceholder,
} from './active-tool-result-prune.js';

const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Exact current-turn user message that active compaction must never rewrite.
 * The index is captured before the first provider step, after prior replay has
 * been materialized, so it is intentionally not assumed to be message zero.
 */
export interface ActiveCompactionHeadAnchor {
  messageIndex: number;
  messageSignature: string;
  bodySha256: string;
  estimatedTokens: number;
}

export interface ActiveCompactionSafeSpanPolicy {
  enabled: boolean;
  mode?: 'off' | string;
  minStepNumber?: number;
  highWaterRatio?: number;
  maxActiveEstimatedTokens?: number;
  minSafePrefixEstimatedTokens?: number;
  /**
   * Number of most-recent completed provider episodes that must remain
   * verbatim after the compacted middle span. Capacity fallback leaves this
   * unset; attention compaction uses one episode to preserve execution
   * momentum in addition to any open protocol tail.
   */
  preserveRecentCompletedEpisodes?: number;
  archiveRequired?: boolean;
}

export interface ActiveCompactionSourceIndexInput {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  messages: readonly ModelMessage[];
  runtimeEvents?: readonly RuntimeEvent[];
  stepNumber?: number;
  charsPerToken?: number;
}

export type ActiveCompactionProviderRole = 'system' | 'user' | 'assistant' | 'tool';
export type ActiveCompactionContentKind =
  | 'text'
  | 'thinking'
  | 'function_call'
  | 'function_response'
  | 'tool_result'
  | 'active_archive_placeholder'
  | 'unknown';

export interface ActiveCompactionArchiveRef {
  kind: 'toolResult' | 'compactSource';
  sessionId?: string;
  turnId?: string;
  runtimeEventId?: string;
  toolCallId?: string;
  toolName?: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens?: number;
  originalBytes?: number;
}

export interface ActiveCompactionSourceEntry {
  sourceId: string;
  messageIndex: number;
  partIndex?: number;
  role: ActiveCompactionProviderRole;
  runtimeEventId?: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  toolCallId?: string;
  toolName?: string;
  contentKind: ActiveCompactionContentKind;
  bodySha256: string;
  estimatedTokens: number;
  originalEstimatedTokens?: number;
  originalBytes?: number;
  archiveRef?: ActiveCompactionArchiveRef;
}

export interface ActiveCompactionSourceIndex {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  stepNumber?: number;
  providerMessageCount: number;
  entries: ActiveCompactionSourceEntry[];
  toolLedger: ActiveCompactionToolLedger;
  estimatedTokens: number;
}

export interface ActiveCompactionToolEpisode {
  toolCallId: string;
  callSourceIds: string[];
  resultSourceIds: string[];
  valid: boolean;
}

export interface ActiveCompactionToolLedger {
  episodes: ActiveCompactionToolEpisode[];
  missingIdentitySourceIds: string[];
}

export interface ActiveCompactionCoverage {
  turnIds: string[];
  runtimeEventIds: string[];
  providerMessageSourceIds: string[];
  toolCallIds: string[];
  contentKinds: string[];
  bodySha256: string[];
}

export type ActiveCompactionSafeSpanSelection =
  | {
      decision: 'selected';
      startMessageIndex: number;
      endMessageIndex: number;
      entries: ActiveCompactionSourceEntry[];
      coverage: ActiveCompactionCoverage;
      estimatedTokens: number;
    }
  | {
      decision: 'unchanged' | 'failedOpen';
      reason:
        | ActiveCompactionFailOpenReason
        | 'disabled'
        | 'below_min_step'
        | 'below_high_water'
        | 'below_min_safe_prefix'
        | 'no_candidate'
        | 'head_anchor_mismatch'
        | 'head_anchor_exceeds_capacity'
        | 'unexpected_user_after_head_anchor'
        | 'no_safe_completed_span';
      skippedReasonCounts: Readonly<Record<string, number>>;
    };

export interface ActiveCompactionSourceRef {
  kind: 'provider_message' | 'runtime_event' | 'active_archive_placeholder';
  sourceId: string;
  messageIndex: number;
  partIndex?: number;
  sessionId: string;
  turnId: string;
  runtimeEventId?: string;
  toolCallId?: string;
  toolName?: string;
  contentKind: ActiveCompactionContentKind;
  bodySha256: string;
  archiveRef?: ActiveCompactionArchiveRef;
}

export type ActiveCompactionFailOpenReason =
  | 'session_mismatch'
  | 'turn_mismatch'
  | 'source_missing'
  | 'coverage_miss'
  | 'source_hash_mismatch'
  | 'tool_pair_split'
  | 'archive_missing'
  | 'archive_mismatch'
  | 'head_anchor_exceeds_capacity'
  | 'provider_message_only_when_runtime_required';

export function activeCompactionMessageSignature(message: ModelMessage): string {
  return sha256(stableStringify(message));
}

export function buildActiveCompactionHeadAnchor(
  messages: readonly ModelMessage[],
  messageIndex: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): ActiveCompactionHeadAnchor {
  const message = messages[messageIndex];
  if (!message || (message as { role?: unknown }).role !== 'user') {
    throw new Error(
      `active compaction head anchor must reference a user message at index ${messageIndex}`,
    );
  }
  const body = stableStringify(message);
  return {
    messageIndex,
    messageSignature: activeCompactionMessageSignature(message),
    bodySha256: sha256(body),
    estimatedTokens: estimateTokens(body.length, charsPerToken),
  };
}

export interface ActiveCompactionValidationResult {
  valid: boolean;
  reasons: ActiveCompactionFailOpenReason[];
  reasonCounts: Readonly<Record<ActiveCompactionFailOpenReason, number>>;
}

export function buildActiveCompactionSourceIndex(
  input: ActiveCompactionSourceIndexInput,
): ActiveCompactionSourceIndex {
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const runtimeIndex = buildRuntimeEventIndex(input.runtimeEvents ?? []);
  const entries: ActiveCompactionSourceEntry[] = [];

  input.messages.forEach((message, messageIndex) => {
    const role = normalizeProviderRole(message.role);
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      entries.push(
        entryFromProviderPart({
          sourceId: providerSourceId(messageIndex),
          messageIndex,
          role,
          turnId: input.turnId,
          runId: input.runId,
          invocationId: input.invocationId,
          contentKind: 'text',
          body: content,
          charsPerToken,
          runtimeIndex,
        }),
      );
      return;
    }

    if (!Array.isArray(content)) {
      entries.push(
        entryFromProviderPart({
          sourceId: providerSourceId(messageIndex),
          messageIndex,
          role,
          turnId: input.turnId,
          runId: input.runId,
          invocationId: input.invocationId,
          contentKind: 'unknown',
          body: content,
          charsPerToken,
          runtimeIndex,
        }),
      );
      return;
    }

    content.forEach((part, partIndex) => {
      entries.push(
        entryFromProviderPart({
          sourceId: providerSourceId(messageIndex, partIndex),
          messageIndex,
          partIndex,
          role,
          turnId: input.turnId,
          runId: input.runId,
          invocationId: input.invocationId,
          ...providerPartBody(part),
          charsPerToken,
          runtimeIndex,
        }),
      );
    });
  });

  const toolLedger = buildActiveCompactionToolLedger(entries);
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    ...(input.stepNumber !== undefined ? { stepNumber: input.stepNumber } : {}),
    providerMessageCount: input.messages.length,
    entries,
    toolLedger,
    estimatedTokens: estimateActiveCompactionTokens(entries),
  };
}

export function activeCompactionCoverageFromEntries(
  entries: readonly ActiveCompactionSourceEntry[],
): ActiveCompactionCoverage {
  return {
    turnIds: uniqueSorted(entries.map((entry) => entry.turnId)),
    runtimeEventIds: uniqueSorted(entries.map((entry) => entry.runtimeEventId).filter(nonEmpty)),
    providerMessageSourceIds: uniqueSorted(entries.map((entry) => entry.sourceId)),
    toolCallIds: uniqueSorted(entries.map((entry) => entry.toolCallId).filter(nonEmpty)),
    contentKinds: uniqueSorted(entries.map((entry) => entry.contentKind)),
    bodySha256: uniqueSorted(entries.map((entry) => entry.bodySha256)),
  };
}

export function estimateActiveCompactionTokens(
  entries: readonly ActiveCompactionSourceEntry[],
): number {
  return entries.reduce((total, entry) => total + entry.estimatedTokens, 0);
}

/**
 * Select the completed active-turn span after the exact current-user anchor.
 * This deliberately makes no semantic relevance judgment. It only groups
 * provider protocol episodes and stops before the first open/incomplete one.
 */
export function selectActiveCompactionSafeSpan(input: {
  index: ActiveCompactionSourceIndex;
  messages: readonly ModelMessage[];
  policy: ActiveCompactionSafeSpanPolicy | undefined;
  headAnchor: ActiveCompactionHeadAnchor;
  /** A prior semantic projection immediately after the anchor is context, not raw source. */
  afterMessageIndex?: number;
}): ActiveCompactionSafeSpanSelection {
  const { index, messages, policy, headAnchor } = input;
  if (policy?.enabled !== true || policy.mode === 'off')
    return safeSpanSkipped('unchanged', 'disabled');
  const minStepNumber = Math.max(0, Math.floor(policy.minStepNumber ?? 1));
  if ((index.stepNumber ?? 0) < minStepNumber)
    return safeSpanSkipped('unchanged', 'below_min_step');

  const anchorMessage = messages[headAnchor.messageIndex];
  if (
    !anchorMessage ||
    (anchorMessage as { role?: unknown }).role !== 'user' ||
    activeCompactionMessageSignature(anchorMessage) !== headAnchor.messageSignature
  ) {
    return safeSpanSkipped('failedOpen', 'head_anchor_mismatch');
  }

  const highWaterRatio = finiteRatio(policy.highWaterRatio, 0.8);
  const maxActiveEstimatedTokens = finitePositive(policy.maxActiveEstimatedTokens);
  if (
    maxActiveEstimatedTokens !== undefined &&
    index.estimatedTokens <= Math.floor(maxActiveEstimatedTokens * highWaterRatio)
  ) {
    return safeSpanSkipped('unchanged', 'below_high_water');
  }

  const firstCandidateMessageIndex = Math.max(
    headAnchor.messageIndex + 1,
    (input.afterMessageIndex ?? headAnchor.messageIndex) + 1,
  );
  if (toolLedgerHasInvalidSourceAtOrAfter(index, firstCandidateMessageIndex)) {
    return safeSpanSkipped('failedOpen', 'tool_pair_split');
  }
  let cursor = firstCandidateMessageIndex;
  const completedEpisodes: Array<{ startMessageIndex: number; endMessageIndex: number }> = [];
  while (cursor < index.providerMessageCount) {
    const episodeStart = cursor;
    const messageEntries = entriesAtMessageIndex(index.entries, cursor);
    const role = providerMessageRole(messages[cursor], messageEntries);
    if (role === 'user' || role === 'system') {
      return safeSpanSkipped('failedOpen', 'unexpected_user_after_head_anchor');
    }
    if (role === 'tool') {
      break;
    }
    if (role !== 'assistant') {
      break;
    }

    // One provider episode may materialize reasoning/text and tool calls as
    // multiple consecutive assistant messages. Group all of them before
    // deciding whether any part is completed and eligible.
    let assistantEnd = cursor;
    const assistantEntries = [...messageEntries];
    while (assistantEnd + 1 < index.providerMessageCount) {
      const nextEntries = entriesAtMessageIndex(index.entries, assistantEnd + 1);
      if (providerMessageRole(messages[assistantEnd + 1], nextEntries) !== 'assistant') break;
      assistantEnd += 1;
      assistantEntries.push(...nextEntries);
    }
    const toolCallIds = uniqueSorted(
      assistantEntries
        .filter((entry) => entry.contentKind === 'function_call')
        .map((entry) => entry.toolCallId)
        .filter(nonEmpty),
    );
    if (toolCallIds.length === 0) {
      completedEpisodes.push({ startMessageIndex: episodeStart, endMessageIndex: assistantEnd });
      cursor = assistantEnd + 1;
      continue;
    }

    const resultIds = new Set<string>();
    let tailCursor = assistantEnd + 1;
    while (tailCursor < index.providerMessageCount) {
      const resultEntries = entriesAtMessageIndex(index.entries, tailCursor);
      if (providerMessageRole(messages[tailCursor], resultEntries) !== 'tool') break;
      for (const entry of resultEntries) {
        if (
          entry.toolCallId &&
          (entry.contentKind === 'function_response' ||
            entry.contentKind === 'tool_result' ||
            entry.contentKind === 'active_archive_placeholder')
        )
          resultIds.add(entry.toolCallId);
      }
      tailCursor += 1;
    }
    if (!toolCallIds.every((id) => resultIds.has(id))) break;
    completedEpisodes.push({ startMessageIndex: episodeStart, endMessageIndex: tailCursor - 1 });
    cursor = tailCursor;
  }

  const preserveRecentCompletedEpisodes = Math.max(
    0,
    Math.floor(policy.preserveRecentCompletedEpisodes ?? 0),
  );
  const compactableEpisodeCount = completedEpisodes.length - preserveRecentCompletedEpisodes;
  if (compactableEpisodeCount <= 0) {
    return safeSpanSkipped('unchanged', 'no_safe_completed_span');
  }
  const completedEnd = completedEpisodes[compactableEpisodeCount - 1]!.endMessageIndex;
  return safeSpanSelected(index, firstCandidateMessageIndex, completedEnd, policy);
}

function safeSpanSelected(
  index: ActiveCompactionSourceIndex,
  startMessageIndex: number,
  endMessageIndex: number,
  policy: ActiveCompactionSafeSpanPolicy,
): ActiveCompactionSafeSpanSelection {
  const entries = index.entries.filter(
    (entry) => entry.messageIndex >= startMessageIndex && entry.messageIndex <= endMessageIndex,
  );
  if (entries.length === 0) return safeSpanSkipped('unchanged', 'no_candidate');
  if (entries.some((entry) => !nonEmpty(entry.sourceId) || !nonEmpty(entry.bodySha256))) {
    return safeSpanSkipped('failedOpen', 'source_missing');
  }
  if (
    policy.archiveRequired === true &&
    entries.some((entry) => !entry.runtimeEventId && !entry.archiveRef)
  ) {
    return safeSpanSkipped('failedOpen', 'provider_message_only_when_runtime_required');
  }
  if (toolPairIntegrityViolation(entries, index.toolLedger))
    return safeSpanSkipped('failedOpen', 'tool_pair_split');
  const estimatedTokens = estimateActiveCompactionTokens(entries);
  const minSafePrefixEstimatedTokens = Math.max(
    0,
    Math.floor(policy.minSafePrefixEstimatedTokens ?? 0),
  );
  if (estimatedTokens < minSafePrefixEstimatedTokens) {
    return safeSpanSkipped('unchanged', 'below_min_safe_prefix');
  }
  return {
    decision: 'selected',
    startMessageIndex,
    endMessageIndex,
    entries,
    coverage: activeCompactionCoverageFromEntries(entries),
    estimatedTokens,
  };
}

function entriesAtMessageIndex(
  entries: readonly ActiveCompactionSourceEntry[],
  messageIndex: number,
): ActiveCompactionSourceEntry[] {
  return entries.filter((entry) => entry.messageIndex === messageIndex);
}

function providerMessageRole(
  message: ModelMessage | undefined,
  entries: readonly ActiveCompactionSourceEntry[],
): ActiveCompactionProviderRole | undefined {
  const role = (message as { role?: unknown } | undefined)?.role;
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
  return entries[0]?.role;
}

function safeSpanSkipped(
  decision: 'unchanged' | 'failedOpen',
  reason: Extract<
    ActiveCompactionSafeSpanSelection,
    { decision: 'unchanged' | 'failedOpen' }
  >['reason'],
): Extract<ActiveCompactionSafeSpanSelection, { decision: 'unchanged' | 'failedOpen' }> {
  return { decision, reason, skippedReasonCounts: { [reason]: 1 } };
}

/**
 * Validate the durable source coverage used by an active compaction projection.
 * This kernel intentionally knows nothing about the projection's rendered schema.
 */
export function validateActiveCompactionCoverageForSourceIndex(
  coverage: ActiveCompactionCoverage,
  index: ActiveCompactionSourceIndex,
  options: {
    archiveRefs?: readonly ActiveCompactionArchiveRef[];
    sessionId?: string;
    turnId?: string;
    archiveRequired?: boolean;
    requireRuntimeEventCoverage?: boolean;
  } = {},
): ActiveCompactionValidationResult {
  const reasons: ActiveCompactionFailOpenReason[] = [];
  const add = (reason: ActiveCompactionFailOpenReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (options.sessionId && options.sessionId !== index.sessionId) add('session_mismatch');
  if (options.turnId && options.turnId !== index.turnId) add('turn_mismatch');

  const entriesBySource = new Map(index.entries.map((entry) => [entry.sourceId, entry]));
  const selectedEntries: ActiveCompactionSourceEntry[] = [];
  for (const sourceId of coverage.providerMessageSourceIds) {
    const entry = entriesBySource.get(sourceId);
    if (!entry) {
      add('source_missing');
      continue;
    }
    selectedEntries.push(entry);
    if (!coverage.turnIds.includes(entry.turnId)) add('coverage_miss');
    if (entry.runtimeEventId && !coverage.runtimeEventIds.includes(entry.runtimeEventId)) {
      add('coverage_miss');
    }
    if (entry.toolCallId && !coverage.toolCallIds.includes(entry.toolCallId)) add('coverage_miss');
    if (!coverage.contentKinds.includes(entry.contentKind)) add('coverage_miss');
    if (!coverage.bodySha256.includes(entry.bodySha256)) add('source_hash_mismatch');
    if (options.requireRuntimeEventCoverage === true && !entry.runtimeEventId) {
      add('provider_message_only_when_runtime_required');
    }
    if (
      options.archiveRequired === true &&
      entry.contentKind === 'active_archive_placeholder' &&
      !entry.archiveRef
    ) {
      add('archive_missing');
    }
  }
  for (const hash of coverage.bodySha256) {
    if (!selectedEntries.some((entry) => entry.bodySha256 === hash)) add('source_hash_mismatch');
  }
  if (toolPairIntegrityViolation(selectedEntries, index.toolLedger)) add('tool_pair_split');
  for (const ref of options.archiveRefs ?? []) {
    if (!selectedEntries.some((entry) => archiveRefsEqual(entry.archiveRef, ref))) {
      add('archive_mismatch');
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    reasonCounts: countReasons(reasons),
  };
}

function entryFromProviderPart(input: {
  sourceId: string;
  messageIndex: number;
  partIndex?: number;
  role: ActiveCompactionProviderRole;
  turnId: string;
  runId?: string;
  invocationId?: string;
  contentKind: ActiveCompactionContentKind;
  body: unknown;
  toolCallId?: string;
  toolName?: string;
  placeholder?: ActiveArchivedToolResultPlaceholder;
  charsPerToken: number;
  runtimeIndex: RuntimeEventIndex;
}): ActiveCompactionSourceEntry {
  const bodyText = typeof input.body === 'string' ? input.body : stableStringify(input.body);
  const bodySha256 = input.placeholder?.bodySha256 ?? sha256(bodyText);
  const runtimeEvent = matchRuntimeEvent(input.runtimeIndex, {
    bodySha256,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    role: input.role,
    contentKind: input.contentKind,
  });
  const contentKind = input.placeholder
    ? 'active_archive_placeholder'
    : runtimeEvent?.content?.kind === 'function_response'
      ? 'function_response'
      : runtimeEvent?.content?.kind === 'function_call'
        ? 'function_call'
        : runtimeEvent?.content?.kind === 'thinking'
          ? 'thinking'
          : input.contentKind;
  const archiveRef = input.placeholder
    ? {
        kind: 'toolResult' as const,
        turnId: input.placeholder.turnId,
        ...(runtimeEvent?.sessionId ? { sessionId: runtimeEvent.sessionId } : {}),
        ...(runtimeEvent?.id ? { runtimeEventId: runtimeEvent.id } : {}),
        toolCallId: input.placeholder.toolCallId,
        toolName: input.placeholder.toolName,
        artifactId: input.placeholder.artifactId,
        bodySha256: input.placeholder.bodySha256,
        originalEstimatedTokens: input.placeholder.originalEstimatedTokens,
        originalBytes: input.placeholder.originalBytes,
      }
    : undefined;
  return {
    sourceId: input.sourceId,
    messageIndex: input.messageIndex,
    ...(input.partIndex !== undefined ? { partIndex: input.partIndex } : {}),
    role: input.role,
    ...(runtimeEvent?.id ? { runtimeEventId: runtimeEvent.id } : {}),
    turnId: runtimeEvent?.turnId ?? input.placeholder?.turnId ?? input.turnId,
    ...((runtimeEvent?.runId ?? input.runId) ? { runId: runtimeEvent?.runId ?? input.runId } : {}),
    ...((runtimeEvent?.invocationId ?? input.invocationId)
      ? { invocationId: runtimeEvent?.invocationId ?? input.invocationId }
      : {}),
    ...((input.toolCallId ?? runtimeToolCallId(runtimeEvent))
      ? { toolCallId: input.toolCallId ?? runtimeToolCallId(runtimeEvent) }
      : {}),
    ...((input.toolName ?? runtimeToolName(runtimeEvent))
      ? { toolName: input.toolName ?? runtimeToolName(runtimeEvent) }
      : {}),
    contentKind,
    bodySha256,
    estimatedTokens: estimateTokens(bodyText.length, input.charsPerToken),
    ...(input.placeholder
      ? { originalEstimatedTokens: input.placeholder.originalEstimatedTokens }
      : {}),
    ...(input.placeholder ? { originalBytes: input.placeholder.originalBytes } : {}),
    ...(archiveRef ? { archiveRef } : {}),
  };
}

function providerPartBody(part: unknown): {
  contentKind: ActiveCompactionContentKind;
  body: unknown;
  toolCallId?: string;
  toolName?: string;
  placeholder?: ActiveArchivedToolResultPlaceholder;
} {
  if (!part || typeof part !== 'object') return { contentKind: 'unknown', body: part };
  const candidate = part as Record<string, unknown>;
  if (candidate.type === 'text') return { contentKind: 'text', body: candidate.text ?? '' };
  if (candidate.type === 'reasoning' || candidate.type === 'thinking') {
    return { contentKind: 'thinking', body: candidate.text ?? candidate.reasoning ?? '' };
  }
  if (candidate.type === 'tool-call') {
    return {
      contentKind: 'function_call',
      body: candidate.input ?? candidate.args ?? candidate,
      ...(typeof candidate.toolCallId === 'string' ? { toolCallId: candidate.toolCallId } : {}),
      ...(typeof candidate.toolName === 'string' ? { toolName: candidate.toolName } : {}),
    };
  }
  if (candidate.type === 'tool-result') {
    const payload = toolResultPayload(candidate);
    const placeholder = activePlaceholderFromPayload(payload);
    return {
      contentKind: placeholder ? 'active_archive_placeholder' : 'tool_result',
      body: payload,
      ...(typeof candidate.toolCallId === 'string' ? { toolCallId: candidate.toolCallId } : {}),
      ...(typeof candidate.toolName === 'string' ? { toolName: candidate.toolName } : {}),
      ...(placeholder ? { placeholder } : {}),
    };
  }
  return { contentKind: 'unknown', body: candidate };
}

function toolResultPayload(part: Record<string, unknown>): unknown {
  if ('result' in part) return part.result;
  const output = part.output;
  if (output && typeof output === 'object' && 'value' in output) {
    return (output as { value?: unknown }).value;
  }
  return output ?? part;
}

function activePlaceholderFromPayload(
  payload: unknown,
): ActiveArchivedToolResultPlaceholder | undefined {
  if (isActiveArchivedToolResultPlaceholder(payload)) return payload;
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown;
      return isActiveArchivedToolResultPlaceholder(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface RuntimeEventIndex {
  byToolCallId: Map<string, RuntimeEvent[]>;
  byBodySha256: Map<string, RuntimeEvent[]>;
  consumedEventIds: Set<string>;
}

function buildRuntimeEventIndex(events: readonly RuntimeEvent[]): RuntimeEventIndex {
  const byToolCallId = new Map<string, RuntimeEvent[]>();
  const byBodySha256 = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const toolCallId = runtimeToolCallId(event);
    if (toolCallId) pushMap(byToolCallId, toolCallId, event);
    pushMap(byBodySha256, runtimeEventBodySha256(event), event);
  }
  return { byToolCallId, byBodySha256, consumedEventIds: new Set() };
}

function matchRuntimeEvent(
  index: RuntimeEventIndex,
  input: {
    bodySha256: string;
    toolCallId?: string;
    toolName?: string;
    role: ActiveCompactionProviderRole;
    contentKind: ActiveCompactionContentKind;
  },
): RuntimeEvent | undefined {
  const preferredKind =
    input.contentKind === 'function_call'
      ? 'function_call'
      : input.contentKind === 'tool_result' || input.contentKind === 'active_archive_placeholder'
        ? 'function_response'
        : input.contentKind;
  const expectedRole = runtimeRoleForProviderRole(input.role);
  const candidates = (
    input.toolCallId
      ? (index.byToolCallId.get(input.toolCallId) ?? [])
      : (index.byBodySha256.get(input.bodySha256) ?? [])
  ).filter(
    (event) =>
      !index.consumedEventIds.has(event.id) &&
      event.role === expectedRole &&
      event.content?.kind === preferredKind &&
      (!input.toolName || !runtimeToolName(event) || runtimeToolName(event) === input.toolName),
  );
  const uniqueCandidates = [...new Map(candidates.map((event) => [event.id, event])).values()];
  if (uniqueCandidates.length !== 1) return undefined;
  const matched = uniqueCandidates[0]!;
  index.consumedEventIds.add(matched.id);
  return matched;
}

function runtimeRoleForProviderRole(role: ActiveCompactionProviderRole): RuntimeEvent['role'] {
  return role === 'assistant' ? 'model' : role;
}

function runtimeEventBodySha256(event: RuntimeEvent): string {
  const content = event.content;
  if (!content) return sha256('');
  switch (content.kind) {
    case 'text':
    case 'thinking':
      return sha256(content.text);
    case 'function_call':
      return sha256(stableStringify(content.args));
    case 'function_response':
      return sha256(serializeToolResultForArchive(content.result));
    case 'error':
      return sha256(stableStringify(content));
  }
}

function runtimeToolCallId(event: RuntimeEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (event.content?.kind === 'function_call' || event.content?.kind === 'function_response')
    return event.content.id;
  return event.refs?.toolCallId;
}

function runtimeToolName(event: RuntimeEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (event.content?.kind === 'function_call' || event.content?.kind === 'function_response')
    return event.content.name;
  return undefined;
}

function buildActiveCompactionToolLedger(
  entries: readonly ActiveCompactionSourceEntry[],
): ActiveCompactionToolLedger {
  const missingIdentitySourceIds: string[] = [];
  const byToolCallId = new Map<
    string,
    { calls: ActiveCompactionSourceEntry[]; results: ActiveCompactionSourceEntry[] }
  >();
  for (const entry of entries) {
    const isCall = entry.contentKind === 'function_call';
    const isResult = isToolResultKind(entry.contentKind);
    if (!isCall && !isResult) continue;
    if (!entry.toolCallId) {
      missingIdentitySourceIds.push(entry.sourceId);
      continue;
    }
    const group = byToolCallId.get(entry.toolCallId) ?? { calls: [], results: [] };
    if (isCall) group.calls.push(entry);
    else group.results.push(entry);
    byToolCallId.set(entry.toolCallId, group);
  }
  return {
    episodes: [...byToolCallId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([toolCallId, group]) => {
        const toolNames = uniqueSorted(
          [...group.calls, ...group.results].map((entry) => entry.toolName).filter(nonEmpty),
        );
        return {
          toolCallId,
          callSourceIds: group.calls.map((entry) => entry.sourceId),
          resultSourceIds: group.results.map((entry) => entry.sourceId),
          valid: group.calls.length === 1 && group.results.length <= 1 && toolNames.length <= 1,
        };
      }),
    missingIdentitySourceIds: uniqueSorted(missingIdentitySourceIds),
  };
}

function toolLedgerHasInvalidSourceAtOrAfter(
  index: ActiveCompactionSourceIndex,
  firstCandidateMessageIndex: number,
): boolean {
  const sourceMessageIndex = new Map(
    index.entries.map((entry) => [entry.sourceId, entry.messageIndex]),
  );
  const atOrAfter = (sourceId: string) =>
    (sourceMessageIndex.get(sourceId) ?? -1) >= firstCandidateMessageIndex;
  if (index.toolLedger.missingIdentitySourceIds.some(atOrAfter)) return true;
  return index.toolLedger.episodes.some(
    (episode) =>
      !episode.valid && [...episode.callSourceIds, ...episode.resultSourceIds].some(atOrAfter),
  );
}

function toolPairIntegrityViolation(
  selectedEntries: readonly ActiveCompactionSourceEntry[],
  ledger: ActiveCompactionToolLedger,
): boolean {
  const selectedSourceIds = new Set(selectedEntries.map((entry) => entry.sourceId));
  if (ledger.missingIdentitySourceIds.some((sourceId) => selectedSourceIds.has(sourceId))) {
    return true;
  }
  for (const episode of ledger.episodes) {
    const episodeSourceIds = [...episode.callSourceIds, ...episode.resultSourceIds];
    const selectedCount = episodeSourceIds.filter((sourceId) =>
      selectedSourceIds.has(sourceId),
    ).length;
    if (selectedCount === 0) continue;
    if (!episode.valid || episode.resultSourceIds.length !== 1) return true;
    if (selectedCount !== episodeSourceIds.length) return true;
  }
  return false;
}

function isToolResultKind(kind: ActiveCompactionContentKind): boolean {
  return (
    kind === 'function_response' || kind === 'tool_result' || kind === 'active_archive_placeholder'
  );
}

function archiveRefsEqual(
  left: ActiveCompactionArchiveRef | undefined,
  right: ActiveCompactionArchiveRef,
): boolean {
  return (
    Boolean(left) &&
    left?.kind === right.kind &&
    left.artifactId === right.artifactId &&
    left.bodySha256 === right.bodySha256 &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName
  );
}

function countReasons(
  reasons: readonly ActiveCompactionFailOpenReason[],
): Readonly<Record<ActiveCompactionFailOpenReason, number>> {
  const counts: Partial<Record<ActiveCompactionFailOpenReason, number>> = {};
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts as Readonly<Record<ActiveCompactionFailOpenReason, number>>;
}

function providerSourceId(messageIndex: number, partIndex?: number): string {
  return partIndex === undefined
    ? `provider:${messageIndex}`
    : `provider:${messageIndex}:${partIndex}`;
}

function normalizeProviderRole(role: string): ActiveCompactionProviderRole {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
  return 'user';
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function finiteRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(1, value);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
