import type { ModelMessage } from './model-protocol.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import {
  activeFullCompactCoverageFromEntries,
  activeCompactionMessageSignature,
  buildActiveCompactionHeadAnchor,
  buildActiveFullCompactBlockFromSummary,
  buildActiveFullCompactSourceIndex,
  selectActiveCompactionSafeSpan,
  validateActiveFullCompactBlockForSourceIndex,
  type ActiveFullCompactArchiveRef,
  type ActiveFullCompactCoverage,
  type ActiveFullCompactPolicy,
  type ActiveFullCompactSourceEntry,
  type ActiveFullCompactSourceIndex,
  type ActiveFullCompactSourceRef,
  type ActiveFullCompactValidationResult,
  type ActiveCompactionHeadAnchor,
} from './active-full-compact.js';
import {
  compactionDecisionDiagnosticPatch,
  type CompactionBoundary,
} from './compaction-boundary.js';
import { estimateTokens } from './context-budget-helpers.js';
import type { CompactSummaryResult, NormalizedAiSdkUsage } from './model-adapter.js';
import { stableHash, stableStringify } from './request-shape.js';

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_SUMMARY_TOKENS = 768;
const DEFAULT_MIN_SAFE_PREFIX_TOKENS = 4096;
const DEFAULT_MIN_NEW_PREFIX_TOKENS = 4096;
const DEFAULT_MAX_COMPACT_CALL_TOKENS = 4096;
const FALLBACK_RAW_SUMMARY_MAX_CHARS = 12_000;
const DEFAULT_MIN_SAVINGS_TOKENS = 256;
const DEFAULT_MIN_SAVINGS_RATIO = 0.05;
const DEFAULT_COMPACT_CALL_TOKEN_COST_WEIGHT = 1;
const DEFAULT_MAX_CONSECUTIVE_INVALID_SUMMARIES = 2;
const DEFAULT_INVALID_SUMMARY_COOLDOWN_STEPS = 8;
const PRIVATE_VERIFIER_PATTERN =
  /\b(hidden|private|official)\s+(verifier|evaluation|eval|test|assertion|oracle)\b/i;
const SUMMARY_FIELD_LABELS = {
  actionInProgress: ['action_in_progress', 'action in progress'],
} as const;

export interface SemanticCompactPolicy {
  enabled: boolean;
  mode?: 'off' | 'validate_only' | 'prepare_step_dry_run' | 'replace';
  minStepNumber?: number;
  highWaterRatio?: number;
  forceRatio?: number;
  targetRatio?: number;
  maxActiveEstimatedTokens?: number;
  minRecentMessages?: number;
  minRecentToolPairs?: number;
  maxSummaryEstimatedTokens?: number;
  /** Minimum completed active-turn span after the exact user anchor. Defaults to 4096. */
  minSafePrefixEstimatedTokens?: number;
  /** Minimum newly completed raw span required for a successor projection. Defaults to 4096. */
  minNewPrefixEstimatedTokens?: number;
  /** Hard provider-visible budget for the complete rendered projection block. Defaults to 768. */
  maxAcceptedProjectionEstimatedTokens?: number;
  minSavingsTokens?: number;
  minSavingsRatio?: number;
  minNetSavingsTokens?: number;
  compactCallTokenCostWeight?: number;
  maxCompactCallTokens?: number;
  maxConsecutiveInvalidSummaries?: number;
  invalidSummaryCooldownSteps?: number;
  summarizerModel?: string;
  timeoutMs?: number;
  archiveRequired?: boolean;
  promptVersion?: string;
  highWaterName?: string;
}

export interface SemanticCompactSummaryRequest {
  system: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}

export type SemanticCompactSummarizer = (
  request: SemanticCompactSummaryRequest,
) => Promise<CompactSummaryResult> | CompactSummaryResult;

export interface SemanticCompactControllerState {
  consecutiveInvalidSummaries: number;
  totalInvalidSummaries: number;
  compactCallCount: number;
  compactCallTotalTokens: number;
  acceptedEstimatedTokensSaved: number;
  suppressedUntilStep?: number;
  lastInvalidReason?: string;
}

export interface SemanticCompactStateCard {
  /** @deprecated V1/V2 read compatibility only. New semantic blocks never generate or render state cards. */
  kind:
    | 'process'
    | 'vm'
    | 'artifact'
    | 'command'
    | 'constraint'
    | 'verifier'
    | 'next_action'
    | 'generic';
  text: string;
  sourceIds: string[];
}

export interface SemanticCompactStructuredSummary {
  establishedFindings: string[];
  decisions: string[];
  failedPaths: string[];
  partialWorkProduct: string[];
  actionInProgress: string;
}

export interface SemanticCompactBlock {
  kind: 'maka.semantic_compact_block';
  /** V1 remains readable because all V2 lineage fields are additive. New blocks are always V2. */
  version: 1 | 2;
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
  sourceRefs: ActiveFullCompactSourceRef[];
  archiveRefs?: ActiveFullCompactArchiveRef[];
  preservedTail: {
    messageIndexes: number[];
    toolCallIds: string[];
    sourceIds: string[];
  };
  headAnchor?: {
    messageIndex: number;
    messageSignature: string;
    bodySha256: string;
    estimatedTokens: number;
    sourceIds: string[];
  };
  predecessorBlockId?: string;
  newCoverage?: ActiveFullCompactCoverage;
  cumulativeCoverageDigest?: string;
  projection?: {
    format: 'structured' | 'bounded_text_fallback';
    generationBudgetTokens: number;
    acceptedBudgetTokens: number;
    estimatedTokens: number;
  };
  summary: {
    promptVersion: string;
    text: string;
    limitations?: string[];
    nextAction?: string;
  };
  /** @deprecated Read compatibility only. Runtime heuristics must not enter an LLM semantic projection. */
  stateCards?: SemanticCompactStateCard[];
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  preActiveContextEstimatedTokens: number;
  postReplacementEstimatedTokens: number;
  estimatedTokensSavedSigned: number;
  estimatedNetTokensSavedSigned?: number;
  compactCallUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
  providerRequestId?: string;
  acceptance: {
    decision: 'accepted' | 'rejected' | 'dry_run';
    reason?: string;
    validationReasons?: string[];
  };
}

export type SemanticCompactDecision = 'unchanged' | 'replaced' | 'failedOpen';

export interface SemanticCompactRewriteInput {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  messages: readonly ModelMessage[];
  policy: SemanticCompactPolicy | undefined;
  runtimeEvents?: readonly RuntimeEvent[];
  stepNumber: number;
  controllerState?: SemanticCompactControllerState;
  now?: number;
  charsPerToken?: number;
  requestShapeHashBefore?: string;
  requestShapeHashForMessages?: (messages: readonly ModelMessage[]) => string;
  /** Captured from the exact current-turn user message before the first provider step. */
  headAnchor?: ActiveCompactionHeadAnchor;
  predecessorBlock?: SemanticCompactBlock;
  summarizer: SemanticCompactSummarizer;
  abortSignal?: AbortSignal;
}

