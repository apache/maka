import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import type {
  ArchivedToolResultSourceRef,
  ArchivedToolResultReason,
} from './context-source-ref.js';
import {
  estimateTokens,
  finitePositive,
  increment,
  sha256,
  stableJsonLength,
  turnKey,
  utf8ByteLength,
} from './context-budget-helpers.js';
import {
  buildToolResultArchiveResourceRef,
  TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
} from './tool-result-archive-resource.js';

export interface StaleToolResultPrunePolicy {
  enabled: boolean;
  /** Tool result payloads above this estimate are replaced with archive placeholders. Defaults to 2048. */
  maxResultEstimatedTokens?: number;
  /** Keep this many newest turns' tool results full. Defaults to ContextBudgetPolicy.minRecentTurns, then 1. */
  minRecentTurnsFull?: number;
  /**
   * Archive refs keyed by RuntimeEvent id. Rewrites only happen when a
   * matching ref exists, so archive-write failure keeps original content.
   */
  archiveRefs?: readonly ToolResultArchiveRef[] | Readonly<Record<string, ToolResultArchiveRef>>;
}

export interface ArchiveRetrievalPolicy {
  enabled: boolean;
  /**
   * Defaults to `eager` for Phase 6 compatibility. `history_search_gated`
   * only hydrates placeholders whose turn was selected by history search.
   */
  mode?: ArchiveRetrievalMode;
  maxResults?: number;
  maxEstimatedTokens?: number;
  maxBytes?: number;
  order?: 'newest_first';
}

export type ArchiveRetrievalMode = 'eager' | 'history_search_gated';

export const ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND = 'maka.archived_tool_result';

export const ARCHIVED_TOOL_RESULT_REWRITE_VERSION = 1;

const DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS = 2048;

export interface ArchivedToolResultPlaceholder {
  kind: typeof ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  artifactId: string;
  /** First-class, model-readable resource URI. Optional for persisted v1 compatibility. */
  resourceRef?: string;
  /** Explicit recovery action for the provider-visible placeholder. */
  readInstructions?: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  reason: ArchivedToolResultReason;
}

export interface StaleToolResultArchiveCandidate {
  runtimeEventId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  serializedResult: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  reason: ArchivedToolResultReason;
}

export interface ToolResultArchiveRef {
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  reason: ArchivedToolResultReason;
}

export type ToolResultArchiveReadFailureReason =
  | 'not_found'
  | 'deleted'
  | 'too_large'
  | 'not_allowed'
  | 'read_failed'
  | 'source_mismatch'
  | 'session_mismatch'
  | 'size_mismatch'
  | 'corrupt';

export interface ToolResultArchiveReaderInput extends ArchivedToolResultPlaceholder {
  sessionId: string;
  maxBytes?: number;
}

export type ToolResultArchiveReadResult =
  | { ok: true; serializedResult: string }
  | { ok: false; reason: ToolResultArchiveReadFailureReason };

export type ToolResultArchiveReader = (
  input: ToolResultArchiveReaderInput,
) => Promise<ToolResultArchiveReadResult> | ToolResultArchiveReadResult;

export interface ArchiveRetrievalResult {
  events: RuntimeEvent[];
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
  retrievedSourceRefs?: ArchivedToolResultSourceRef[];
}

