// Context-budget env compiler for the Harbor cell. This is the LIGHT leaf of the
// Harbor cell split: it turns MAKA_CONTEXT_* env into a runtime ContextBudgetPolicy
// (and its serializable snapshot) plus the tool-result archive callbacks, without
// importing runtime backends, node:child_process, or credential readers. Keeping it
// free of those heavy deps lets callers that only need the env-key list or the
// normalizer (e.g. runtime-policy-ab-run.ts) import from here instead of dragging in
// the whole orchestration module.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  createToolResultArchiveCapability,
  type ContextBudgetPolicy,
  type ToolResultArchiveCapability,
  type ToolResultArchiveReadFailureReason,
  type ToolResultArchiveReadResult,
} from '@maka/runtime';
import type { HarborCellContextBudgetPolicySnapshot } from './cell-output.js';
import {
  booleanEnv,
  numericEnv,
  positiveIntEnv,
  type RunHarborCellEnv,
} from './headless-run-env.js';

export interface HarborCellContextBudgetBackendOptions {
  contextBudget?: ContextBudgetPolicy;
  /**
   * Present exactly when `MAKA_TOOL_RESULT_ARCHIVE_DIR` resolves. Writer, replay
   * reader, ref reader and the `ArchiveRead` decoder come from that one resolved
   * directory, so the cell cannot archive into a directory it cannot read back
   * out of — which is what #2025 actually was.
   */
  toolResultArchive?: ToolResultArchiveCapability;
}

export interface HarborCellTaskLedgerExperimentPolicy {
  enabled: true;
  replayMaxChars: number;
}

export const HARBOR_CELL_CONTEXT_ENV_KEYS = [
  'MAKA_CONTEXT_BUDGET',
  'MAKA_CONTEXT_BUDGET_NAME',
  'MAKA_CONTEXT_CHARS_PER_TOKEN',
  'MAKA_CONTEXT_MAX_HISTORY_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_MAX_HISTORY_TURNS',
  'MAKA_CONTEXT_HISTORY_BUDGET_TOKENS',
  'MAKA_CONTEXT_HISTORY_BUDGET_TURNS',
  'MAKA_CONTEXT_MIN_RECENT_TURNS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_FORCE_RATIO',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_TARGET_RATIO',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_TOOL_PAIRS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME',
  'MAKA_CONTEXT_SEMANTIC_COMPACT',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MODE',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_FORCE_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_TARGET_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAFE_PREFIX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NEW_PREFIX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACCEPTED_PROJECTION_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES',
  'MAKA_CONTEXT_SYNTHESIS_CACHE',
  'MAKA_CONTEXT_SYNTHESIS_CACHE_MODE',
  'MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS',
  'MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS',
  'MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS',
  'MAKA_CONTEXT_TOOL_RESULT_ARCHIVE_DIR',
  'MAKA_CONTEXT_TASK_TOOLS',
  'MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS',
] as const;

export type HarborCellContextEnvKey = (typeof HARBOR_CELL_CONTEXT_ENV_KEYS)[number];

const HARBOR_CELL_CONTEXT_ENV_KEY_SET = new Set<string>(HARBOR_CELL_CONTEXT_ENV_KEYS);

export function normalizeHarborCellContextEnv(
  env: RunHarborCellEnv,
): Partial<Record<HarborCellContextEnvKey, string>> {
  const result: Partial<Record<HarborCellContextEnvKey, string>> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('MAKA_CONTEXT_')) continue;
    if (!HARBOR_CELL_CONTEXT_ENV_KEY_SET.has(key))
      throw new Error(`unsupported Harbor context env key: ${key}`);
    if (value !== undefined) result[key as HarborCellContextEnvKey] = value;
  }
  return result;
}

interface HarborCellToolResultArchiveRecord {
  version: 1;
  sessionId: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  serializedResult: string;
}