export interface SemanticCompactRewriteResult {
  messages: ModelMessage[];
  decision: SemanticCompactDecision;
  reason?: string;
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
  block?: SemanticCompactBlock;
  validation?: ActiveFullCompactValidationResult;
}

export async function rewriteSemanticCompactInMessages(
  input: SemanticCompactRewriteInput,
): Promise<SemanticCompactRewriteResult> {
  const messages = [...input.messages];
  const policy = input.policy;
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  if (policy?.enabled !== true || policy.mode === 'off') {
    return unchanged(messages, 'disabled');
  }
  const brakeReason = semanticCompactBrakeReason(policy, input.controllerState, input.stepNumber);
  if (brakeReason) {
    return unchanged(messages, brakeReason);
  }

  const index = buildActiveFullCompactSourceIndex({
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    messages,
    runtimeEvents: input.runtimeEvents,
    stepNumber: input.stepNumber,
    charsPerToken,
  });
  const headAnchor = resolveSemanticHeadAnchor(messages, input.headAnchor, charsPerToken);
  if (!headAnchor) {
    return {
      messages,
      decision: 'failedOpen',
      reason: 'head_anchor_mismatch',
      diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
        decision: 'failedOpen',
        failOpenReason: 'head_anchor_mismatch',
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: index.estimatedTokens,
      }),
    };
  }
  const predecessorMessageIndex = findSemanticProjectionMessageIndex(
    messages,
    headAnchor.messageIndex,
  );
  if (input.predecessorBlock && predecessorMessageIndex === undefined) {
    return rejected(messages, index, 'predecessor_projection_missing');
  }
  const selectionPolicy = policyForSemanticSelection(policy, Boolean(input.predecessorBlock));
  const selection = selectActiveCompactionSafeSpan({
    index,
    messages,
    policy: selectionPolicy,
    headAnchor,
    ...(predecessorMessageIndex !== undefined
      ? { afterMessageIndex: predecessorMessageIndex }
      : {}),
  });
  if (selection.decision !== 'selected') {
    const decision = selection.decision === 'failedOpen' ? 'failedOpen' : 'unchanged';
    return {
      messages,
      decision,
      reason: selection.reason,
      diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
        decision,
        reason: selection.reason,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: index.estimatedTokens,
        skippedReasonCounts: selection.skippedReasonCounts,
      }),
    };
  }

  const validationBlock = buildActiveFullCompactBlockFromSummary({
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    entries: selection.entries,
    summary: {
      schemaVersion: 1,
      text: 'Semantic compact source validation block.',
      nextActions: ['Continue from semantic compact summary and preserved recent tail.'],
    },
    highWaterName: policy.highWaterName ?? 'semantic-compact-high-water',
    highWaterSeq: input.stepNumber,
    trigger: {
      reason: 'high_water',
      stepNumber: input.stepNumber,
      estimatedTokensBefore: index.estimatedTokens,
      ...(policy.maxActiveEstimatedTokens !== undefined
        ? {
            thresholdTokens: Math.floor(
              policy.maxActiveEstimatedTokens * finiteRatio(policy.highWaterRatio, 0.8),
            ),
          }
        : {}),
    },
    now: input.now,
    charsPerToken,
    requestShapeHashBefore:
      input.requestShapeHashBefore ?? input.requestShapeHashForMessages?.(messages),
    preActiveContextEstimatedTokens: index.estimatedTokens,
  });
  const validation = validateActiveFullCompactBlockForSourceIndex(validationBlock, index, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    archiveRequired: policy.archiveRequired,
    charsPerToken,
  });
  if (!validation.valid) {
    return {
      messages,
      decision: 'failedOpen',
      reason: validation.reasons[0] ?? 'source_validation_failed',
      validation,
      diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
        decision: 'failedOpen',
        failOpenReason: validation.reasons[0] ?? 'source_validation_failed',
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: index.estimatedTokens,
        validationReasonCounts: validation.reasonCounts,
      }),
    };
  }
  const warningReasons: string[] = [];
  if (policy.minRecentMessages !== undefined || policy.minRecentToolPairs !== undefined) {
    warningReasons.push('deprecated_semantic_recency_policy_ignored');
  }

  let summary: CompactSummaryResult;
  try {
    summary = await callSummarizerWithTimeout(
      input.summarizer,
      {
        system: semanticCompactSystemPrompt(policy),
        messages: buildSummarizerMessages({
          selection,
          messages,
          index,
          headAnchor,
          ...(predecessorMessageIndex !== undefined ? { predecessorMessageIndex } : {}),
          ...(input.predecessorBlock ? { predecessorBlock: input.predecessorBlock } : {}),
          policy,
          charsPerToken,
        }),
        maxOutputTokens: Math.floor(policy.maxCompactCallTokens ?? DEFAULT_MAX_COMPACT_CALL_TOKENS),
        abortSignal: input.abortSignal,
      },
      policy.timeoutMs,
    );
  } catch {
    recordInvalidSummary(input.controllerState, policy, 'summarizer_failed', input.stepNumber);
    return rejected(messages, index, 'summarizer_failed');
  }

  const compactCallUsage = summary.usage ? compactUsage(summary.usage) : undefined;
  recordCompactCall(input.controllerState, compactCallUsage);
  if (!summary.text.trim()) {
    recordInvalidSummary(input.controllerState, policy, 'summary_missing', input.stepNumber);
    return rejected(messages, index, 'summary_missing', compactCallUsage);
  }
  if (isTruncatedFinishReason(summary.finishReason)) {
    recordInvalidSummary(input.controllerState, policy, 'summary_truncated', input.stepNumber);
    return rejected(messages, index, 'summary_truncated', compactCallUsage);
  }
  const parsedSummary = parseSemanticCompactSummary(summary.text);
  if (!parsedSummary.ok) warningReasons.push(parsedSummary.reason);
  recordValidSummary(input.controllerState);
  const structuredSummary = parsedSummary.ok
    ? parsedSummary.summary
    : fallbackSemanticCompactSummary(
        summary.text,
        parsedSummary.reason,
        Math.max(
          80,
          Math.floor(
            ((policy.maxAcceptedProjectionEstimatedTokens ??
              policy.maxSummaryEstimatedTokens ??
              DEFAULT_MAX_SUMMARY_TOKENS) *
              charsPerToken) /
              2,
          ),
        ),
      );
  if (!structuredSummary) {
    recordInvalidSummary(
      input.controllerState,
      policy,
      'fallback_projection_empty',
      input.stepNumber,
    );
    return rejected(messages, index, 'fallback_projection_empty', compactCallUsage);
  }
  const summaryText = renderStructuredSemanticSummary(structuredSummary);
  if (
    newPrivateVerifierSurface(
      `${summary.text}\n${summaryText}`,
      selectedSourceText(
        { startMessageIndex: headAnchor.messageIndex, endMessageIndex: selection.endMessageIndex },
        messages,
      ),
    )
  ) {
    recordInvalidSummary(
      input.controllerState,
      policy,
      'private_verifier_surface',
      input.stepNumber,
    );
    return rejected(messages, index, 'private_verifier_surface', compactCallUsage);
  }

  const requestShapeHashBefore =
    input.requestShapeHashBefore ?? input.requestShapeHashForMessages?.(messages);
  const block = buildSemanticCompactBlock({
    input,
    index,
    selection,
    headAnchor,
    predecessorBlock: input.predecessorBlock,
    structuredSummary,
    summaryText,
    usage: summary.usage,
    finishReason: summary.finishReason,
    providerRequestId: summary.providerRequestId,
    requestShapeHashBefore,
    charsPerToken,
    projectionFormat: parsedSummary.ok ? 'structured' : 'bounded_text_fallback',
  });
  if (
    !fitSemanticCompactBlockToAcceptedBudget(
      block,
      structuredSummary,
      policy.maxAcceptedProjectionEstimatedTokens ??
        policy.maxSummaryEstimatedTokens ??
        DEFAULT_MAX_SUMMARY_TOKENS,
      charsPerToken,
    )
  ) {
    recordInvalidSummary(
      input.controllerState,
      policy,
      'projection_budget_exceeded',
      input.stepNumber,
    );
    return rejected(messages, index, 'projection_budget_exceeded', compactCallUsage);
  }
  const replacementMessage = semanticCompactBlockToModelMessage(block);
  const replacementStartMessageIndex = predecessorMessageIndex ?? selection.startMessageIndex;
  const predecessorEstimatedTokens =
    predecessorMessageIndex === undefined
      ? 0
      : index.entries
          .filter((entry) => entry.messageIndex === predecessorMessageIndex)
          .reduce((total, entry) => total + entry.estimatedTokens, 0);
  const replacementMessages = [
    ...messages.slice(0, replacementStartMessageIndex),
    replacementMessage,
    ...messages.slice(selection.endMessageIndex + 1),
  ];
  const requestShapeHashAfter = input.requestShapeHashForMessages?.(replacementMessages);
  if (requestShapeHashAfter) block.requestShapeHashAfter = requestShapeHashAfter;
  block.postReplacementEstimatedTokens = estimatePostReplacementTokens(
    index,
    selection.estimatedTokens + predecessorEstimatedTokens,
    renderSemanticCompactBlock(block),
    charsPerToken,
  );
  block.estimatedTokensSavedSigned = index.estimatedTokens - block.postReplacementEstimatedTokens;
  block.estimatedNetTokensSavedSigned = estimateSemanticNetTokensSaved(block, policy);

  const economicsReason = semanticSavingsRejectionReason(block, policy);
  if (economicsReason) warningReasons.push(economicsReason);
  const uniqueWarningReasons = uniqueStrings(warningReasons);
  const warningReasonCounts = countStringReasons(uniqueWarningReasons);
  const primaryWarningReason = uniqueWarningReasons[0];
  const preservedTailEstimatedTokens = index.entries
    .filter((entry) => entry.messageIndex > selection.endMessageIndex)
    .reduce((total, entry) => total + entry.estimatedTokens, 0);

  if (policy.mode === 'validate_only' || policy.mode === 'prepare_step_dry_run') {
    block.acceptance = { decision: 'dry_run', reason: policy.mode };
    return {
      messages,
      decision: 'unchanged',
      reason: policy.mode,
      block,
      validation,
      diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
        decision: 'unchanged',
        boundaryIds: [block.blockId],
        coverage: block.coverage,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: block.postReplacementEstimatedTokens,
        estimatedTokensSaved: block.estimatedTokensSavedSigned,
        candidateEstimatedTokens: selection.estimatedTokens,
        preservedHeadEstimatedTokens: headAnchor.estimatedTokens,
        preservedTailEstimatedTokens,
        acceptedProjectionEstimatedTokens: block.projection?.estimatedTokens,
        compactCallUsage: block.compactCallUsage,
        reason: policy.mode,
        ...(primaryWarningReason ? { skippedReasonCounts: warningReasonCounts } : {}),
        validationReasonCounts: validation.reasonCounts,
      }),
    };
  }

  block.acceptance = primaryWarningReason
    ? {
        decision: 'accepted',
        reason: primaryWarningReason,
        validationReasons: uniqueWarningReasons,
      }
    : { decision: 'accepted' };
  recordAcceptedSemanticCompact(input.controllerState, block);
  return {
    messages: replacementMessages,
    decision: 'replaced',
    ...(primaryWarningReason ? { reason: primaryWarningReason } : {}),
    block,
    validation,
    diagnosticPatch: {
      ...semanticCompactDecisionDiagnosticPatch({
        decision: 'replaced',
        boundaryIds: [block.blockId],
        coverage: block.coverage,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: block.postReplacementEstimatedTokens,
        estimatedTokensSaved: block.estimatedTokensSavedSigned,
        candidateEstimatedTokens: selection.estimatedTokens,
        preservedHeadEstimatedTokens: headAnchor.estimatedTokens,
        preservedTailEstimatedTokens,
        acceptedProjectionEstimatedTokens: block.projection?.estimatedTokens,
        compactCallUsage: block.compactCallUsage,
        ...(primaryWarningReason
          ? { reason: primaryWarningReason, skippedReasonCounts: warningReasonCounts }
          : {}),
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

export function semanticCompactBlockToModelMessage(block: SemanticCompactBlock): ModelMessage {
  return {
    // The projection is authored by the same LLM from its completed execution
    // history.  Rendering it as another user instruction leaves the exact head
    // anchor followed by two consecutive user messages; live OpenAI-compatible
    // providers can then treat the replacement as a fresh task and restart
    // discovery.  Keep the user's instruction immutable and render the rolling
    // projection as the assistant's own continuation checkpoint instead.
    role: 'assistant',
    content: renderSemanticCompactBlock(block),
  } as ModelMessage;
}

export function semanticCompactBlockToCompactionBoundary(
  block: SemanticCompactBlock,
): CompactionBoundary {
  return {
    kind: 'semanticCompact',
    stage: 'activeStep',
    schemaVersion: block.version,
    boundaryId: block.blockId,
    ...(block.predecessorBlockId ? { predecessorBoundaryId: block.predecessorBlockId } : {}),
    ...(block.cumulativeCoverageDigest
      ? { cumulativeCoverageDigest: block.cumulativeCoverageDigest }
      : {}),
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
      providerMessageSourceIds: block.coverage.providerMessageSourceIds,
    },
    preservedAnchor: {
      ...(block.headAnchor?.sourceIds.length
        ? { headProviderMessageSourceIds: block.headAnchor.sourceIds }
        : {}),
      tailProviderMessageSourceIds: block.preservedTail.sourceIds,
    },
    sourceHashes: block.coverage.bodySha256,
    renderedText: renderSemanticCompactBlock(block),
    estimatedTokens: block.projection?.estimatedTokens,
    validationStatus: block.acceptance.decision === 'rejected' ? 'invalid' : 'valid',
    ...(block.acceptance.reason ? { validationReason: block.acceptance.reason } : {}),
  };
}

export function renderSemanticCompactBlock(block: SemanticCompactBlock): string {
  return [
    `<maka_semantic_compact_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}" version="${block.version}">`,
    'continuation_contract: This is my LLM-authored continuation delta for completed work. Continue the same task from the exact user anchor, treat the findings below as established unless new evidence contradicts them, and resume action_in_progress instead of restarting task discovery. The newest completed execution episode and any open protocol tail follow this block verbatim.',
    'summary:',
    block.summary.text,
    '</maka_semantic_compact_block>',
  ].join('\n');
}

function policyForSemanticSelection(
  policy: SemanticCompactPolicy,
  successor: boolean,
): ActiveFullCompactPolicy & {
  minSafePrefixEstimatedTokens: number;
  preserveRecentCompletedEpisodes: number;
} {
  return {
    enabled: true,
    minStepNumber: policy.minStepNumber,
    highWaterRatio: policy.highWaterRatio,
    maxActiveEstimatedTokens: policy.maxActiveEstimatedTokens,
    minSafePrefixEstimatedTokens: successor
      ? (policy.minNewPrefixEstimatedTokens ?? DEFAULT_MIN_NEW_PREFIX_TOKENS)
      : (policy.minSafePrefixEstimatedTokens ?? DEFAULT_MIN_SAFE_PREFIX_TOKENS),
    // Attention compaction must not collapse the request to only an anchor and
    // a state-like projection. Keep the latest completed provider episode
    // verbatim so the next inference retains immediate execution momentum.
    preserveRecentCompletedEpisodes: 1,
    maxSummaryEstimatedTokens: policy.maxSummaryEstimatedTokens,
    archiveRequired: policy.archiveRequired,
    highWaterName: policy.highWaterName,
  };
}

function buildSummarizerMessages(input: {
  selection: Extract<ReturnType<typeof selectActiveCompactionSafeSpan>, { decision: 'selected' }>;
  messages: readonly ModelMessage[];
  index: ActiveFullCompactSourceIndex;
  headAnchor: ActiveCompactionHeadAnchor;
  predecessorMessageIndex?: number;
  predecessorBlock?: SemanticCompactBlock;
  policy: SemanticCompactPolicy;
  charsPerToken: number;
}): ModelMessage[] {
  const contextBoundary = {
    coveredProviderSourceEntries: input.selection.coverage.providerMessageSourceIds.length,
    coveredToolCalls: input.selection.coverage.toolCallIds.length,
    contentKinds: input.selection.coverage.contentKinds,
    durableArchiveRefCount: input.selection.entries.filter((entry) => entry.archiveRef).length,
  };
  const schema = {
    established_findings: ['strings, facts established by completed work'],
    decisions: ['strings, decisions made during completed work'],
    failed_paths: ['strings, attempted paths that failed and why'],
    partial_work_product: ['strings, concrete edits or artifacts already produced'],
    action_in_progress: 'string, required, exact action currently in progress',
  };
  const request = [
    'Create a concise continuation delta for the Maka agent to continue this same task.',
    'Return ONLY a valid JSON object. Do not wrap it in markdown. Do not add prose before or after JSON.',
    `JSON schema: ${JSON.stringify(schema)}`,
    'The action_in_progress string field is required and must be non-empty.',
    'Use arrays for list fields. Keep each list to at most 6 short items.',
    'Use only the public provider-visible messages above.',
    'Do not invent command results, file contents, process state, credentials, verifier results, or hidden/private evaluation facts.',
    'The exact original user head anchor is already preserved. Do not repeat or paraphrase its objective or constraints.',
    'Do not emit a state card, task checklist, archive inventory, or generic restatement of the request.',
    'Preserve only established findings, decisions, failed paths, partial work product, and the action currently in progress.',
    'Durable source refs, hashes, and archive audit metadata are stored outside this provider-visible projection.',
    `Prefer concise JSON around ${input.policy.maxAcceptedProjectionEstimatedTokens ?? input.policy.maxSummaryEstimatedTokens ?? DEFAULT_MAX_SUMMARY_TOKENS} estimated tokens when possible; complete valid JSON is more important than brevity.`,
    `context_boundary: ${JSON.stringify(contextBoundary)}`,
  ].join('\n');
  return [
    input.messages[input.headAnchor.messageIndex]!,
    ...(input.predecessorMessageIndex !== undefined
      ? [
          input.predecessorBlock
            ? semanticCompactBlockToModelMessage(input.predecessorBlock)
            : input.messages[input.predecessorMessageIndex]!,
        ]
      : []),
    ...input.messages.slice(input.selection.startMessageIndex, input.selection.endMessageIndex + 1),
    { role: 'user', content: request } as ModelMessage,
  ];
}

function semanticCompactSystemPrompt(policy: SemanticCompactPolicy): string {
  return [
    'You compress a Maka agent session for current-turn context compaction.',
    'No tools are available. Return only valid JSON matching the requested schema.',
    'The original user instruction is preserved separately; do not restate its objective or constraints.',
    'Do not include hidden/private verifier material unless it was explicitly present in public provider-visible input.',
    `Prompt version: ${policy.promptVersion ?? 'maka-semantic-compact-continuation-v3'}.`,
  ].join('\n');
}

function buildSemanticCompactBlock(input: {
  input: SemanticCompactRewriteInput;
  index: ActiveFullCompactSourceIndex;
  selection: Extract<ReturnType<typeof selectActiveCompactionSafeSpan>, { decision: 'selected' }>;
  headAnchor: ActiveCompactionHeadAnchor;
  predecessorBlock?: SemanticCompactBlock;
  structuredSummary: SemanticCompactStructuredSummary;
  summaryText: string;
  usage?: NormalizedAiSdkUsage;
  finishReason?: string;
  providerRequestId?: string;
  requestShapeHashBefore?: string;
  charsPerToken: number;
  projectionFormat: 'structured' | 'bounded_text_fallback';
}): SemanticCompactBlock {
  const policy = input.input.policy!;
  const archiveRefs = uniqueArchiveRefs(
    input.selection.entries.map((entry) => entry.archiveRef).filter(isArchiveRef),
  );
  const sourceRefs = input.selection.entries.map(
    (entry): ActiveFullCompactSourceRef => ({
      kind: entry.archiveRef
        ? 'active_archive_placeholder'
        : entry.runtimeEventId
          ? 'runtime_event'
          : 'provider_message',
      sourceId: entry.sourceId,
      messageIndex: entry.messageIndex,
      ...(entry.partIndex !== undefined ? { partIndex: entry.partIndex } : {}),
      sessionId: input.input.sessionId,
      turnId: entry.turnId,
      ...(entry.runtimeEventId ? { runtimeEventId: entry.runtimeEventId } : {}),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      contentKind: entry.contentKind,
      bodySha256: entry.bodySha256,
      ...(entry.archiveRef ? { archiveRef: entry.archiveRef } : {}),
    }),
  );
  const preservedTailIndexes = preservedTailMessageIndexes(input.index, input.selection);
  const preservedTailEntries = input.index.entries.filter((entry) =>
    preservedTailIndexes.includes(entry.messageIndex),
  );
  const newCoverage = activeFullCompactCoverageFromEntries(input.selection.entries);
  const coverage = input.predecessorBlock
    ? mergeSemanticCoverage(input.predecessorBlock.coverage, newCoverage)
    : newCoverage;
  const predecessor =
    input.predecessorBlock?.cumulativeCoverageDigest ?? input.predecessorBlock?.blockId;
  const cumulativeCoverageDigest = stableHashHex({
    ...(predecessor !== undefined ? { predecessor } : {}),
    newCoverage,
  });
  const draft = {
    sessionId: input.input.sessionId,
    turnId: input.input.turnId,
    coverage,
    ...(input.predecessorBlock ? { predecessorBlockId: input.predecessorBlock.blockId } : {}),
    summaryText: input.summaryText,
    actionInProgress: input.structuredSummary.actionInProgress,
    highWaterSeq: input.input.stepNumber,
  };
  const block: SemanticCompactBlock = {
    kind: 'maka.semantic_compact_block',
    version: 2,
    blockId: `semcompact-${stableHashHex(draft).slice(0, 32)}`,
    sessionId: input.input.sessionId,
    turnId: input.input.turnId,
    ...(input.input.runId ? { runId: input.input.runId } : {}),
    ...(input.input.invocationId ? { invocationId: input.input.invocationId } : {}),
    createdAt: input.input.now ?? Date.now(),
    highWaterName: policy.highWaterName ?? 'semantic-compact-high-water',
    highWaterSeq: input.input.stepNumber,
    trigger: {
      reason: 'high_water',
      stepNumber: input.input.stepNumber,
      estimatedTokensBefore: input.index.estimatedTokens,
      ...(policy.maxActiveEstimatedTokens !== undefined
        ? {
            thresholdTokens: Math.floor(
              policy.maxActiveEstimatedTokens * finiteRatio(policy.highWaterRatio, 0.8),
            ),
          }
        : {}),
    },
    coverage,
    newCoverage,
    cumulativeCoverageDigest,
    headAnchor: {
      messageIndex: input.headAnchor.messageIndex,
      messageSignature: input.headAnchor.messageSignature,
      bodySha256: input.headAnchor.bodySha256,
      estimatedTokens: input.headAnchor.estimatedTokens,
      sourceIds: uniqueSorted(
        input.index.entries
          .filter((entry) => entry.messageIndex === input.headAnchor.messageIndex)
          .map((entry) => entry.sourceId),
      ),
    },
    ...(input.predecessorBlock ? { predecessorBlockId: input.predecessorBlock.blockId } : {}),
    sourceRefs,
    ...(archiveRefs.length > 0 ? { archiveRefs } : {}),
    preservedTail: {
      messageIndexes: preservedTailIndexes,
      toolCallIds: uniqueSorted(
        preservedTailEntries.map((entry) => entry.toolCallId).filter(nonEmpty),
      ),
      sourceIds: uniqueSorted(preservedTailEntries.map((entry) => entry.sourceId)),
    },
    summary: {
      promptVersion: policy.promptVersion ?? 'maka-semantic-compact-continuation-v3',
      text: input.summaryText,
      limitations: ['LLM semantic compact summary is bounded by public provider-visible context.'],
      nextAction: input.structuredSummary.actionInProgress,
    },
    projection: {
      format: input.projectionFormat,
      generationBudgetTokens: Math.floor(
        policy.maxCompactCallTokens ?? DEFAULT_MAX_COMPACT_CALL_TOKENS,
      ),
      acceptedBudgetTokens: Math.floor(
        policy.maxAcceptedProjectionEstimatedTokens ??
          policy.maxSummaryEstimatedTokens ??
          DEFAULT_MAX_SUMMARY_TOKENS,
      ),
      estimatedTokens: 0,
    },
    ...(input.requestShapeHashBefore
      ? { requestShapeHashBefore: input.requestShapeHashBefore }
      : {}),
    preActiveContextEstimatedTokens: input.index.estimatedTokens,
    postReplacementEstimatedTokens: input.index.estimatedTokens,
    estimatedTokensSavedSigned: 0,
    ...(input.usage ? { compactCallUsage: compactUsage(input.usage) } : {}),
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    acceptance: { decision: 'rejected', reason: 'pending_acceptance' },
  };
  block.postReplacementEstimatedTokens = estimatePostReplacementTokens(
    input.index,
    input.selection.estimatedTokens,
    renderSemanticCompactBlock(block),
    input.charsPerToken,
  );
  if (block.projection) {
    block.projection.estimatedTokens = estimateTokens(
      renderSemanticCompactBlock(block).length,
      input.charsPerToken,
    );
  }
  block.estimatedTokensSavedSigned =
    input.index.estimatedTokens - block.postReplacementEstimatedTokens;
  return block;
}

function semanticSavingsRejectionReason(
  block: SemanticCompactBlock,
  policy: SemanticCompactPolicy,
): string | undefined {
  const minSavingsTokens = Math.max(
    0,
    Math.floor(policy.minSavingsTokens ?? DEFAULT_MIN_SAVINGS_TOKENS),
  );
  if (block.estimatedTokensSavedSigned < minSavingsTokens) return 'below_min_savings_tokens';
  const minSavingsRatio = Math.max(0, policy.minSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO);
  const savingsRatio =
    block.preActiveContextEstimatedTokens > 0
      ? block.estimatedTokensSavedSigned / block.preActiveContextEstimatedTokens
      : 0;
  if (savingsRatio < minSavingsRatio) return 'below_min_savings_ratio';
  const minNetSavingsTokens = Math.max(
    0,
    Math.floor(policy.minNetSavingsTokens ?? minSavingsTokens),
  );
  if (
    (block.estimatedNetTokensSavedSigned ?? block.estimatedTokensSavedSigned) < minNetSavingsTokens
  ) {
    return 'below_min_net_savings_tokens';
  }
  return undefined;
}

function estimateSemanticNetTokensSaved(
  block: SemanticCompactBlock,
  policy: SemanticCompactPolicy,
): number {
  const compactCallTokens = block.compactCallUsage?.totalTokens ?? 0;
  const weight = finiteNonNegativeNumber(
    policy.compactCallTokenCostWeight,
    DEFAULT_COMPACT_CALL_TOKEN_COST_WEIGHT,
  );
  return block.estimatedTokensSavedSigned - Math.ceil(compactCallTokens * weight);
}

function semanticCompactBrakeReason(
  policy: SemanticCompactPolicy,
  state: SemanticCompactControllerState | undefined,
  stepNumber: number,
): string | undefined {
  if (!state) return undefined;
  if (state.suppressedUntilStep !== undefined) {
    if (stepNumber <= state.suppressedUntilStep) return 'semantic_compact_cooldown';
    delete state.suppressedUntilStep;
    state.consecutiveInvalidSummaries = 0;
    delete state.lastInvalidReason;
  }
  const maxConsecutiveInvalid = Math.floor(
    policy.maxConsecutiveInvalidSummaries ?? DEFAULT_MAX_CONSECUTIVE_INVALID_SUMMARIES,
  );
  if (maxConsecutiveInvalid > 0 && state.consecutiveInvalidSummaries >= maxConsecutiveInvalid) {
    const cooldownSteps = Math.floor(
      policy.invalidSummaryCooldownSteps ?? DEFAULT_INVALID_SUMMARY_COOLDOWN_STEPS,
    );
    if (cooldownSteps > 0) {
      state.suppressedUntilStep = Math.max(
        state.suppressedUntilStep ?? 0,
        stepNumber + cooldownSteps,
      );
      return 'semantic_compact_cooldown';
    }
  }
  return undefined;
}

function recordCompactCall(
  state: SemanticCompactControllerState | undefined,
  usage: SemanticCompactBlock['compactCallUsage'] | undefined,
): void {
  if (!state) return;
  state.compactCallCount += 1;
  state.compactCallTotalTokens += usage?.totalTokens ?? 0;
}

function recordInvalidSummary(
  state: SemanticCompactControllerState | undefined,
  policy: SemanticCompactPolicy,
  reason: string,
  stepNumber: number,
): void {
  if (!state) return;
  state.consecutiveInvalidSummaries += 1;
  state.totalInvalidSummaries += 1;
  state.lastInvalidReason = reason;
  const maxConsecutiveInvalid = Math.floor(
    policy.maxConsecutiveInvalidSummaries ?? DEFAULT_MAX_CONSECUTIVE_INVALID_SUMMARIES,
  );
  const cooldownSteps = Math.floor(
    policy.invalidSummaryCooldownSteps ?? DEFAULT_INVALID_SUMMARY_COOLDOWN_STEPS,
  );
  if (
    maxConsecutiveInvalid > 0 &&
    cooldownSteps > 0 &&
    state.consecutiveInvalidSummaries >= maxConsecutiveInvalid
  ) {
    state.suppressedUntilStep = Math.max(
      state.suppressedUntilStep ?? 0,
      stepNumber + cooldownSteps,
    );
  }
}

function recordValidSummary(state: SemanticCompactControllerState | undefined): void {
  if (!state) return;
  state.consecutiveInvalidSummaries = 0;
  delete state.lastInvalidReason;
}

function recordAcceptedSemanticCompact(
  state: SemanticCompactControllerState | undefined,
  block: SemanticCompactBlock,
): void {
  if (!state) return;
  state.acceptedEstimatedTokensSaved += block.estimatedTokensSavedSigned;
}

function semanticCompactDecisionDiagnosticPatch(input: {
  decision: 'unchanged' | 'replaced' | 'failedOpen';
  boundaryIds?: readonly string[];
  coverage?: ActiveFullCompactCoverage;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  estimatedTokensSaved?: number;
  candidateEstimatedTokens?: number;
  preservedHeadEstimatedTokens?: number;
  preservedTailEstimatedTokens?: number;
  acceptedProjectionEstimatedTokens?: number;
  compactCallUsage?: SemanticCompactBlock['compactCallUsage'];
  reason?: string;
  failOpenReason?: string;
  skippedReasonCounts?: Readonly<Record<string, number>>;
  validationReasonCounts?: Readonly<Record<string, number>>;
}): Partial<ContextBudgetDiagnostic> {
  return {
    semanticCompactEnabled: true,
    ...compactionDecisionDiagnosticPatch({
      stage: 'activeStep',
      sourceKind: 'providerMessages',
      boundaryKind: 'semanticCompact',
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
              providerMessageSourceIds: input.coverage.providerMessageSourceIds,
            },
          }
        : {}),
      ...(input.estimatedTokensBefore !== undefined
        ? { estimatedTokensBefore: input.estimatedTokensBefore }
        : {}),
      ...(input.estimatedTokensAfter !== undefined
        ? { estimatedTokensAfter: input.estimatedTokensAfter }
        : {}),
      ...(input.estimatedTokensSaved !== undefined
        ? { estimatedTokensSaved: input.estimatedTokensSaved }
        : {}),
      ...(input.candidateEstimatedTokens !== undefined
        ? { candidateEstimatedTokens: input.candidateEstimatedTokens }
        : {}),
      ...(input.preservedHeadEstimatedTokens !== undefined
        ? { preservedHeadEstimatedTokens: input.preservedHeadEstimatedTokens }
        : {}),
      ...(input.preservedTailEstimatedTokens !== undefined
        ? { preservedTailEstimatedTokens: input.preservedTailEstimatedTokens }
        : {}),
      ...(input.acceptedProjectionEstimatedTokens !== undefined
        ? { acceptedProjectionEstimatedTokens: input.acceptedProjectionEstimatedTokens }
        : {}),
      ...(input.compactCallUsage ? { compactCallUsage: input.compactCallUsage } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.failOpenReason ? { failOpenReason: input.failOpenReason } : {}),
      ...(input.skippedReasonCounts ? { skippedReasonCounts: input.skippedReasonCounts } : {}),
      ...(input.validationReasonCounts
        ? { validationReasonCounts: input.validationReasonCounts }
        : {}),
    }),
  };
}

