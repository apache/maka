import { createHash } from 'node:crypto';
import type { ModelMessage } from './model-protocol.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import {
  compactionDecisionDiagnosticPatch,
  type CompactionArchiveRef,
  type CompactionBoundary,
  type CompactionDecisionKind,
} from './compaction-boundary.js';
import { estimateTokens } from './context-budget-helpers.js';
import { serializeToolResultForArchive } from './tool-result-archive.js';
import {
  type ActiveArchivedToolResultPlaceholder,
  isActiveArchivedToolResultPlaceholder,
} from './active-tool-result-prune.js';
import { buildActiveFullCompactFactSummary } from './active-full-compact-facts.js';

const DEFAULT_CHARS_PER_TOKEN = 4;
const MAX_PROVIDER_VISIBLE_ARCHIVE_REFS = 12;

export interface ActiveFullCompactPolicy {
  enabled: boolean;
  mode?: 'off' | 'index_only' | 'validate_only' | 'prepare_step_dry_run';
  minStepNumber?: number;
  highWaterRatio?: number;
  forceRatio?: number;
  targetRatio?: number;
  maxActiveEstimatedTokens?: number;
  minRecentMessages?: number;
  minRecentToolPairs?: number;
  maxSummaryEstimatedTokens?: number;
  summarySchemaVersion?: 1;
  archiveRequired?: boolean;
  highWaterName?: string;
}

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

export interface ActiveFullCompactSourceIndexInput {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  messages: readonly ModelMessage[];
  runtimeEvents?: readonly RuntimeEvent[];
  stepNumber?: number;
  charsPerToken?: number;
}

export type ActiveFullCompactProviderRole = 'system' | 'user' | 'assistant' | 'tool';
export type ActiveFullCompactContentKind =
  | 'text'
  | 'thinking'
  | 'function_call'
  | 'function_response'
  | 'tool_result'
  | 'active_archive_placeholder'
  | 'unknown';