export function buildHarborCellContextBudgetBackendOptions(
  env: RunHarborCellEnv = process.env,
): HarborCellContextBudgetBackendOptions {
  normalizeHarborCellContextEnv(env);
  if (env.MAKA_CONTEXT_BUDGET === 'off') return {};
  const pruneEnabled =
    booleanEnv(
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE ??
        env.MAKA_HARBOR_CONTEXT_STALE_TOOL_RESULT_PRUNE ??
        env.MAKA_TOOL_RESULT_PRUNE,
      'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE',
    ) ?? true;
  const activePruneEnabled =
    booleanEnv(
      env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE ??
        env.MAKA_HARBOR_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE ??
        env.MAKA_ACTIVE_TOOL_RESULT_PRUNE,
      'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
    ) ?? true;
  const archiveRetrievalEnabled =
    booleanEnv(
      env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL ?? env.MAKA_HARBOR_CONTEXT_ARCHIVE_RETRIEVAL,
      'MAKA_CONTEXT_ARCHIVE_RETRIEVAL',
    ) ?? false;
  const activeFullCompactEnabled =
    booleanEnv(
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT ?? env.MAKA_HARBOR_CONTEXT_ACTIVE_FULL_COMPACT,
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT',
    ) ?? false;
  const semanticCompactEnabled =
    booleanEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT ?? env.MAKA_HARBOR_CONTEXT_SEMANTIC_COMPACT,
      'MAKA_CONTEXT_SEMANTIC_COMPACT',
    ) ?? false;
  const synthesisCacheEnabled =
    booleanEnv(
      env.MAKA_CONTEXT_SYNTHESIS_CACHE ?? env.MAKA_HARBOR_CONTEXT_SYNTHESIS_CACHE,
      'MAKA_CONTEXT_SYNTHESIS_CACHE',
    ) ?? false;
  if (
    !pruneEnabled &&
    !activePruneEnabled &&
    !archiveRetrievalEnabled &&
    !activeFullCompactEnabled &&
    !semanticCompactEnabled &&
    !synthesisCacheEnabled
  )
    return {};

  const contextBudget: ContextBudgetPolicy = {
    name: env.MAKA_CONTEXT_BUDGET_NAME ?? 'harbor-cell-context-budget',
  };
  const charsPerToken = numericEnv(env.MAKA_CONTEXT_CHARS_PER_TOKEN);
  const maxHistoryEstimatedTokens = firstContextNonNegativeIntEnv(env, [
    'MAKA_CONTEXT_MAX_HISTORY_ESTIMATED_TOKENS',
    'MAKA_CONTEXT_HISTORY_BUDGET_TOKENS',
  ]);
  const maxHistoryTurns = firstContextNonNegativeIntEnv(env, [
    'MAKA_CONTEXT_MAX_HISTORY_TURNS',
    'MAKA_CONTEXT_HISTORY_BUDGET_TURNS',
  ]);
  const minRecentTurns = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_MIN_RECENT_TURNS']);
  if (charsPerToken !== undefined) contextBudget.charsPerToken = charsPerToken;
  if (maxHistoryEstimatedTokens !== undefined)
    contextBudget.maxHistoryEstimatedTokens = maxHistoryEstimatedTokens;
  if (maxHistoryTurns !== undefined) contextBudget.maxHistoryTurns = maxHistoryTurns;
  if (minRecentTurns !== undefined) contextBudget.minRecentTurns = minRecentTurns;

  if (pruneEnabled) {
    const maxResultEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
      'MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
    );
    const minRecentTurnsFull = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL',
      'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS',
    ]);
    contextBudget.staleToolResultPrune = {
      enabled: true,
      ...(maxResultEstimatedTokens !== undefined ? { maxResultEstimatedTokens } : {}),
      // Active prune owns the current turn; stale prune must take over on the
      // next replay without restoring a full-result protection window.
      minRecentTurnsFull: minRecentTurnsFull ?? 0,
    };
  }

  if (activePruneEnabled) {
    const maxCurrentResultEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
    );
    const minStepNumber = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER',
    ]);
    contextBudget.activeToolResultPrune = {
      enabled: true,
      ...(maxCurrentResultEstimatedTokens !== undefined ? { maxCurrentResultEstimatedTokens } : {}),
      ...(minStepNumber !== undefined ? { minStepNumber } : {}),
    };
  }

  if (archiveRetrievalEnabled) {
    const mode = archiveRetrievalModeEnv(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE);
    const maxResults = positiveIntEnv(
      env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS,
      'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS',
    );
    const maxEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS,
      'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS',
    );
    const maxBytes = positiveIntEnv(
      env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES,
      'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES',
    );
    contextBudget.archiveRetrieval = {
      enabled: true,
      ...(mode ? { mode } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
      ...(maxEstimatedTokens !== undefined ? { maxEstimatedTokens } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    };
  }

  if (activeFullCompactEnabled) {
    const mode = activeFullCompactModeEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE);
    const maxActiveEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
    );
    const minStepNumber = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER',
    ]);
    const minRecentMessages = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES',
    ]);
    const minRecentToolPairs = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_TOOL_PAIRS',
    ]);
    const maxSummaryEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
    );
    const archiveRequired = booleanEnv(
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED,
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED',
    );
    const highWaterRatio = numericEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO);
    const forceRatio = numericEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_FORCE_RATIO);
    const targetRatio = numericEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_TARGET_RATIO);
    contextBudget.activeFullCompact = {
      enabled: true,
      ...(mode ? { mode } : {}),
      ...(minStepNumber !== undefined ? { minStepNumber } : {}),
      ...(highWaterRatio !== undefined ? { highWaterRatio } : {}),
      ...(forceRatio !== undefined ? { forceRatio } : {}),
      ...(targetRatio !== undefined ? { targetRatio } : {}),
      ...(maxActiveEstimatedTokens !== undefined ? { maxActiveEstimatedTokens } : {}),
      ...(minRecentMessages !== undefined ? { minRecentMessages } : {}),
      ...(minRecentToolPairs !== undefined ? { minRecentToolPairs } : {}),
      ...(maxSummaryEstimatedTokens !== undefined ? { maxSummaryEstimatedTokens } : {}),
      ...(archiveRequired !== undefined ? { archiveRequired } : {}),
      ...(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME
        ? { highWaterName: env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME }
        : {}),
    };
  }

  if (semanticCompactEnabled) {
    const mode = semanticCompactModeEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODE);
    const maxActiveEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
    );
    const minStepNumber = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER',
    ]);
    const minRecentMessages = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES',
    ]);
    const minRecentToolPairs = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS',
    ]);
    const minSafePrefixEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAFE_PREFIX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAFE_PREFIX_ESTIMATED_TOKENS',
    );
    const minNewPrefixEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NEW_PREFIX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NEW_PREFIX_ESTIMATED_TOKENS',
    );
    const maxSummaryEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
    );
    const maxAcceptedProjectionEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACCEPTED_PROJECTION_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS ??
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACCEPTED_PROJECTION_ESTIMATED_TOKENS',
    );
    const minSavingsTokens = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS',
    ]);
    const minNetSavingsTokens = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS',
    ]);
    const maxCompactCallTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS',
    );
    const maxConsecutiveInvalidSummaries = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES',
    ]);
    const invalidSummaryCooldownSteps = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS',
    ]);
    const timeoutMs = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS',
    );
    const archiveRequired = booleanEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED',
    );
    const highWaterRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO);
    const forceRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_FORCE_RATIO);
    const targetRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_TARGET_RATIO);
    const minSavingsRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO);
    const compactCallTokenCostWeight = numericEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT,
    );
    contextBudget.semanticCompact = {
      enabled: true,
      ...(mode ? { mode } : {}),
      ...(minStepNumber !== undefined ? { minStepNumber } : {}),
      ...(highWaterRatio !== undefined ? { highWaterRatio } : {}),
      ...(forceRatio !== undefined ? { forceRatio } : {}),
      ...(targetRatio !== undefined ? { targetRatio } : {}),
      ...(maxActiveEstimatedTokens !== undefined ? { maxActiveEstimatedTokens } : {}),
      ...(minRecentMessages !== undefined ? { minRecentMessages } : {}),
      ...(minRecentToolPairs !== undefined ? { minRecentToolPairs } : {}),
      ...(minSafePrefixEstimatedTokens !== undefined ? { minSafePrefixEstimatedTokens } : {}),
      ...(minNewPrefixEstimatedTokens !== undefined ? { minNewPrefixEstimatedTokens } : {}),
      ...(maxAcceptedProjectionEstimatedTokens !== undefined
        ? { maxAcceptedProjectionEstimatedTokens }
        : {}),
      ...(maxSummaryEstimatedTokens !== undefined ? { maxSummaryEstimatedTokens } : {}),
      ...(minSavingsTokens !== undefined ? { minSavingsTokens } : {}),
      ...(minSavingsRatio !== undefined ? { minSavingsRatio } : {}),
      ...(minNetSavingsTokens !== undefined ? { minNetSavingsTokens } : {}),
      ...(compactCallTokenCostWeight !== undefined ? { compactCallTokenCostWeight } : {}),
      ...(maxCompactCallTokens !== undefined ? { maxCompactCallTokens } : {}),
      ...(maxConsecutiveInvalidSummaries !== undefined ? { maxConsecutiveInvalidSummaries } : {}),
      ...(invalidSummaryCooldownSteps !== undefined ? { invalidSummaryCooldownSteps } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(archiveRequired !== undefined ? { archiveRequired } : {}),
      ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL
        ? { summarizerModel: env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL }
        : {}),
      ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION
        ? { promptVersion: env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION }
        : {}),
      ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME
        ? { highWaterName: env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME }
        : {}),
    };
  }

  if (synthesisCacheEnabled) {
    contextBudget.synthesisCache = {
      enabled: true,
      mode: env.MAKA_CONTEXT_SYNTHESIS_CACHE_MODE === 'read_write' ? 'read_write' : 'lookup',
      maxBlocks:
        positiveIntEnv(
          env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS,
          'MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS',
        ) ?? 1,
      maxEstimatedTokens:
        positiveIntEnv(
          env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS,
          'MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS',
        ) ?? 2048,
      maxBlockEstimatedTokens:
        positiveIntEnv(
          env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS,
          'MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS',
        ) ?? 1024,
      invalidateOnNewToolResult: true,
      schemaVersion: 1,
    };
  }

  const archiveDir = harborCellToolResultArchiveDir(env);
  if (!archiveDir) return { contextBudget };
  const toolResultArchive = createToolResultArchiveCapability({
    archiveToolResult: async (input) => {
      await mkdir(archiveDir, { recursive: true });
      const artifactId = harborCellToolResultArchiveArtifactId(input);
      const record: HarborCellToolResultArchiveRecord = {
        version: 1,
        sessionId: input.sessionId,
        runtimeEventId: input.runtimeEventId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        bodySha256: input.bodySha256,
        originalEstimatedTokens: input.originalEstimatedTokens,
        originalBytes: input.originalBytes,
        serializedResult: input.serializedResult,
      };
      await writeFile(join(archiveDir, artifactId), `${JSON.stringify(record)}\n`, 'utf8');
      return { artifactId };
    },
    // Replay hydration addresses an archive by the originating runtime event, so
    // it verifies that identity on top of the shared artifact checks.
    readToolResultArchive: async (input) =>
      readHarborCellArchivedToolResult(archiveDir, input, {
        runtimeEventId: input.runtimeEventId,
        toolCallId: input.toolCallId,
      }),
    // The ref-addressed read has no runtime event identity to check — a
    // `maka://archive/...` ref only carries artifact id, hash, and size — and it
    // must never synthesize one to satisfy the stricter path above.
    readArchivedToolResultResource: async (input) =>
      readHarborCellArchivedToolResult(archiveDir, input),
  });
  return { contextBudget, toolResultArchive };
}