async function callSummarizerWithTimeout(
  summarizer: SemanticCompactSummarizer,
  request: SemanticCompactSummaryRequest,
  timeoutMs: number | undefined,
): Promise<CompactSummaryResult> {
  if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(summarizer(request));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('semantic compact summarizer timeout')),
    timeoutMs,
  );
  const parentAbort = () => controller.abort(request.abortSignal?.reason);
  request.abortSignal?.addEventListener('abort', parentAbort, { once: true });
  try {
    return await Promise.resolve(summarizer({ ...request, abortSignal: controller.signal }));
  } finally {
    clearTimeout(timer);
    request.abortSignal?.removeEventListener('abort', parentAbort);
  }
}

function estimatePostReplacementTokens(
  index: ActiveFullCompactSourceIndex,
  selectedTokens: number,
  renderedReplacement: string,
  charsPerToken: number,
): number {
  return Math.max(
    0,
    index.estimatedTokens -
      selectedTokens +
      estimateTokens(renderedReplacement.length, charsPerToken),
  );
}

function preservedTailMessageIndexes(
  index: ActiveFullCompactSourceIndex,
  selection: { endMessageIndex: number },
): number[] {
  const indexes = new Set<number>();
  for (
    let cursor = selection.endMessageIndex + 1;
    cursor < index.providerMessageCount;
    cursor += 1
  ) {
    indexes.add(cursor);
  }
  return [...indexes].sort((a, b) => a - b);
}