export async function retrieveArchivedToolResultsForReplay(
  events: readonly RuntimeEvent[],
  policy: ArchiveRetrievalPolicy | undefined,
  reader: ToolResultArchiveReader | undefined,
  options: {
    sessionId: string;
    charsPerToken?: number;
    allowedTurnIds?: ReadonlySet<string> | readonly string[];
  },
): Promise<ArchiveRetrievalResult> {
  if (policy?.enabled !== true || !reader) {
    return { events: [...events], diagnosticPatch: {} };
  }

  const charsPerToken = options.charsPerToken ?? 4;
  const mode = policy.mode ?? 'eager';
  const allowedTurnIds = normalizeAllowedTurnIds(options.allowedTurnIds);
  const maxResults = finitePositive(policy.maxResults) ?? 3;
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 8_192;
  const maxBytes = finitePositive(policy.maxBytes) ?? 1024 * 1024;
  const candidates = collectArchiveRetrievalCandidates(events, policy.order ?? 'newest_first');

  let retrieved = 0;
  let retrievedTokens = 0;
  let skipped = 0;
  let failures = 0;
  const skippedReasonCounts: Record<string, number> = {};
  const failureReasonCounts: Record<string, number> = {};
  const replacements = new Map<string, unknown>();
  const retrievedSourceRefs: ArchivedToolResultSourceRef[] = [];

  for (const candidate of candidates) {
    if (retrieved >= maxResults) break;
    if (mode === 'history_search_gated' && !allowedTurnIds.has(turnKey(candidate.event))) {
      skipped += 1;
      increment(skippedReasonCounts, 'history_search_gate');
      continue;
    }
    if (candidate.placeholder.originalBytes > maxBytes) {
      skipped += 1;
      increment(skippedReasonCounts, 'max_bytes');
      continue;
    }
    if (candidate.placeholder.originalEstimatedTokens > maxEstimatedTokens) {
      skipped += 1;
      increment(skippedReasonCounts, 'max_candidate_tokens');
      continue;
    }
    if (retrievedTokens + candidate.placeholder.originalEstimatedTokens > maxEstimatedTokens) {
      skipped += 1;
      increment(skippedReasonCounts, 'max_total_tokens');
      continue;
    }

    const readResult = await Promise.resolve(
      reader({
        ...candidate.placeholder,
        sessionId: options.sessionId,
        maxBytes,
      }),
    ).catch((): ToolResultArchiveReadResult => ({ ok: false, reason: 'read_failed' }));
    if (!readResult.ok) {
      failures += 1;
      increment(failureReasonCounts, readResult.reason);
      continue;
    }
    const actualHash = sha256(readResult.serializedResult);
    if (actualHash !== candidate.placeholder.bodySha256) {
      failures += 1;
      increment(failureReasonCounts, 'corrupt');
      continue;
    }

    replacements.set(candidate.event.id, deserializeToolResultArchive(readResult.serializedResult));
    retrievedSourceRefs.push({
      kind: 'archived_tool_result',
      sessionId: options.sessionId,
      turnId: turnKey(candidate.event),
      runtimeEventId: candidate.event.id,
      toolCallId: candidate.placeholder.toolCallId,
      toolName: candidate.placeholder.toolName,
      artifactId: candidate.placeholder.artifactId,
      bodySha256: candidate.placeholder.bodySha256,
      originalEstimatedTokens: candidate.placeholder.originalEstimatedTokens,
      originalBytes: candidate.placeholder.originalBytes,
      placeholderReason: candidate.placeholder.reason,
    });
    retrieved += 1;
    retrievedTokens += candidate.placeholder.originalEstimatedTokens;
  }

  const hydratedEvents = events.map((event) => {
    const replacement = replacements.get(event.id);
    if (!replacements.has(event.id) || event.content?.kind !== 'function_response') return event;
    return {
      ...event,
      content: {
        ...event.content,
        result: replacement,
      },
    };
  });

  return {
    events: hydratedEvents,
    ...(retrievedSourceRefs.length > 0 ? { retrievedSourceRefs } : {}),
    diagnosticPatch: {
      archiveRetrievalMode: mode,
      ...(mode === 'history_search_gated'
        ? { archiveRetrievalEligibleTurns: allowedTurnIds.size }
        : {}),
      retrievedArchiveToolResults: retrieved,
      retrievedArchiveEstimatedTokens: retrievedTokens,
      archiveRetrievalSkipped: skipped,
      archiveRetrievalFailures: failures,
      ...(Object.keys(skippedReasonCounts).length > 0
        ? { archiveRetrievalSkippedReasonCounts: skippedReasonCounts }
        : {}),
      ...(Object.keys(failureReasonCounts).length > 0
        ? { archiveRetrievalFailureReasonCounts: failureReasonCounts }
        : {}),
    },
  };
}