async function readHarborCellArchivedToolResult(
  archiveDir: string,
  input: {
    artifactId: string;
    sessionId: string;
    bodySha256: string;
    originalBytes: number;
  },
  expectedSource?: { runtimeEventId: string; toolCallId: string },
): Promise<ToolResultArchiveReadResult> {
  if (!isSafeHarborCellArchiveArtifactId(input.artifactId))
    return { ok: false, reason: 'not_allowed' };
  let raw: string;
  try {
    raw = await readFile(join(archiveDir, input.artifactId), 'utf8');
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (!isHarborCellToolResultArchiveRecord(parsed)) return { ok: false, reason: 'corrupt' };
  if (parsed.sessionId !== input.sessionId) return { ok: false, reason: 'session_mismatch' };
  if (
    expectedSource &&
    (parsed.runtimeEventId !== expectedSource.runtimeEventId ||
      parsed.toolCallId !== expectedSource.toolCallId)
  )
    return { ok: false, reason: 'source_mismatch' };
  if (parsed.originalBytes !== input.originalBytes) return { ok: false, reason: 'size_mismatch' };
  if (parsed.bodySha256 !== input.bodySha256) return { ok: false, reason: 'source_mismatch' };
  const actualSha = createHash('sha256').update(parsed.serializedResult).digest('hex');
  if (actualSha !== input.bodySha256) return { ok: false, reason: 'corrupt' };
  const actualBytes = Buffer.byteLength(parsed.serializedResult, 'utf8');
  if (actualBytes !== input.originalBytes) return { ok: false, reason: 'size_mismatch' };
  return { ok: true, serializedResult: parsed.serializedResult };
}

export function buildHarborCellTaskLedgerExperimentPolicy(
  env: RunHarborCellEnv = process.env,
): HarborCellTaskLedgerExperimentPolicy | undefined {
  normalizeHarborCellContextEnv(env);
  const enabled = booleanEnv(env.MAKA_CONTEXT_TASK_TOOLS, 'MAKA_CONTEXT_TASK_TOOLS') ?? false;
  if (!enabled) return undefined;
  return {
    enabled: true,
    replayMaxChars:
      positiveIntEnv(
        env.MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS,
        'MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS',
      ) ?? 4_000,
  };
}

export function buildHarborCellContextBudgetPolicySnapshot(
  env: RunHarborCellEnv,
): HarborCellContextBudgetPolicySnapshot | undefined {
  if (env.MAKA_CONTEXT_BUDGET === 'off') return { enabled: false };
  const contextBudget = buildHarborCellContextBudgetBackendOptions(env).contextBudget;
  if (!contextBudget) return undefined;
  const minRecentTurns = contextBudget.minRecentTurns ?? 2;
  return {
    enabled: true,
    name: contextBudget.name,
    ...(contextBudget.maxHistoryTurns !== undefined
      ? { maxHistoryTurns: contextBudget.maxHistoryTurns }
      : {}),
    ...(contextBudget.maxHistoryEstimatedTokens !== undefined
      ? { maxHistoryEstimatedTokens: contextBudget.maxHistoryEstimatedTokens }
      : {}),
    ...(contextBudget.staleToolResultPrune
      ? {
          staleToolResultPrune: {
            enabled: contextBudget.staleToolResultPrune.enabled,
            maxResultEstimatedTokens:
              contextBudget.staleToolResultPrune.maxResultEstimatedTokens ?? 2048,
            minRecentTurnsFull:
              contextBudget.staleToolResultPrune.minRecentTurnsFull ?? minRecentTurns,
          },
        }
      : {}),
    ...(contextBudget.activeToolResultPrune
      ? {
          activeToolResultPrune: {
            enabled: contextBudget.activeToolResultPrune.enabled,
            maxCurrentResultEstimatedTokens:
              contextBudget.activeToolResultPrune.maxCurrentResultEstimatedTokens ?? 2048,
            minStepNumber: contextBudget.activeToolResultPrune.minStepNumber ?? 1,
          },
        }
      : {}),
    ...(contextBudget.activeFullCompact
      ? {
          activeFullCompact: {
            enabled: contextBudget.activeFullCompact.enabled,
            ...(contextBudget.activeFullCompact.mode
              ? { mode: contextBudget.activeFullCompact.mode }
              : {}),
            ...(contextBudget.activeFullCompact.minStepNumber !== undefined
              ? { minStepNumber: contextBudget.activeFullCompact.minStepNumber }
              : {}),
            ...(contextBudget.activeFullCompact.highWaterRatio !== undefined
              ? { highWaterRatio: contextBudget.activeFullCompact.highWaterRatio }
              : {}),
            ...(contextBudget.activeFullCompact.forceRatio !== undefined
              ? { forceRatio: contextBudget.activeFullCompact.forceRatio }
              : {}),
            ...(contextBudget.activeFullCompact.targetRatio !== undefined
              ? { targetRatio: contextBudget.activeFullCompact.targetRatio }
              : {}),
            ...(contextBudget.activeFullCompact.maxActiveEstimatedTokens !== undefined
              ? {
                  maxActiveEstimatedTokens:
                    contextBudget.activeFullCompact.maxActiveEstimatedTokens,
                }
              : {}),
            ...(contextBudget.activeFullCompact.minRecentMessages !== undefined
              ? { minRecentMessages: contextBudget.activeFullCompact.minRecentMessages }
              : {}),
            ...(contextBudget.activeFullCompact.minRecentToolPairs !== undefined
              ? { minRecentToolPairs: contextBudget.activeFullCompact.minRecentToolPairs }
              : {}),
            ...(contextBudget.activeFullCompact.maxSummaryEstimatedTokens !== undefined
              ? {
                  maxSummaryEstimatedTokens:
                    contextBudget.activeFullCompact.maxSummaryEstimatedTokens,
                }
              : {}),
            ...(contextBudget.activeFullCompact.archiveRequired !== undefined
              ? { archiveRequired: contextBudget.activeFullCompact.archiveRequired }
              : {}),
            ...(contextBudget.activeFullCompact.highWaterName
              ? { highWaterName: contextBudget.activeFullCompact.highWaterName }
              : {}),
          },
        }
      : {}),
    ...(contextBudget.semanticCompact
      ? {
          semanticCompact: {
            enabled: contextBudget.semanticCompact.enabled,
            ...(contextBudget.semanticCompact.mode
              ? { mode: contextBudget.semanticCompact.mode }
              : {}),
            ...(contextBudget.semanticCompact.minStepNumber !== undefined
              ? { minStepNumber: contextBudget.semanticCompact.minStepNumber }
              : {}),
            ...(contextBudget.semanticCompact.highWaterRatio !== undefined
              ? { highWaterRatio: contextBudget.semanticCompact.highWaterRatio }
              : {}),
            ...(contextBudget.semanticCompact.forceRatio !== undefined
              ? { forceRatio: contextBudget.semanticCompact.forceRatio }
              : {}),
            ...(contextBudget.semanticCompact.targetRatio !== undefined
              ? { targetRatio: contextBudget.semanticCompact.targetRatio }
              : {}),
            ...(contextBudget.semanticCompact.maxActiveEstimatedTokens !== undefined
              ? { maxActiveEstimatedTokens: contextBudget.semanticCompact.maxActiveEstimatedTokens }
              : {}),
            ...(contextBudget.semanticCompact.minRecentMessages !== undefined
              ? { minRecentMessages: contextBudget.semanticCompact.minRecentMessages }
              : {}),
            ...(contextBudget.semanticCompact.minRecentToolPairs !== undefined
              ? { minRecentToolPairs: contextBudget.semanticCompact.minRecentToolPairs }
              : {}),
            ...(contextBudget.semanticCompact.minSafePrefixEstimatedTokens !== undefined
              ? {
                  minSafePrefixEstimatedTokens:
                    contextBudget.semanticCompact.minSafePrefixEstimatedTokens,
                }
              : {}),
            ...(contextBudget.semanticCompact.minNewPrefixEstimatedTokens !== undefined
              ? {
                  minNewPrefixEstimatedTokens:
                    contextBudget.semanticCompact.minNewPrefixEstimatedTokens,
                }
              : {}),
            ...(contextBudget.semanticCompact.maxAcceptedProjectionEstimatedTokens !== undefined
              ? {
                  maxAcceptedProjectionEstimatedTokens:
                    contextBudget.semanticCompact.maxAcceptedProjectionEstimatedTokens,
                }
              : {}),
            ...(contextBudget.semanticCompact.maxSummaryEstimatedTokens !== undefined
              ? {
                  maxSummaryEstimatedTokens:
                    contextBudget.semanticCompact.maxSummaryEstimatedTokens,
                }
              : {}),
            ...(contextBudget.semanticCompact.minSavingsTokens !== undefined
              ? { minSavingsTokens: contextBudget.semanticCompact.minSavingsTokens }
              : {}),
            ...(contextBudget.semanticCompact.minSavingsRatio !== undefined
              ? { minSavingsRatio: contextBudget.semanticCompact.minSavingsRatio }
              : {}),
            ...(contextBudget.semanticCompact.minNetSavingsTokens !== undefined
              ? { minNetSavingsTokens: contextBudget.semanticCompact.minNetSavingsTokens }
              : {}),
            ...(contextBudget.semanticCompact.compactCallTokenCostWeight !== undefined
              ? {
                  compactCallTokenCostWeight:
                    contextBudget.semanticCompact.compactCallTokenCostWeight,
                }
              : {}),
            ...(contextBudget.semanticCompact.maxCompactCallTokens !== undefined
              ? { maxCompactCallTokens: contextBudget.semanticCompact.maxCompactCallTokens }
              : {}),
            ...(contextBudget.semanticCompact.maxConsecutiveInvalidSummaries !== undefined
              ? {
                  maxConsecutiveInvalidSummaries:
                    contextBudget.semanticCompact.maxConsecutiveInvalidSummaries,
                }
              : {}),
            ...(contextBudget.semanticCompact.invalidSummaryCooldownSteps !== undefined
              ? {
                  invalidSummaryCooldownSteps:
                    contextBudget.semanticCompact.invalidSummaryCooldownSteps,
                }
              : {}),
            ...(contextBudget.semanticCompact.timeoutMs !== undefined
              ? { timeoutMs: contextBudget.semanticCompact.timeoutMs }
              : {}),
            ...(contextBudget.semanticCompact.archiveRequired !== undefined
              ? { archiveRequired: contextBudget.semanticCompact.archiveRequired }
              : {}),
            ...(contextBudget.semanticCompact.summarizerModel
              ? { summarizerModel: contextBudget.semanticCompact.summarizerModel }
              : {}),
            ...(contextBudget.semanticCompact.promptVersion
              ? { promptVersion: contextBudget.semanticCompact.promptVersion }
              : {}),
            ...(contextBudget.semanticCompact.highWaterName
              ? { highWaterName: contextBudget.semanticCompact.highWaterName }
              : {}),
          },
        }
      : {}),
    ...(contextBudget.archiveRetrieval
      ? {
          archiveRetrieval: {
            enabled: contextBudget.archiveRetrieval.enabled,
            ...(contextBudget.archiveRetrieval.mode
              ? { mode: contextBudget.archiveRetrieval.mode }
              : {}),
            maxResults: contextBudget.archiveRetrieval.maxResults ?? 3,
            maxEstimatedTokens: contextBudget.archiveRetrieval.maxEstimatedTokens ?? 8192,
            maxBytes: contextBudget.archiveRetrieval.maxBytes ?? 1024 * 1024,
            order: 'newest_first',
          },
        }
      : {}),
    ...(contextBudget.synthesisCache
      ? {
          synthesisCache: {
            enabled: contextBudget.synthesisCache.enabled,
            ...(contextBudget.synthesisCache.mode
              ? { mode: contextBudget.synthesisCache.mode }
              : {}),
            maxBlocks: contextBudget.synthesisCache.maxBlocks ?? 1,
            maxEstimatedTokens: contextBudget.synthesisCache.maxEstimatedTokens ?? 2048,
            maxBlockEstimatedTokens: contextBudget.synthesisCache.maxBlockEstimatedTokens ?? 1024,
            ...(contextBudget.synthesisCache.invalidateOnNewToolResult !== undefined
              ? {
                  invalidateOnNewToolResult: contextBudget.synthesisCache.invalidateOnNewToolResult,
                }
              : {}),
            ...(contextBudget.synthesisCache.schemaVersion !== undefined
              ? { schemaVersion: contextBudget.synthesisCache.schemaVersion }
              : {}),
          },
        }
      : {}),
    minRecentTurns,
  };
}

function firstContextNonNegativeIntEnv(
  env: RunHarborCellEnv,
  names: readonly string[],
): number | undefined {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined) return contextNonNegativeIntEnv(raw, name);
  }
  return undefined;
}