function selectedSourceText(
  selection: { startMessageIndex: number; endMessageIndex: number },
  messages: readonly ModelMessage[],
): string {
  return stableStringify(
    messages.slice(selection.startMessageIndex, selection.endMessageIndex + 1),
  );
}

function parseSemanticCompactSummary(text: string):
  | {
      ok: true;
      summary: SemanticCompactStructuredSummary;
    }
  | {
      ok: false;
      reason: string;
    } {
  const raw = text.trim();
  if (!raw) return { ok: false, reason: 'summary_missing' };
  const jsonText = extractJsonObjectText(raw);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      const normalized = normalizeStructuredSummary(parsed);
      if (normalized.ok) return normalized;
      return { ok: false, reason: normalized.reason };
    } catch {
      return { ok: false, reason: 'summary_invalid_json' };
    }
  }
  const legacy = parseLegacyLabeledSummary(raw);
  if (legacy.ok) return legacy;
  return { ok: false, reason: 'summary_invalid_json' };
}

function fallbackSemanticCompactSummary(
  rawText: string,
  reason: string,
  maxChars = FALLBACK_RAW_SUMMARY_MAX_CHARS,
): SemanticCompactStructuredSummary | undefined {
  const fallbackText = boundedFallbackText(
    rawText,
    Math.min(FALLBACK_RAW_SUMMARY_MAX_CHARS, maxChars),
  );
  if (!fallbackText) return undefined;
  return {
    establishedFindings: [
      `continuation_notes: ${fallbackText}`,
      `Semantic compact summarizer output did not satisfy the requested structure (${reason}); using bounded text fallback.`,
    ],
    decisions: [],
    failedPaths: [],
    partialWorkProduct: [],
    actionInProgress: 'Continue from the preserved recent execution episode.',
  };
}