export function deserializeToolResultArchive(serialized: string): unknown {
  if (serialized === 'undefined') return undefined;
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

export function pruneStaleToolResultsBeforeCompact(
  events: readonly RuntimeEvent[],
  prunePolicy: StaleToolResultPrunePolicy | undefined,
  charsPerToken: number,
  minRecentTurns: number | undefined,
): {
  events: RuntimeEvent[];
  prunedToolResults: number;
  archiveWriteFailures: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
} {
  if (prunePolicy?.enabled !== true) {
    return {
      events: [...events],
      prunedToolResults: 0,
      archiveWriteFailures: 0,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
    };
  }

  const maxResultEstimatedTokens =
    finitePositive(prunePolicy.maxResultEstimatedTokens) ??
    DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS;
  const minRecentTurnsFull = Math.max(
    0,
    Math.floor(prunePolicy.minRecentTurnsFull ?? minRecentTurns ?? 1),
  );
  const protectedTurnIds = recentTurnIds(events, minRecentTurnsFull);
  const archiveRefs = normalizeArchiveRefs(prunePolicy.archiveRefs);

  let prunedToolResults = 0;
  let archiveWriteFailures = 0;
  let estimatedTokensBefore = 0;
  let estimatedTokensAfter = 0;
  const prunedEvents = events.map((event) => {
    const content = event.content;
    if (
      event.partial ||
      content?.kind !== 'function_response' ||
      protectedTurnIds.has(turnKey(event))
    ) {
      return event;
    }

    if (isArchivedToolResultPlaceholder(content.result)) return event;

    const serializedResult = serializeToolResultForArchive(content.result);
    const resultBytes = utf8ByteLength(serializedResult);
    const resultEstimatedTokens = estimateTokens(serializedResult.length, charsPerToken);
    if (resultEstimatedTokens <= maxResultEstimatedTokens) return event;

    const archiveRef = archiveRefs.get(event.id);
    if (
      !archiveRef ||
      !archiveRefMatches(archiveRef, {
        runtimeEventId: event.id,
        toolCallId: content.id,
        toolName: content.name,
        bodySha256: sha256(serializedResult),
        originalBytes: resultBytes,
        originalEstimatedTokens: resultEstimatedTokens,
      })
    ) {
      archiveWriteFailures += 1;
      return event;
    }

    const placeholder: ArchivedToolResultPlaceholder = {
      kind: ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      artifactId: archiveRef.artifactId,
      resourceRef: buildToolResultArchiveResourceRef({
        artifactId: archiveRef.artifactId,
        bodySha256: archiveRef.bodySha256,
        originalBytes: resultBytes,
      }),
      readInstructions: TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
      runtimeEventId: event.id,
      toolCallId: content.id,
      toolName: content.name,
      bodySha256: archiveRef.bodySha256,
      originalEstimatedTokens: resultEstimatedTokens,
      originalBytes: resultBytes,
      reason: 'stale_tool_result_pruned_before_compact',
    };
    const placeholderEstimatedTokens = estimateTokens(stableJsonLength(placeholder), charsPerToken);
    prunedToolResults += 1;
    estimatedTokensBefore += resultEstimatedTokens;
    estimatedTokensAfter += placeholderEstimatedTokens;
    return {
      ...event,
      content: {
        ...content,
        result: placeholder,
      },
    };
  });

  return {
    events: prunedEvents,
    prunedToolResults,
    archiveWriteFailures,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}

export function collectStaleToolResultArchiveCandidates(
  events: readonly RuntimeEvent[],
  prunePolicy: StaleToolResultPrunePolicy | undefined,
  charsPerToken: number,
  minRecentTurns: number | undefined,
): StaleToolResultArchiveCandidate[] {
  if (prunePolicy?.enabled !== true) return [];
  const maxResultEstimatedTokens =
    finitePositive(prunePolicy.maxResultEstimatedTokens) ??
    DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS;
  const minRecentTurnsFull = Math.max(
    0,
    Math.floor(prunePolicy.minRecentTurnsFull ?? minRecentTurns ?? 1),
  );
  const protectedTurnIds = recentTurnIds(events, minRecentTurnsFull);
  const candidates: StaleToolResultArchiveCandidate[] = [];
  for (const event of events) {
    const content = event.content;
    if (
      event.partial ||
      content?.kind !== 'function_response' ||
      protectedTurnIds.has(turnKey(event)) ||
      isArchivedToolResultPlaceholder(content.result)
    ) {
      continue;
    }
    const serializedResult = serializeToolResultForArchive(content.result);
    const originalBytes = utf8ByteLength(serializedResult);
    const originalEstimatedTokens = estimateTokens(serializedResult.length, charsPerToken);
    if (originalEstimatedTokens <= maxResultEstimatedTokens) continue;
    candidates.push({
      runtimeEventId: event.id,
      turnId: event.turnId,
      toolCallId: content.id,
      toolName: content.name,
      result: content.result,
      serializedResult,
      originalEstimatedTokens,
      originalBytes,
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      reason: 'stale_tool_result_pruned_before_compact',
    });
  }
  return candidates;
}

export function serializeToolResultForArchive(result: unknown): string {
  if (result === undefined) return 'undefined';
  try {
    return JSON.stringify(result) ?? 'null';
  } catch {
    return String(result);
  }
}

export function isArchivedToolResultPlaceholder(
  value: unknown,
): value is ArchivedToolResultPlaceholder {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ArchivedToolResultPlaceholder>;
  return (
    candidate.kind === ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND &&
    candidate.rewriteVersion === ARCHIVED_TOOL_RESULT_REWRITE_VERSION &&
    typeof candidate.artifactId === 'string' &&
    candidate.artifactId.length > 0 &&
    typeof candidate.runtimeEventId === 'string' &&
    candidate.runtimeEventId.length > 0 &&
    typeof candidate.toolCallId === 'string' &&
    candidate.toolCallId.length > 0 &&
    typeof candidate.toolName === 'string' &&
    candidate.toolName.length > 0 &&
    typeof candidate.bodySha256 === 'string' &&
    candidate.bodySha256.length > 0 &&
    typeof candidate.originalEstimatedTokens === 'number' &&
    Number.isFinite(candidate.originalEstimatedTokens) &&
    candidate.originalEstimatedTokens > 0 &&
    typeof candidate.originalBytes === 'number' &&
    Number.isFinite(candidate.originalBytes) &&
    candidate.originalBytes > 0 &&
    candidate.reason === 'stale_tool_result_pruned_before_compact'
  );
}

function normalizeArchiveRefs(
  refs: StaleToolResultPrunePolicy['archiveRefs'],
): Map<string, ToolResultArchiveRef> {
  const map = new Map<string, ToolResultArchiveRef>();
  if (!refs) return map;
  if (Array.isArray(refs)) {
    for (const ref of refs) map.set(ref.runtimeEventId, ref);
    return map;
  }
  for (const [runtimeEventId, ref] of Object.entries(refs)) {
    map.set(runtimeEventId, ref);
  }
  return map;
}

function archiveRefMatches(
  ref: ToolResultArchiveRef,
  candidate: {
    runtimeEventId: string;
    toolCallId: string;
    toolName: string;
    bodySha256: string;
    originalEstimatedTokens: number;
    originalBytes: number;
  },
): boolean {
  return (
    ref.runtimeEventId === candidate.runtimeEventId &&
    ref.toolCallId === candidate.toolCallId &&
    ref.toolName === candidate.toolName &&
    ref.rewriteVersion === ARCHIVED_TOOL_RESULT_REWRITE_VERSION &&
    ref.reason === 'stale_tool_result_pruned_before_compact' &&
    typeof ref.artifactId === 'string' &&
    ref.artifactId.length > 0 &&
    typeof ref.bodySha256 === 'string' &&
    ref.bodySha256.length > 0 &&
    ref.bodySha256 === candidate.bodySha256 &&
    ref.originalEstimatedTokens === candidate.originalEstimatedTokens &&
    ref.originalBytes === candidate.originalBytes
  );
}

function recentTurnIds(events: readonly RuntimeEvent[], count: number): Set<string> {
  if (count <= 0) return new Set();
  const order: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const key = turnKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return new Set(order.slice(Math.max(0, order.length - count)));
}

function collectArchiveRetrievalCandidates(
  events: readonly RuntimeEvent[],
  order: NonNullable<ArchiveRetrievalPolicy['order']>,
): Array<{
  event: RuntimeEvent;
  placeholder: ArchivedToolResultPlaceholder;
}> {
  const candidates: Array<{ event: RuntimeEvent; placeholder: ArchivedToolResultPlaceholder }> = [];
  for (const event of events) {
    if (event.content?.kind !== 'function_response') continue;
    if (!isArchivedToolResultPlaceholder(event.content.result)) continue;
    candidates.push({ event, placeholder: event.content.result });
  }
  return order === 'newest_first' ? candidates.reverse() : candidates;
}

function normalizeAllowedTurnIds(
  turnIds: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  if (!turnIds) return new Set();
  if (turnIds instanceof Set) return turnIds;
  return new Set(turnIds);
}