function contextNonNegativeIntEnv(raw: string | undefined, name: string): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(value);
}

function archiveRetrievalModeEnv(
  raw: string | undefined,
): NonNullable<ContextBudgetPolicy['archiveRetrieval']>['mode'] | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value === 'eager' || value === 'history_search_gated') return value;
  throw new Error(
    `MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE must be one of eager, history_search_gated, got ${JSON.stringify(raw)}`,
  );
}

function activeFullCompactModeEnv(
  raw: string | undefined,
): NonNullable<ContextBudgetPolicy['activeFullCompact']>['mode'] | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (
    value === 'off' ||
    value === 'index_only' ||
    value === 'validate_only' ||
    value === 'prepare_step_dry_run'
  ) {
    return value;
  }
  throw new Error(
    `MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE must be one of off, index_only, validate_only, prepare_step_dry_run, got ${JSON.stringify(raw)}`,
  );
}

function semanticCompactModeEnv(
  raw: string | undefined,
): NonNullable<ContextBudgetPolicy['semanticCompact']>['mode'] | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (
    value === 'off' ||
    value === 'validate_only' ||
    value === 'prepare_step_dry_run' ||
    value === 'replace'
  ) {
    return value;
  }
  throw new Error(
    `MAKA_CONTEXT_SEMANTIC_COMPACT_MODE must be one of off, validate_only, prepare_step_dry_run, replace, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Sole authority for whether a cell archives tool results, and where. The whole
 * capability derives from it, so a cell can never archive into a directory it
 * cannot read back out of.
 */
function harborCellToolResultArchiveDir(env: RunHarborCellEnv): string | undefined {
  if (env.MAKA_CONTEXT_BUDGET === 'off') return undefined;
  return (
    env.MAKA_CONTEXT_TOOL_RESULT_ARCHIVE_DIR ??
    env.MAKA_TOOL_RESULT_ARCHIVE_DIR ??
    env.MAKA_HARBOR_TOOL_RESULT_ARCHIVE_DIR ??
    (env.MAKA_OUTPUT_DIR ? join(env.MAKA_OUTPUT_DIR, 'tool-result-archives') : undefined)
  );
}

// Two prefixes, separators, a full SHA-256, and `.json` total at most 153
// characters, within the runtime ref grammar's 160-character cap.
const HARBOR_CELL_ARCHIVE_ID_PREFIX_MAX_CHARS = 40;

function harborCellToolResultArchiveArtifactId(input: {
  sessionId: string;
  runtimeEventId: string;
  bodySha256: string;
}): string {
  const identityHash = createHash('sha256')
    .update(JSON.stringify([input.sessionId, input.runtimeEventId, input.bodySha256]))
    .digest('hex');
  return (
    [
      safeArtifactIdPrefix(input.sessionId),
      safeArtifactIdPrefix(input.runtimeEventId),
      identityHash,
    ].join('--') + '.json'
  );
}

function safeArtifactIdPrefix(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, HARBOR_CELL_ARCHIVE_ID_PREFIX_MAX_CHARS);
  return safe || 'unknown';
}

function isSafeHarborCellArchiveArtifactId(value: string): boolean {
  return /^[A-Za-z0-9_.=-]+\.json$/.test(value);
}

function isHarborCellToolResultArchiveRecord(
  value: unknown,
): value is HarborCellToolResultArchiveRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sessionId === 'string' &&
    typeof value.runtimeEventId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.bodySha256 === 'string' &&
    typeof value.originalEstimatedTokens === 'number' &&
    typeof value.originalBytes === 'number' &&
    typeof value.serializedResult === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