function renderStructuredSemanticSummary(summary: SemanticCompactStructuredSummary): string {
  return [
    ...renderSummaryList('established_findings', summary.establishedFindings),
    ...renderSummaryList('decisions', summary.decisions),
    ...renderSummaryList('failed_paths', summary.failedPaths),
    ...renderSummaryList('partial_work_product', summary.partialWorkProduct),
    `action_in_progress: ${summary.actionInProgress}`,
  ]
    .join('\n')
    .trim();
}

function renderSummaryList(label: string, values: readonly string[]): string[] {
  const clean = values.map(singleLine).filter(nonEmpty).slice(0, 8);
  if (clean.length === 0) return [`${label}: none`];
  if (clean.length === 1) return [`${label}: ${clean[0]}`];
  return [`${label}:`, ...clean.map((value) => `- ${value}`)];
}

function resolveSemanticHeadAnchor(
  messages: readonly ModelMessage[],
  provided: ActiveCompactionHeadAnchor | undefined,
  charsPerToken: number,
): ActiveCompactionHeadAnchor | undefined {
  if (provided) {
    const message = messages[provided.messageIndex];
    return message && activeCompactionMessageSignature(message) === provided.messageSignature
      ? provided
      : undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if ((message as { role?: unknown }).role !== 'user') continue;
    if (messageContainsSemanticCompactBlock(message)) continue;
    return buildActiveCompactionHeadAnchor(messages, index, charsPerToken);
  }
  return undefined;
}