export interface ActiveFullCompactArchiveRef {
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

export interface ActiveFullCompactSourceEntry {
  sourceId: string;
  messageIndex: number;
  partIndex?: number;
  role: ActiveFullCompactProviderRole;
  runtimeEventId?: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  toolCallId?: string;
  toolName?: string;
  contentKind: ActiveFullCompactContentKind;
  bodySha256: string;
  estimatedTokens: number;
  originalEstimatedTokens?: number;
  originalBytes?: number;
  archiveRef?: ActiveFullCompactArchiveRef;
}

export interface ActiveFullCompactSourceIndex {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  stepNumber?: number;
  providerMessageCount: number;
  entries: ActiveFullCompactSourceEntry[];
  activeCompactMessageIndexes?: number[];
  estimatedTokens: number;
}

export interface ActiveFullCompactCoverage {
  turnIds: string[];
  runtimeEventIds: string[];
  providerMessageSourceIds: string[];
  toolCallIds: string[];
  contentKinds: string[];
  bodySha256: string[];
}

export type ActiveFullCompactSelection =
  | {
      decision: 'selected';
      startMessageIndex: number;
      endMessageIndex: number;
      entries: ActiveFullCompactSourceEntry[];
      coverage: ActiveFullCompactCoverage;
      estimatedTokens: number;
    }
  | {
      decision: 'unchanged' | 'failedOpen';
      reason:
        | ActiveFullCompactFailOpenReason
        | 'disabled'
        | 'below_min_step'
        | 'below_high_water'
        | 'no_candidate';
      skippedReasonCounts: Readonly<Record<string, number>>;
    };

export type ActiveCompactionSafeSpanSelection =
  | ActiveFullCompactSelection
  | {
      decision: 'unchanged' | 'failedOpen';
      reason:
        | ActiveFullCompactFailOpenReason
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

export interface ActiveFullCompactSummary {
  schemaVersion: 1;
  text: string;
  processState?: string[];
  vmState?: string[];
  artifactPaths?: string[];
  commandsTried?: Array<{ command: string; outcome: string; sourceIds?: string[] }>;
  latestVerifierFailure?: string;
  constraints?: string[];
  failedHypotheses?: string[];
  currentHypothesis?: string;
  nextActions?: string[];
  archiveRefs?: string[];
}

export interface ActiveFullCompactSourceRef {
  kind: 'provider_message' | 'runtime_event' | 'active_archive_placeholder';
  sourceId: string;
  messageIndex: number;
  partIndex?: number;
  sessionId: string;
  turnId: string;
  runtimeEventId?: string;
  toolCallId?: string;
  toolName?: string;
  contentKind: ActiveFullCompactContentKind;
  bodySha256: string;
  archiveRef?: ActiveFullCompactArchiveRef;
}

export interface ActiveFullCompactBlock {
  kind: 'maka.active_full_compact_block';
  version: 1;
  blockId: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  trigger: {
    reason:
      | 'high_water'
      | 'force_ratio'
      | 'predictive_growth'
      | 'reactive_prompt_too_long'
      | 'manual_test';
    stepNumber?: number;
    estimatedTokensBefore?: number;
    thresholdTokens?: number;
  };
  coverage: ActiveFullCompactCoverage;
  preservedAnchor?: {
    headRuntimeEventIds?: string[];
    tailRuntimeEventIds?: string[];
    tailProviderMessageSourceIds?: string[];
    tailTurnIds?: string[];
  };
  summary: ActiveFullCompactSummary;
  limitations: string[];
  sourceRefs: ActiveFullCompactSourceRef[];
  archiveRefs?: ActiveFullCompactArchiveRef[];
  estimatedTokens?: number;
  preActiveContextEstimatedTokens?: number;
  postReplacementEstimatedTokens?: number;
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  willRetriggerImmediately?: boolean;
  compactCallUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    totalTokens?: number;
  };
}

export type ActiveFullCompactFailOpenReason =
  | 'invalid_schema_version'
  | 'session_mismatch'
  | 'turn_mismatch'
  | 'source_missing'
  | 'coverage_miss'
  | 'source_hash_mismatch'
  | 'tool_pair_split'
  | 'archive_missing'
  | 'archive_mismatch'
  | 'summary_missing'
  | 'summary_too_large'
  | 'max_block_tokens'
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

export interface ActiveFullCompactValidationResult {
  valid: boolean;
  reasons: ActiveFullCompactFailOpenReason[];
  reasonCounts: Readonly<Record<ActiveFullCompactFailOpenReason, number>>;
}

export type ActiveFullCompactRewriteDecision = 'unchanged' | 'replaced' | 'failedOpen';

export interface ActiveFullCompactRewriteInput {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  messages: readonly ModelMessage[];
  policy: ActiveFullCompactPolicy | undefined;
  runtimeEvents?: readonly RuntimeEvent[];
  stepNumber: number;
  now?: number;
  charsPerToken?: number;
  requestShapeHashBefore?: string;
  requestShapeHashForMessages?: (messages: readonly ModelMessage[]) => string;
  headAnchor?: ActiveCompactionHeadAnchor;
  dryRun?: boolean;
  dryRunReason?: string;
}

export interface ActiveFullCompactRewriteResult {
  messages: ModelMessage[];
  decision: ActiveFullCompactRewriteDecision;
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
  block?: ActiveFullCompactBlock;
  selection?: ActiveFullCompactSelection | ActiveCompactionSafeSpanSelection;
  validation?: ActiveFullCompactValidationResult;
}

export interface BuildActiveFullCompactBlockInput {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  entries: readonly ActiveFullCompactSourceEntry[];
  summary: ActiveFullCompactSummary;
  highWaterName?: string;
  highWaterSeq?: number;
  trigger?: ActiveFullCompactBlock['trigger'];
  preservedAnchor?: ActiveFullCompactBlock['preservedAnchor'];
  limitations?: readonly string[];
  now?: number;
  charsPerToken?: number;
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  preActiveContextEstimatedTokens?: number;
  postReplacementEstimatedTokens?: number;
  willRetriggerImmediately?: boolean;
  compactCallUsage?: ActiveFullCompactBlock['compactCallUsage'];
}

export function buildActiveFullCompactSourceIndex(
  input: ActiveFullCompactSourceIndexInput,
): ActiveFullCompactSourceIndex {
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const runtimeIndex = buildRuntimeEventIndex(input.runtimeEvents ?? [], charsPerToken);
  const entries: ActiveFullCompactSourceEntry[] = [];
  const activeCompactMessageIndexes: number[] = [];

  input.messages.forEach((message, messageIndex) => {
    const role = normalizeProviderRole(message.role);
    const content = (message as { content?: unknown }).content;
    if (messageContentContainsActiveFullCompactBlock(content)) {
      activeCompactMessageIndexes.push(messageIndex);
    }
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

  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    ...(input.stepNumber !== undefined ? { stepNumber: input.stepNumber } : {}),
    providerMessageCount: input.messages.length,
    entries,
    ...(activeCompactMessageIndexes.length > 0 ? { activeCompactMessageIndexes } : {}),
    estimatedTokens: estimateActiveFullCompactTokens(entries),
  };
}

export function activeFullCompactCoverageFromEntries(
  entries: readonly ActiveFullCompactSourceEntry[],
): ActiveFullCompactCoverage {
  return {
    turnIds: uniqueSorted(entries.map((entry) => entry.turnId)),
    runtimeEventIds: uniqueSorted(entries.map((entry) => entry.runtimeEventId).filter(nonEmpty)),
    providerMessageSourceIds: uniqueSorted(entries.map((entry) => entry.sourceId)),
    toolCallIds: uniqueSorted(entries.map((entry) => entry.toolCallId).filter(nonEmpty)),
    contentKinds: uniqueSorted(entries.map((entry) => entry.contentKind)),
    bodySha256: uniqueSorted(entries.map((entry) => entry.bodySha256)),
  };
}

export function estimateActiveFullCompactTokens(
  entries: readonly ActiveFullCompactSourceEntry[],
): number {
  return entries.reduce((total, entry) => total + entry.estimatedTokens, 0);
}

export function selectActiveFullCompactCoveredSpan(
  index: ActiveFullCompactSourceIndex,
  policy: ActiveFullCompactPolicy | undefined,
): ActiveFullCompactSelection {
  if (policy?.enabled !== true || policy.mode === 'off') {
    return skippedSelection('unchanged', 'disabled');
  }
  const minStepNumber = Math.max(0, Math.floor(policy.minStepNumber ?? 1));
  if ((index.stepNumber ?? 0) < minStepNumber) {
    return skippedSelection('unchanged', 'below_min_step');
  }

  const highWaterRatio = finiteRatio(policy.highWaterRatio, 0.8);
  const maxActiveEstimatedTokens = finitePositive(policy.maxActiveEstimatedTokens);
  if (
    maxActiveEstimatedTokens !== undefined &&
    index.estimatedTokens <= Math.floor(maxActiveEstimatedTokens * highWaterRatio)
  ) {
    return skippedSelection('unchanged', 'below_high_water');
  }

  const minRecentMessages = Math.max(0, Math.floor(policy.minRecentMessages ?? 1));
  const endExclusive = Math.max(0, index.providerMessageCount - minRecentMessages);
  const latestActiveCompactMessageIndex = latestActiveFullCompactMessageIndex(index);
  const entries = index.entries.filter(
    (entry) =>
      entry.messageIndex > latestActiveCompactMessageIndex && entry.messageIndex < endExclusive,
  );
  if (entries.length === 0) return skippedSelection('unchanged', 'no_candidate');
  if (entries.some((entry) => !nonEmpty(entry.sourceId) || !nonEmpty(entry.bodySha256))) {
    return skippedSelection('failedOpen', 'source_missing');
  }
  if (
    policy.archiveRequired === true &&
    entries.some((entry) => !entry.runtimeEventId && !entry.archiveRef)
  ) {
    return skippedSelection('failedOpen', 'provider_message_only_when_runtime_required');
  }
  if (toolPairSplit(entries, index.entries)) {
    return skippedSelection('failedOpen', 'tool_pair_split');
  }

  return {
    decision: 'selected',
    startMessageIndex: Math.min(...entries.map((entry) => entry.messageIndex)),
    endMessageIndex: Math.max(...entries.map((entry) => entry.messageIndex)),
    entries,
    coverage: activeFullCompactCoverageFromEntries(entries),
    estimatedTokens: estimateActiveFullCompactTokens(entries),
  };
}

/**
 * Select the completed active-turn span after the exact current-user anchor.
 * This deliberately makes no semantic relevance judgment. It only groups
 * provider protocol episodes and stops before the first open/incomplete one.
 */
export function selectActiveCompactionSafeSpan(input: {
  index: ActiveFullCompactSourceIndex;
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
  index: ActiveFullCompactSourceIndex,
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
  if (toolPairSplit(entries, index.entries))
    return safeSpanSkipped('failedOpen', 'tool_pair_split');
  const estimatedTokens = estimateActiveFullCompactTokens(entries);
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
    coverage: activeFullCompactCoverageFromEntries(entries),
    estimatedTokens,
  };
}

function entriesAtMessageIndex(
  entries: readonly ActiveFullCompactSourceEntry[],
  messageIndex: number,
): ActiveFullCompactSourceEntry[] {
  return entries.filter((entry) => entry.messageIndex === messageIndex);
}

function providerMessageRole(
  message: ModelMessage | undefined,
  entries: readonly ActiveFullCompactSourceEntry[],
): ActiveFullCompactProviderRole | undefined {
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

export function buildActiveFullCompactBlockFromSummary(
  input: BuildActiveFullCompactBlockInput,
): ActiveFullCompactBlock {
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const highWaterName = input.highWaterName ?? 'active-full-compact-high-water';
  const coverage = activeFullCompactCoverageFromEntries(input.entries);
  const createdAt = input.now ?? Date.now();
  const highWaterSeq = input.highWaterSeq ?? input.trigger?.stepNumber ?? createdAt;
  const summary = normalizeSummary(input.summary);
  const archiveRefs = uniqueArchiveRefs(
    input.entries.map((entry) => entry.archiveRef).filter(isArchiveRef),
  );
  const sourceRefs = input.entries.map(
    (entry): ActiveFullCompactSourceRef => ({
      kind: entry.archiveRef
        ? 'active_archive_placeholder'
        : entry.runtimeEventId
          ? 'runtime_event'
          : 'provider_message',
      sourceId: entry.sourceId,
      messageIndex: entry.messageIndex,
      ...(entry.partIndex !== undefined ? { partIndex: entry.partIndex } : {}),
      sessionId: input.sessionId,
      turnId: entry.turnId,
      ...(entry.runtimeEventId ? { runtimeEventId: entry.runtimeEventId } : {}),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      contentKind: entry.contentKind,
      bodySha256: entry.bodySha256,
      ...(entry.archiveRef ? { archiveRef: entry.archiveRef } : {}),
    }),
  );
  const blockDraft = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    coverage,
    summarySchemaVersion: summary.schemaVersion,
    summaryText: summary.text,
    highWaterName,
    highWaterSeq,
  };

  const block: ActiveFullCompactBlock = {
    kind: 'maka.active_full_compact_block',
    version: 1,
    blockId: stableActiveFullCompactBlockId(blockDraft),
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    createdAt,
    highWaterName,
    highWaterSeq,
    trigger: input.trigger ?? {
      reason: 'manual_test',
      estimatedTokensBefore: estimateActiveFullCompactTokens(input.entries),
    },
    coverage,
    ...(input.preservedAnchor ? { preservedAnchor: input.preservedAnchor } : {}),
    summary,
    limitations: [
      ...(input.limitations ?? []),
      'Active full compact uses a deterministic source-bounded process/task summary for provider-visible active-step replacement.',
      ...(archiveRefs.length === 0
        ? [
            'No active archive refs are attached; source coverage is by provider source ids and optional RuntimeEvent ids.',
          ]
        : []),
    ],
    sourceRefs,
    ...(archiveRefs.length > 0 ? { archiveRefs } : {}),
    ...(input.requestShapeHashBefore
      ? { requestShapeHashBefore: input.requestShapeHashBefore }
      : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
    ...(input.preActiveContextEstimatedTokens !== undefined
      ? { preActiveContextEstimatedTokens: input.preActiveContextEstimatedTokens }
      : {}),
    ...(input.postReplacementEstimatedTokens !== undefined
      ? { postReplacementEstimatedTokens: input.postReplacementEstimatedTokens }
      : {}),
    ...(input.willRetriggerImmediately !== undefined
      ? { willRetriggerImmediately: input.willRetriggerImmediately }
      : {}),
    ...(input.compactCallUsage ? { compactCallUsage: input.compactCallUsage } : {}),
  };
  block.estimatedTokens = estimateTokens(renderActiveFullCompactBlock(block).length, charsPerToken);
  return block;
}

export function buildDeterministicActiveFullCompactSummary(input: {
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>;
  messages: readonly ModelMessage[];
  runtimeEvents?: readonly RuntimeEvent[];
  maxSummaryEstimatedTokens?: number;
  charsPerToken?: number;
}): ActiveFullCompactSummary {
  return buildDeterministicProcessStateActiveFullCompactSummary(input);
}

export function buildDeterministicProcessStateActiveFullCompactSummary(input: {
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>;
  messages: readonly ModelMessage[];
  runtimeEvents?: readonly RuntimeEvent[];
  maxSummaryEstimatedTokens?: number;
  charsPerToken?: number;
}): ActiveFullCompactSummary {
  return buildActiveFullCompactFactSummary(input);
}

export function activeFullCompactBlockToModelMessage(block: ActiveFullCompactBlock): ModelMessage {
  return {
    role: 'user',
    content: renderActiveFullCompactBlock(block),
  } as ModelMessage;
}

export function rewriteActiveFullCompactInMessages(
  input: ActiveFullCompactRewriteInput,
): ActiveFullCompactRewriteResult {
  const messages = [...input.messages];
  const index = buildActiveFullCompactSourceIndex({
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    messages,
    runtimeEvents: input.runtimeEvents,
    stepNumber: input.stepNumber,
    charsPerToken: input.charsPerToken,
  });
  const latestProjectionMessageIndex = Math.max(
    latestActiveFullCompactMessageIndex(index),
    latestSemanticCompactMessageIndex(messages),
  );
  const selection = input.headAnchor
    ? selectActiveCompactionSafeSpan({
        index,
        messages,
        policy: input.policy,
        headAnchor: input.headAnchor,
        ...(latestProjectionMessageIndex > input.headAnchor.messageIndex
          ? { afterMessageIndex: latestProjectionMessageIndex }
          : {}),
      })
    : selectActiveFullCompactCoveredSpan(index, input.policy);

  if (selection.decision !== 'selected') {
    const maxActiveEstimatedTokens = finitePositive(input.policy?.maxActiveEstimatedTokens);
    const headAnchorExceedsCapacity =
      input.headAnchor !== undefined &&
      maxActiveEstimatedTokens !== undefined &&
      input.headAnchor.estimatedTokens >= maxActiveEstimatedTokens;
    if (headAnchorExceedsCapacity) {
      const capacitySelection = safeSpanSkipped('failedOpen', 'head_anchor_exceeds_capacity');
      return {
        messages,
        decision: 'failedOpen',
        selection: capacitySelection,
        diagnosticPatch: activeFullCompactDecisionDiagnosticPatch({
          decision: 'failedOpen',
          reason: 'head_anchor_exceeds_capacity',
          failOpenReason: 'head_anchor_exceeds_capacity',
          skippedReasonCounts: capacitySelection.skippedReasonCounts,
          estimatedTokensBefore: index.estimatedTokens,
          estimatedTokensAfter: index.estimatedTokens,
        }),
      };
    }
    const decision = selection.decision === 'failedOpen' ? 'failedOpen' : 'unchanged';
    return {
      messages,
      decision,
      selection,
      diagnosticPatch: activeFullCompactDecisionDiagnosticPatch({
        decision,
        reason: selection.reason,
        ...(selection.decision === 'failedOpen' && isFailOpenReason(selection.reason)
          ? { failOpenReason: selection.reason }
          : {}),
        skippedReasonCounts: selection.skippedReasonCounts,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: index.estimatedTokens,
      }),
    };
  }

  if (!selectionCoversContiguousWholeMessages(selection)) {
    return failedOpenRewrite(messages, selection, index, 'coverage_miss');
  }
  if (selectedSpanContainsActiveFullCompactBlock(messages, selection)) {
    return failedOpenRewrite(messages, selection, index, 'coverage_miss');
  }

  const summary = buildDeterministicActiveFullCompactSummary({
    selection,
    messages,
    runtimeEvents: input.runtimeEvents,
    maxSummaryEstimatedTokens: input.policy?.maxSummaryEstimatedTokens,
    charsPerToken: input.charsPerToken,
  });
  const renderedSummaryTokens = estimateTokens(
    stableStringify(summary).length,
    input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
  );
  const maxSummaryTokens = finitePositive(input.policy?.maxSummaryEstimatedTokens);
  if (maxSummaryTokens !== undefined && renderedSummaryTokens > maxSummaryTokens) {
    return failedOpenRewrite(messages, selection, index, 'summary_too_large');
  }

  const requestShapeHashBefore =
    input.requestShapeHashBefore ?? input.requestShapeHashForMessages?.(messages);
  const block = buildActiveFullCompactBlockFromSummary({
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    entries: selection.entries,
    summary,
    highWaterName: input.policy?.highWaterName,
    highWaterSeq: input.stepNumber,
    trigger: {
      reason: 'high_water',
      stepNumber: input.stepNumber,
      estimatedTokensBefore: index.estimatedTokens,
      ...(input.policy?.maxActiveEstimatedTokens !== undefined
        ? {
            thresholdTokens: Math.floor(
              input.policy.maxActiveEstimatedTokens * finiteRatio(input.policy.highWaterRatio, 0.8),
            ),
          }
        : {}),
    },
    preservedAnchor: preservedAnchorAfterSelection(index, selection),
    now: input.now,
    charsPerToken: input.charsPerToken,
    requestShapeHashBefore,
    preActiveContextEstimatedTokens: index.estimatedTokens,
  });
  block.postReplacementEstimatedTokens = estimatePostReplacementTokens(
    index,
    selection,
    estimateActiveFullCompactProviderTokens(block, input.charsPerToken),
  );
  const validation = validateActiveFullCompactBlockForSourceIndex(block, index, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    archiveRequired: input.policy?.archiveRequired,
    maxSummaryEstimatedTokens: input.policy?.maxSummaryEstimatedTokens,
    maxBlockEstimatedTokens: maxActiveFullCompactBlockTokens(
      input.policy?.maxSummaryEstimatedTokens,
    ),
    charsPerToken: input.charsPerToken,
  });
  if (!validation.valid) {
    return {
      messages,
      decision: 'failedOpen',
      selection,
      block,
      validation,
      diagnosticPatch: activeFullCompactDecisionDiagnosticPatch({
        decision: 'failedOpen',
        boundaryIds: [block.blockId],
        coverage: block.coverage,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: index.estimatedTokens,
        failOpenReason: validation.reasons[0] ?? 'coverage_miss',
        validationReasonCounts: validation.reasonCounts,
      }),
    };
  }

  const replacementMessage = activeFullCompactBlockToModelMessage(block);
  const replacementMessages = [
    ...messages.slice(0, selection.startMessageIndex),
    replacementMessage,
    ...messages.slice(selection.endMessageIndex + 1),
  ];
  if (!replacementShapeValid(messages, replacementMessages, selection, replacementMessage)) {
    return failedOpenRewrite(messages, selection, index, 'coverage_miss', block, validation);
  }
  const requestShapeHashAfter = input.requestShapeHashForMessages?.(replacementMessages);
  if (requestShapeHashAfter) block.requestShapeHashAfter = requestShapeHashAfter;

  if (input.dryRun === true) {
    return {
      messages,
      decision: 'unchanged',
      selection,
      block,
      validation,
      diagnosticPatch: {
        ...activeFullCompactDecisionDiagnosticPatch({
          decision: 'unchanged',
          boundaryIds: [block.blockId],
          coverage: block.coverage,
          estimatedTokensBefore: index.estimatedTokens,
          estimatedTokensAfter: index.estimatedTokens,
          reason: input.dryRunReason ?? 'prepare_step_dry_run',
          validationReasonCounts: validation.reasonCounts,
        }),
        ...(requestShapeHashBefore
          ? {
              highWaterRequestShapeHashBefore: requestShapeHashBefore,
              highWaterRequestShapeHashAfter: requestShapeHashBefore,
            }
          : {}),
      },
    };
  }

  return {
    messages: replacementMessages,
    decision: 'replaced',
    selection,
    block,
    validation,
    diagnosticPatch: {
      ...activeFullCompactDecisionDiagnosticPatch({
        decision: 'replaced',
        boundaryIds: [block.blockId],
        coverage: block.coverage,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: block.postReplacementEstimatedTokens,
        validationReasonCounts: validation.reasonCounts,
      }),
      ...(requestShapeHashBefore && requestShapeHashAfter
        ? {
            highWaterRequestShapeHashBefore: requestShapeHashBefore,
            highWaterRequestShapeHashAfter: requestShapeHashAfter,
          }
        : {}),
    },
  };
}

export function renderActiveFullCompactBlock(block: ActiveFullCompactBlock): string {
  const lines = [
    `<maka_active_full_compact_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}" version="${block.version}">`,
    `summary: ${block.summary.text}`,
    ...renderSummarySections(block.summary),
    `limitations: ${block.limitations.join('; ')}`,
    ...(block.archiveRefs && block.archiveRefs.length > 0
      ? [`archives: ${renderProviderVisibleArchiveRefs(block.archiveRefs).join('; ')}`]
      : []),
    `audit: full coverage, source refs, source hashes, and archive refs are retained on the durable active compact block and diagnostics.`,
    '</maka_active_full_compact_block>',
  ];
  return lines.join('\n');
}

export function validateActiveFullCompactBlockShape(
  value: unknown,
  sessionId?: string,
): value is ActiveFullCompactBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Partial<ActiveFullCompactBlock>;
  return (
    block.kind === 'maka.active_full_compact_block' &&
    block.version === 1 &&
    nonEmpty(block.blockId) &&
    nonEmpty(block.sessionId) &&
    (sessionId === undefined || block.sessionId === sessionId) &&
    nonEmpty(block.turnId) &&
    Number.isFinite(block.createdAt) &&
    nonEmpty(block.highWaterName) &&
    Number.isFinite(block.highWaterSeq) &&
    !!block.trigger &&
    isTriggerReason(block.trigger.reason) &&
    !!block.coverage &&
    Array.isArray(block.coverage.turnIds) &&
    Array.isArray(block.coverage.runtimeEventIds) &&
    Array.isArray(block.coverage.providerMessageSourceIds) &&
    Array.isArray(block.coverage.toolCallIds) &&
    Array.isArray(block.coverage.contentKinds) &&
    Array.isArray(block.coverage.bodySha256) &&
    allNonEmpty(block.coverage.turnIds) &&
    allNonEmpty(block.coverage.providerMessageSourceIds) &&
    allNonEmpty(block.coverage.contentKinds) &&
    allNonEmpty(block.coverage.bodySha256) &&
    !!block.summary &&
    block.summary.schemaVersion === 1 &&
    nonEmpty(block.summary.text) &&
    Array.isArray(block.limitations) &&
    Array.isArray(block.sourceRefs) &&
    block.sourceRefs.length > 0 &&
    block.sourceRefs.every(isValidSourceRef) &&
    (block.archiveRefs === undefined ||
      (Array.isArray(block.archiveRefs) && block.archiveRefs.every(isArchiveRef))) &&
    optionalNonNegativeFiniteNumber(block.estimatedTokens)
  );
}

export function validateActiveFullCompactBlockForSourceIndex(
  value: unknown,
  index: ActiveFullCompactSourceIndex,
  options: {
    sessionId?: string;
    turnId?: string;
    archiveRequired?: boolean;
    requireRuntimeEventCoverage?: boolean;
    maxSummaryEstimatedTokens?: number;
    maxBlockEstimatedTokens?: number;
    charsPerToken?: number;
  } = {},
): ActiveFullCompactValidationResult {
  const reasons: ActiveFullCompactFailOpenReason[] = [];
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const add = (reason: ActiveFullCompactFailOpenReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (!validateActiveFullCompactBlockShape(value, options.sessionId ?? index.sessionId)) {
    add('invalid_schema_version');
    if (value && typeof value === 'object') {
      const partial = value as Partial<ActiveFullCompactBlock>;
      if (
        partial.sessionId !== undefined &&
        (partial.sessionId !== index.sessionId ||
          (options.sessionId && partial.sessionId !== options.sessionId))
      ) {
        add('session_mismatch');
      }
      if (
        partial.turnId !== undefined &&
        (partial.turnId !== index.turnId || (options.turnId && partial.turnId !== options.turnId))
      ) {
        add('turn_mismatch');
      }
      const summaryText =
        partial.summary && typeof partial.summary === 'object'
          ? (partial.summary as Partial<ActiveFullCompactSummary>).text
          : undefined;
      if (!nonEmpty(summaryText)) add('summary_missing');
      const maxSummaryTokens = finitePositive(options.maxSummaryEstimatedTokens);
      if (
        maxSummaryTokens !== undefined &&
        partial.summary !== undefined &&
        estimateTokens(stableStringify(partial.summary).length, charsPerToken) > maxSummaryTokens
      ) {
        add('summary_too_large');
      }
      const maxBlockTokens = finitePositive(options.maxBlockEstimatedTokens);
      if (
        maxBlockTokens !== undefined &&
        typeof partial.estimatedTokens === 'number' &&
        Number.isFinite(partial.estimatedTokens) &&
        partial.estimatedTokens > maxBlockTokens
      ) {
        add('max_block_tokens');
      }
    } else {
      add('summary_missing');
    }
    return {
      valid: false,
      reasons,
      reasonCounts: countReasons(reasons),
    };
  }
  const block = value;
  if (
    block.sessionId !== index.sessionId ||
    (options.sessionId && block.sessionId !== options.sessionId)
  ) {
    add('session_mismatch');
  }
  if (block.turnId !== index.turnId || (options.turnId && block.turnId !== options.turnId)) {
    add('turn_mismatch');
  }
  if (!nonEmpty(block.summary?.text)) add('summary_missing');
  const maxSummaryTokens = finitePositive(options.maxSummaryEstimatedTokens);
  if (
    maxSummaryTokens !== undefined &&
    estimateTokens(stableStringify(block.summary).length, charsPerToken) > maxSummaryTokens
  ) {
    add('summary_too_large');
  }
  const maxBlockTokens = finitePositive(options.maxBlockEstimatedTokens);
  if (maxBlockTokens !== undefined) {
    const blockTokens = estimateActiveFullCompactProviderTokens(block, charsPerToken);
    if (blockTokens > maxBlockTokens) add('max_block_tokens');
  }

  const entriesBySource = new Map(index.entries.map((entry) => [entry.sourceId, entry]));
  const selectedEntries: ActiveFullCompactSourceEntry[] = [];
  for (const sourceId of block.coverage.providerMessageSourceIds) {
    const entry = entriesBySource.get(sourceId);
    if (!entry) {
      add('source_missing');
      continue;
    }
    selectedEntries.push(entry);
    if (!block.coverage.turnIds.includes(entry.turnId)) add('coverage_miss');
    if (entry.runtimeEventId && !block.coverage.runtimeEventIds.includes(entry.runtimeEventId))
      add('coverage_miss');
    if (entry.toolCallId && !block.coverage.toolCallIds.includes(entry.toolCallId))
      add('coverage_miss');
    if (!block.coverage.contentKinds.includes(entry.contentKind)) add('coverage_miss');
    if (!block.coverage.bodySha256.includes(entry.bodySha256)) add('source_hash_mismatch');
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
  for (const hash of block.coverage.bodySha256) {
    if (!selectedEntries.some((entry) => entry.bodySha256 === hash)) add('source_hash_mismatch');
  }
  if (toolPairSplit(selectedEntries, index.entries)) add('tool_pair_split');
  if (block.archiveRefs) {
    for (const ref of block.archiveRefs) {
      const match = selectedEntries.find((entry) => archiveRefsEqual(entry.archiveRef, ref));
      if (!match) add('archive_mismatch');
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    reasonCounts: countReasons(reasons),
  };
}

export function activeFullCompactBlockToCompactionBoundary(
  block: ActiveFullCompactBlock,
  options: {
    renderedText?: string;
    validationStatus?: CompactionBoundary['validationStatus'];
    validationReason?: string;
  } = {},
): CompactionBoundary {
  return {
    kind: 'activeFullCompact',
    stage: 'activeStep',
    schemaVersion: block.version,
    boundaryId: block.blockId,
    sessionId: block.sessionId,
    createdAt: block.createdAt,
    highWaterName: block.highWaterName,
    highWaterSeq: block.highWaterSeq,
    coverage: {
      turnIds: block.coverage.turnIds,
      runtimeEventIds: block.coverage.runtimeEventIds,
      toolCallIds: block.coverage.toolCallIds,
      contentKinds: block.coverage.contentKinds,
      bodySha256: block.coverage.bodySha256,
    },
    ...(block.preservedAnchor ? { preservedAnchor: block.preservedAnchor } : {}),
    ...(block.archiveRefs && block.archiveRefs.length > 0
      ? { archiveRefs: block.archiveRefs.map(activeArchiveRefToBoundaryArchiveRef) }
      : {}),
    sourceHashes: block.coverage.bodySha256,
    renderedText: options.renderedText ?? renderActiveFullCompactBlock(block),
    ...(block.estimatedTokens !== undefined ? { estimatedTokens: block.estimatedTokens } : {}),
    validationStatus: options.validationStatus ?? 'notValidated',
    ...(options.validationReason ? { validationReason: options.validationReason } : {}),
  };
}

export function activeFullCompactDecisionDiagnosticPatch(input: {
  decision: CompactionDecisionKind;
  boundaryIds?: readonly string[];
  coverage?: ActiveFullCompactCoverage;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  reason?: string;
  failOpenReason?: ActiveFullCompactFailOpenReason;
  skippedReasonCounts?: Readonly<Record<string, number>>;
  validationReasonCounts?: Readonly<Record<string, number>>;
}): Partial<ContextBudgetDiagnostic> {
  return compactionDecisionDiagnosticPatch({
    stage: 'activeStep',
    sourceKind: 'providerMessages',
    boundaryKind: 'activeFullCompact',
    decision: input.decision,
    ...(input.boundaryIds ? { boundaryIds: input.boundaryIds } : {}),
    ...(input.coverage
      ? {
          coverage: {
            turnIds: input.coverage.turnIds,
            runtimeEventIds: input.coverage.runtimeEventIds,
            toolCallIds: input.coverage.toolCallIds,
            contentKinds: input.coverage.contentKinds,
            bodySha256: input.coverage.bodySha256,
          },
        }
      : {}),
    ...(input.estimatedTokensBefore !== undefined
      ? { estimatedTokensBefore: input.estimatedTokensBefore }
      : {}),
    ...(input.estimatedTokensAfter !== undefined
      ? { estimatedTokensAfter: input.estimatedTokensAfter }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.failOpenReason ? { failOpenReason: input.failOpenReason } : {}),
    ...(input.skippedReasonCounts ? { skippedReasonCounts: input.skippedReasonCounts } : {}),
    ...(input.validationReasonCounts
      ? { validationReasonCounts: input.validationReasonCounts }
      : {}),
  });
}

function failedOpenRewrite(
  messages: ModelMessage[],
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>,
  index: ActiveFullCompactSourceIndex,
  failOpenReason: ActiveFullCompactFailOpenReason,
  block?: ActiveFullCompactBlock,
  validation?: ActiveFullCompactValidationResult,
): ActiveFullCompactRewriteResult {
  return {
    messages,
    decision: 'failedOpen',
    selection,
    ...(block ? { block } : {}),
    ...(validation ? { validation } : {}),
    diagnosticPatch: activeFullCompactDecisionDiagnosticPatch({
      decision: 'failedOpen',
      ...(block
        ? { boundaryIds: [block.blockId], coverage: block.coverage }
        : { coverage: selection.coverage }),
      estimatedTokensBefore: index.estimatedTokens,
      estimatedTokensAfter: index.estimatedTokens,
      failOpenReason,
      skippedReasonCounts: { [failOpenReason]: 1 },
      ...(validation ? { validationReasonCounts: validation.reasonCounts } : {}),
    }),
  };
}

function isFailOpenReason(reason: string): reason is ActiveFullCompactFailOpenReason {
  return (
    reason === 'invalid_schema_version' ||
    reason === 'session_mismatch' ||
    reason === 'turn_mismatch' ||
    reason === 'source_missing' ||
    reason === 'coverage_miss' ||
    reason === 'source_hash_mismatch' ||
    reason === 'tool_pair_split' ||
    reason === 'archive_missing' ||
    reason === 'archive_mismatch' ||
    reason === 'summary_missing' ||
    reason === 'summary_too_large' ||
    reason === 'max_block_tokens' ||
    reason === 'head_anchor_exceeds_capacity' ||
    reason === 'provider_message_only_when_runtime_required'
  );
}

function selectionCoversContiguousWholeMessages(
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>,
): boolean {
  const expected = new Set<number>();
  for (let index = selection.startMessageIndex; index <= selection.endMessageIndex; index += 1) {
    expected.add(index);
  }
  const actual = new Set(selection.entries.map((entry) => entry.messageIndex));
  if (actual.size !== expected.size) return false;
  for (const index of expected) {
    if (!actual.has(index)) return false;
  }
  return true;
}

function selectedSpanContainsActiveFullCompactBlock(
  messages: readonly ModelMessage[],
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>,
): boolean {
  for (let index = selection.startMessageIndex; index <= selection.endMessageIndex; index += 1) {
    const content = (messages[index] as { content?: unknown } | undefined)?.content;
    if (messageContentContainsActiveFullCompactBlock(content)) return true;
  }
  return false;
}

function latestActiveFullCompactMessageIndex(index: ActiveFullCompactSourceIndex): number {
  return Math.max(-1, ...(index.activeCompactMessageIndexes ?? []));
}

function latestSemanticCompactMessageIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      stableStringify((messages[index] as { content?: unknown }).content).includes(
        '<maka_semantic_compact_block',
      )
    ) {
      return index;
    }
  }
  return -1;
}

function messageContentContainsActiveFullCompactBlock(content: unknown): boolean {
  return typeof content === 'string'
    ? content.includes('maka_active_full_compact_block')
    : stableStringify(content).includes('maka_active_full_compact_block');
}

function preservedAnchorAfterSelection(
  index: ActiveFullCompactSourceIndex,
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>,
): ActiveFullCompactBlock['preservedAnchor'] {
  const tailEntries = index.entries.filter(
    (entry) => entry.messageIndex > selection.endMessageIndex,
  );
  return {
    tailRuntimeEventIds: uniqueSorted(
      tailEntries.map((entry) => entry.runtimeEventId).filter(nonEmpty),
    ),
    tailProviderMessageSourceIds: uniqueSorted(tailEntries.map((entry) => entry.sourceId)),
    tailTurnIds: uniqueSorted(tailEntries.map((entry) => entry.turnId)),
  };
}

function estimatePostReplacementTokens(
  index: ActiveFullCompactSourceIndex,
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>,
  replacementEstimatedTokens: number,
): number {
  const selectedIds = new Set(selection.entries.map((entry) => entry.sourceId));
  const retainedTokens = index.entries
    .filter((entry) => !selectedIds.has(entry.sourceId))
    .reduce((total, entry) => total + entry.estimatedTokens, 0);
  return retainedTokens + replacementEstimatedTokens;
}

function estimateActiveFullCompactProviderTokens(
  block: ActiveFullCompactBlock,
  charsPerToken?: number,
): number {
  return estimateTokens(
    renderActiveFullCompactBlock(block).length,
    charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
  );
}

function maxActiveFullCompactBlockTokens(
  maxSummaryEstimatedTokens: number | undefined,
): number | undefined {
  const summaryTokens = finitePositive(maxSummaryEstimatedTokens);
  if (summaryTokens === undefined) return undefined;
  return Math.max(summaryTokens * 8, summaryTokens + 2048);
}

function replacementShapeValid(
  original: readonly ModelMessage[],
  replacement: readonly ModelMessage[],
  selection: Extract<ActiveFullCompactSelection, { decision: 'selected' }>,
  replacementMessage: ModelMessage,
): boolean {
  const expectedLength =
    original.length - (selection.endMessageIndex - selection.startMessageIndex + 1) + 1;
  if (replacement.length !== expectedLength) return false;
  if (replacement[selection.startMessageIndex] !== replacementMessage) return false;
  for (let index = 0; index < selection.startMessageIndex; index += 1) {
    if (replacement[index] !== original[index]) return false;
  }
  const suffixOffset = selection.endMessageIndex - selection.startMessageIndex;
  for (let index = selection.endMessageIndex + 1; index < original.length; index += 1) {
    if (replacement[index - suffixOffset] !== original[index]) return false;
  }
  return true;
}

function entryFromProviderPart(input: {
  sourceId: string;
  messageIndex: number;
  partIndex?: number;
  role: ActiveFullCompactProviderRole;
  turnId: string;
  runId?: string;
  invocationId?: string;
  contentKind: ActiveFullCompactContentKind;
  body: unknown;
  toolCallId?: string;
  toolName?: string;
  placeholder?: ActiveArchivedToolResultPlaceholder;
  charsPerToken: number;
  runtimeIndex: RuntimeEventIndex;
}): ActiveFullCompactSourceEntry {
  const bodyText = typeof input.body === 'string' ? input.body : stableStringify(input.body);
  const bodySha256 = input.placeholder?.bodySha256 ?? sha256(bodyText);
  const runtimeEvent = matchRuntimeEvent(input.runtimeIndex, {
    bodySha256,
    toolCallId: input.toolCallId,
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
  contentKind: ActiveFullCompactContentKind;
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
}

function buildRuntimeEventIndex(
  events: readonly RuntimeEvent[],
  charsPerToken: number,
): RuntimeEventIndex {
  const byToolCallId = new Map<string, RuntimeEvent[]>();
  const byBodySha256 = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const toolCallId = runtimeToolCallId(event);
    if (toolCallId) pushMap(byToolCallId, toolCallId, event);
    pushMap(byBodySha256, runtimeEventBodySha256(event, charsPerToken), event);
  }
  return { byToolCallId, byBodySha256 };
}

function matchRuntimeEvent(
  index: RuntimeEventIndex,
  input: { bodySha256: string; toolCallId?: string; contentKind: ActiveFullCompactContentKind },
): RuntimeEvent | undefined {
  const toolMatches = input.toolCallId ? (index.byToolCallId.get(input.toolCallId) ?? []) : [];
  const bodyMatches = index.byBodySha256.get(input.bodySha256) ?? [];
  const candidates = [...toolMatches, ...bodyMatches];
  if (candidates.length === 0) return undefined;
  const preferredKind =
    input.contentKind === 'function_call'
      ? 'function_call'
      : input.contentKind === 'tool_result' || input.contentKind === 'active_archive_placeholder'
        ? 'function_response'
        : input.contentKind;
  return (
    candidates.find((event) => event.content?.kind === preferredKind) ??
    bodyMatches[0] ??
    toolMatches[0]
  );
}

function runtimeEventBodySha256(event: RuntimeEvent, charsPerToken: number): string {
  void charsPerToken;
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

function toolPairSplit(
  selectedEntries: readonly ActiveFullCompactSourceEntry[],
  allEntries: readonly ActiveFullCompactSourceEntry[],
): boolean {
  const selectedSourceIds = new Set(selectedEntries.map((entry) => entry.sourceId));
  const toolCallIds = uniqueSorted(
    selectedEntries.map((entry) => entry.toolCallId).filter(nonEmpty),
  );
  for (const toolCallId of toolCallIds) {
    const allKinds = allEntries
      .filter((entry) => entry.toolCallId === toolCallId)
      .map((entry) => entry.contentKind);
    const hasCall = allKinds.includes('function_call');
    const hasResult = allKinds.some(
      (kind) =>
        kind === 'function_response' ||
        kind === 'tool_result' ||
        kind === 'active_archive_placeholder',
    );
    if (!hasCall || !hasResult) continue;
    const selectedKinds = allEntries
      .filter((entry) => entry.toolCallId === toolCallId && selectedSourceIds.has(entry.sourceId))
      .map((entry) => entry.contentKind);
    const selectedHasCall = selectedKinds.includes('function_call');
    const selectedHasResult = selectedKinds.some(
      (kind) =>
        kind === 'function_response' ||
        kind === 'tool_result' ||
        kind === 'active_archive_placeholder',
    );
    if (selectedHasCall !== selectedHasResult) return true;
  }
  return false;
}

function normalizeSummary(summary: ActiveFullCompactSummary): ActiveFullCompactSummary {
  return {
    ...summary,
    schemaVersion: 1,
    text: summary.text,
  };
}

function renderSummarySections(summary: ActiveFullCompactSummary): string[] {
  const lines: string[] = [];
  pushSection(lines, 'process_state', summary.processState);
  pushSection(lines, 'vm_state', summary.vmState);
  pushSection(lines, 'artifact_paths', summary.artifactPaths);
  if (summary.commandsTried && summary.commandsTried.length > 0) {
    lines.push(
      `commands_tried: ${summary.commandsTried
        .map((command) => `${command.command} => ${command.outcome}`)
        .join('; ')}`,
    );
  }
  if (summary.latestVerifierFailure)
    lines.push(`latest_verifier_failure: ${summary.latestVerifierFailure}`);
  pushSection(lines, 'constraints', summary.constraints);
  pushSection(lines, 'failed_hypotheses', summary.failedHypotheses);
  if (summary.currentHypothesis) lines.push(`current_hypothesis: ${summary.currentHypothesis}`);
  pushSection(lines, 'next_actions', summary.nextActions);
  pushSection(lines, 'archive_refs', summary.archiveRefs);
  return lines;
}

function renderArchiveRef(ref: ActiveFullCompactArchiveRef): string {
  return `archive(artifactId=${ref.artifactId})`;
}

function renderProviderVisibleArchiveRefs(refs: readonly ActiveFullCompactArchiveRef[]): string[] {
  const visible = refs.slice(0, MAX_PROVIDER_VISIBLE_ARCHIVE_REFS).map(renderArchiveRef);
  const hiddenCount = refs.length - visible.length;
  return hiddenCount > 0
    ? [...visible, `${hiddenCount} additional archive refs retained off-prompt`]
    : visible;
}

function activeArchiveRefToBoundaryArchiveRef(
  ref: ActiveFullCompactArchiveRef,
): CompactionArchiveRef {
  return {
    kind: ref.kind === 'toolResult' ? 'toolResult' : 'compactSource',
    ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
    ...(ref.turnId ? { turnId: ref.turnId } : {}),
    ...(ref.runtimeEventId ? { runtimeEventId: ref.runtimeEventId } : {}),
    ...(ref.toolCallId ? { toolCallId: ref.toolCallId } : {}),
    ...(ref.toolName ? { toolName: ref.toolName } : {}),
    artifactId: ref.artifactId,
    bodySha256: ref.bodySha256,
    ...(ref.originalEstimatedTokens !== undefined
      ? { originalEstimatedTokens: ref.originalEstimatedTokens }
      : {}),
    ...(ref.originalBytes !== undefined ? { originalBytes: ref.originalBytes } : {}),
  };
}

function skippedSelection(
  decision: 'unchanged' | 'failedOpen',
  reason: ActiveFullCompactSelection extends infer T
    ? T extends { reason: infer R }
      ? R
      : never
    : never,
): ActiveFullCompactSelection {
  return { decision, reason, skippedReasonCounts: { [reason]: 1 } } as ActiveFullCompactSelection;
}

function isTriggerReason(value: unknown): value is ActiveFullCompactBlock['trigger']['reason'] {
  return (
    value === 'high_water' ||
    value === 'force_ratio' ||
    value === 'predictive_growth' ||
    value === 'reactive_prompt_too_long' ||
    value === 'manual_test'
  );
}

function isValidSourceRef(value: unknown): value is ActiveFullCompactSourceRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<ActiveFullCompactSourceRef>;
  return (
    (ref.kind === 'provider_message' ||
      ref.kind === 'runtime_event' ||
      ref.kind === 'active_archive_placeholder') &&
    nonEmpty(ref.sourceId) &&
    Number.isFinite(ref.messageIndex) &&
    nonEmpty(ref.sessionId) &&
    nonEmpty(ref.turnId) &&
    isContentKind(ref.contentKind) &&
    nonEmpty(ref.bodySha256)
  );
}

function isArchiveRef(value: unknown): value is ActiveFullCompactArchiveRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<ActiveFullCompactArchiveRef>;
  return (
    (ref.kind === 'toolResult' || ref.kind === 'compactSource') &&
    nonEmpty(ref.artifactId) &&
    nonEmpty(ref.bodySha256) &&
    optionalNonNegativeFiniteNumber(ref.originalEstimatedTokens) &&
    optionalNonNegativeFiniteNumber(ref.originalBytes)
  );
}

function isContentKind(value: unknown): value is ActiveFullCompactContentKind {
  return (
    value === 'text' ||
    value === 'thinking' ||
    value === 'function_call' ||
    value === 'function_response' ||
    value === 'tool_result' ||
    value === 'active_archive_placeholder' ||
    value === 'unknown'
  );
}

function archiveRefsEqual(
  left: ActiveFullCompactArchiveRef | undefined,
  right: ActiveFullCompactArchiveRef,
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

function uniqueArchiveRefs(
  refs: readonly ActiveFullCompactArchiveRef[],
): ActiveFullCompactArchiveRef[] {
  const seen = new Set<string>();
  const result: ActiveFullCompactArchiveRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.artifactId}:${ref.bodySha256}:${ref.toolCallId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function countReasons(
  reasons: readonly ActiveFullCompactFailOpenReason[],
): Readonly<Record<ActiveFullCompactFailOpenReason, number>> {
  const counts: Partial<Record<ActiveFullCompactFailOpenReason, number>> = {};
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts as Readonly<Record<ActiveFullCompactFailOpenReason, number>>;
}

function providerSourceId(messageIndex: number, partIndex?: number): string {
  return partIndex === undefined
    ? `provider:${messageIndex}`
    : `provider:${messageIndex}:${partIndex}`;
}

function normalizeProviderRole(role: string): ActiveFullCompactProviderRole {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
  return 'user';
}

function stableActiveFullCompactBlockId(value: unknown): string {
  return `afcompact-${sha256(stableStringify(value)).slice(0, 32)}`;
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

function allNonEmpty(values: readonly unknown[]): boolean {
  return values.every(nonEmpty);
}

function optionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
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

function pushSection(lines: string[], label: string, values: readonly string[] | undefined): void {
  if (values && values.length > 0) lines.push(`${label}: ${values.join('; ')}`);
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