function findSemanticProjectionMessageIndex(
  messages: readonly ModelMessage[],
  headAnchorMessageIndex: number,
): number | undefined {
  const candidateIndex = headAnchorMessageIndex + 1;
  return messageContainsSemanticCompactBlock(messages[candidateIndex]) ? candidateIndex : undefined;
}

function messageContainsSemanticCompactBlock(message: ModelMessage | undefined): boolean {
  if (!message) return false;
  return stableStringify((message as { content?: unknown }).content).includes(
    '<maka_semantic_compact_block',
  );
}

function isTruncatedFinishReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase().replaceAll('_', '-');
  return normalized === 'length' || normalized === 'max-tokens';
}

function fitSemanticCompactBlockToAcceptedBudget(
  block: SemanticCompactBlock,
  source: SemanticCompactStructuredSummary,
  maxEstimatedTokens: number,
  charsPerToken: number,
): boolean {
  const maxTokens = Math.max(1, Math.floor(maxEstimatedTokens));
  const fitted: SemanticCompactStructuredSummary = {
    ...source,
    establishedFindings: [...source.establishedFindings],
    decisions: [...source.decisions],
    failedPaths: [...source.failedPaths],
    partialWorkProduct: [...source.partialWorkProduct],
  };
  const update = () => {
    block.summary.text = renderStructuredSemanticSummary(fitted);
    block.summary.nextAction = fitted.actionInProgress;
  };
  const fits = () =>
    estimateTokens(renderSemanticCompactBlock(block).length, charsPerToken) <= maxTokens;
  const acceptFit = () => {
    if (
      block.projection?.format === 'bounded_text_fallback' &&
      !block.summary.text.includes('continuation_notes:')
    )
      return false;
    return updateProjectionEstimate(block, charsPerToken);
  };
  update();
  if (fits() && acceptFit()) return true;

  const boundedListKeys: Array<
    keyof Pick<
      SemanticCompactStructuredSummary,
      'establishedFindings' | 'decisions' | 'failedPaths' | 'partialWorkProduct'
    >
  > = ['establishedFindings', 'decisions', 'failedPaths', 'partialWorkProduct'];
  for (const key of boundedListKeys) {
    fitted[key] = fitted[key]
      .slice(0, 4)
      .map((value) =>
        block.projection?.format === 'bounded_text_fallback'
          ? boundedFallbackText(value, 240)
          : boundedCompleteText(value, 240),
      )
      .filter(nonEmpty);
  }
  fitted.actionInProgress = boundedCompleteText(fitted.actionInProgress, 320);
  update();
  if (fits() && acceptFit()) return true;

  for (const key of boundedListKeys) {
    while (fitted[key].length > 0) {
      fitted[key] = fitted[key].slice(0, -1);
      update();
      if (fits() && acceptFit()) return true;
    }
  }
  return false;
}

function updateProjectionEstimate(block: SemanticCompactBlock, charsPerToken: number): true {
  if (block.projection) {
    block.projection.estimatedTokens = estimateTokens(
      renderSemanticCompactBlock(block).length,
      charsPerToken,
    );
  }
  return true;
}

function mergeSemanticCoverage(
  previous: ActiveFullCompactCoverage,
  next: ActiveFullCompactCoverage,
): ActiveFullCompactCoverage {
  return {
    turnIds: uniqueSorted([...previous.turnIds, ...next.turnIds]),
    runtimeEventIds: uniqueSorted([...previous.runtimeEventIds, ...next.runtimeEventIds]),
    providerMessageSourceIds: uniqueSorted([
      ...previous.providerMessageSourceIds,
      ...next.providerMessageSourceIds,
    ]),
    toolCallIds: uniqueSorted([...previous.toolCallIds, ...next.toolCallIds]),
    contentKinds: uniqueSorted([...previous.contentKinds, ...next.contentKinds]),
    bodySha256: uniqueSorted([...previous.bodySha256, ...next.bodySha256]),
  };
}

function extractJsonObjectText(raw: string): string | undefined {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence?.[1]?.trim() ?? raw;
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return undefined;
}

function normalizeStructuredSummary(value: unknown):
  | {
      ok: true;
      summary: SemanticCompactStructuredSummary;
    }
  | {
      ok: false;
      reason: string;
    } {
  if (!isRecord(value)) return { ok: false, reason: 'summary_schema_invalid' };
  const actionInProgress = stringField(value, 'action_in_progress');
  if (!actionInProgress) return { ok: false, reason: 'summary_missing_action_in_progress' };
  return {
    ok: true,
    summary: {
      establishedFindings: stringListField(value, 'established_findings'),
      decisions: stringListField(value, 'decisions'),
      failedPaths: stringListField(value, 'failed_paths'),
      partialWorkProduct: stringListField(value, 'partial_work_product'),
      actionInProgress,
    },
  };
}

function parseLegacyLabeledSummary(raw: string):
  | {
      ok: true;
      summary: SemanticCompactStructuredSummary;
    }
  | {
      ok: false;
      reason: string;
    } {
  const actionInProgress = extractSummaryField(raw, SUMMARY_FIELD_LABELS.actionInProgress);
  if (!actionInProgress) return { ok: false, reason: 'summary_missing_action_in_progress' };
  return {
    ok: true,
    summary: {
      establishedFindings: fieldListFromLegacy(raw, [
        'established_findings',
        'established findings',
      ]),
      decisions: fieldListFromLegacy(raw, ['decisions']),
      failedPaths: fieldListFromLegacy(raw, ['failed_paths', 'failed paths']),
      partialWorkProduct: fieldListFromLegacy(raw, [
        'partial_work_product',
        'partial work product',
      ]),
      actionInProgress,
    },
  };
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (typeof field !== 'string') return undefined;
  const trimmed = singleLine(field);
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringListField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (Array.isArray(field))
    return field
      .map((item) => (typeof item === 'string' ? singleLine(item) : ''))
      .filter(nonEmpty)
      .slice(0, 8);
  if (typeof field === 'string') {
    const trimmed = singleLine(field);
    return trimmed.length > 0 && trimmed.toLowerCase() !== 'none' ? [trimmed] : [];
  }
  return [];
}

function fieldListFromLegacy(raw: string, labels: readonly string[]): string[] {
  const field = extractSummaryField(raw, labels);
  if (!field || field.toLowerCase() === 'none') return [];
  return field
    .split(/\n|;|\u2022/g)
    .map((part) => singleLine(part.replace(/^-+\s*/, '')))
    .filter(nonEmpty)
    .slice(0, 8);
}

function extractSummaryField(summaryText: string, labels: readonly string[]): string | undefined {
  const lines = summaryText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_ ]{0,64})\s*:\s*(.*)$/);
    if (!match) continue;
    const label = match[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = labels.map((value) => value.toLowerCase().replace(/_/g, ' '));
    if (!wanted.includes(label.replace(/_/g, ' '))) continue;
    const inlineValue = match[2]!.trim();
    if (inlineValue.length > 0) return inlineValue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*[A-Za-z_][A-Za-z0-9_ ]{0,64}\s*:/.test(lines[cursor]!)) break;
      const continuation = lines[cursor]!.trim();
      if (continuation.length > 0) return continuation;
    }
  }
  return undefined;
}

function newPrivateVerifierSurface(summaryText: string, publicSourceText: string): boolean {
  return (
    PRIVATE_VERIFIER_PATTERN.test(summaryText) && !PRIVATE_VERIFIER_PATTERN.test(publicSourceText)
  );
}

function rejected(
  messages: ModelMessage[],
  index: ActiveFullCompactSourceIndex,
  reason: string,
  compactCallUsage?: SemanticCompactBlock['compactCallUsage'],
): SemanticCompactRewriteResult {
  return {
    messages,
    decision: 'unchanged',
    reason,
    diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
      decision: 'unchanged',
      reason,
      estimatedTokensBefore: index.estimatedTokens,
      estimatedTokensAfter: index.estimatedTokens,
      estimatedTokensSaved: 0,
      ...(compactCallUsage ? { compactCallUsage } : {}),
    }),
  };
}

function unchanged(messages: ModelMessage[], reason: string): SemanticCompactRewriteResult {
  return {
    messages,
    decision: 'unchanged',
    reason,
    diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
      decision: 'unchanged',
      reason,
    }),
  };
}

function compactUsage(
  usage: NormalizedAiSdkUsage,
): NonNullable<SemanticCompactBlock['compactCallUsage']> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheHitInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    totalTokens: usage.totalTokens,
  };
}

function uniqueArchiveRefs(
  refs: readonly ActiveFullCompactArchiveRef[],
): ActiveFullCompactArchiveRef[] {
  const seen = new Set<string>();
  const out: ActiveFullCompactArchiveRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.artifactId}:${ref.bodySha256}:${ref.toolCallId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function isArchiveRef(value: unknown): value is ActiveFullCompactArchiveRef {
  return (
    isRecord(value) &&
    (value.kind === 'toolResult' || value.kind === 'compactSource') &&
    typeof value.artifactId === 'string' &&
    typeof value.bodySha256 === 'string'
  );
}

function finiteRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(0, Math.min(1, value));
}

function finiteNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function stableHashHex(value: unknown): string {
  return stableHash(value).slice('sha256:'.length);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function countStringReasons(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundedCompleteText(value: string, maxChars: number): string {
  const clean = singleLine(value);
  if (clean.length <= maxChars) return clean;
  const candidate = clean.slice(0, Math.max(0, maxChars));
  const sentenceBoundary = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('! '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('; '),
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('；'),
  );
  if (sentenceBoundary >= Math.min(40, Math.floor(maxChars / 3))) {
    return candidate.slice(0, sentenceBoundary + 1).trim();
  }
  const wordBoundary = candidate.lastIndexOf(' ');
  return wordBoundary >= Math.min(20, Math.floor(maxChars / 4))
    ? candidate.slice(0, wordBoundary).trim()
    : '';
}

function boundedFallbackText(value: string, maxChars: number): string {
  const clean = value.trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const candidate = clean.slice(0, Math.max(0, maxChars));
  const lineBoundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf('\r'));
  if (lineBoundary >= Math.min(20, Math.floor(maxChars / 4))) {
    return candidate.slice(0, lineBoundary).trim();
  }
  const sentenceBoundary = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('! '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('; '),
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('；'),
  );
  return sentenceBoundary >= Math.min(40, Math.floor(maxChars / 3))
    ? candidate.slice(0, sentenceBoundary + 1).trim()
    : '';
}
