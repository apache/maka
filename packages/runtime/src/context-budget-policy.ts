import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import { lookupModelMetadata } from '@maka/core/model-metadata';
import type { ContextBudgetPolicy } from './context-budget.js';

export interface BuildDefaultContextBudgetPolicyOptions {
  name?: string;
  env?: Record<string, string | undefined>;
  modelId?: string;
}

export function buildDefaultContextBudgetPolicy(
  connection: RuntimeExecutionConnection,
  options: BuildDefaultContextBudgetPolicyOptions = {},
): ContextBudgetPolicy | undefined {
  const env = options.env ?? process.env;
  if (env.MAKA_CONTEXT_BUDGET === 'off') return undefined;
  const contextWindow = resolveSelectedModelContextWindow(connection, options.modelId);
  const reserveTokens = defaultCompactReserveTokens(env, contextWindow);
  const maxHistoryEstimatedTokens =
    parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_BUDGET_TOKENS) ??
    defaultHistoryBudgetTokens(connection, contextWindow, reserveTokens);
  const maxHistoryTurns = parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_BUDGET_TURNS);
  const minRecentTurns = parsePositiveInt(env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2);
  const surfaceName = (options.name ?? 'default-history-budget').replace(
    /-default-history-budget$/,
    '',
  );
  const staleToolResultPrune = buildStaleToolResultPrunePolicy(env);
  const archiveRetrieval = buildArchiveRetrievalPolicy(env);
  const historySearch = buildHistorySearchPolicy(env);
  const synthesisCache = buildSynthesisCachePolicy(env);
  const historyCompact = buildHistoryCompactPolicy(
    env,
    `${surfaceName}-history-compact`,
    reserveTokens,
  );
  const historyRewrite = buildHistoryRewriteGatePolicy(env, `${surfaceName}-history-rewrite`);
  const semanticCompact = buildSemanticCompactPolicy(env, `${surfaceName}-semantic-compact`);
  const activeToolResultPrune = buildActiveToolResultPrunePolicy(env);
  if (
    maxHistoryEstimatedTokens === undefined &&
    maxHistoryTurns === undefined &&
    staleToolResultPrune === undefined &&
    archiveRetrieval === undefined &&
    historySearch === undefined &&
    synthesisCache === undefined &&
    historyCompact === undefined &&
    semanticCompact === undefined &&
    historyRewrite === undefined &&
    activeToolResultPrune === undefined
  ) {
    return undefined;
  }
  return {
    name: options.name ?? 'default-history-budget',
    ...(maxHistoryTurns !== undefined ? { maxHistoryTurns } : {}),
    ...(maxHistoryEstimatedTokens !== undefined ? { maxHistoryEstimatedTokens } : {}),
    ...(staleToolResultPrune !== undefined ? { staleToolResultPrune } : {}),
    ...(archiveRetrieval !== undefined ? { archiveRetrieval } : {}),
    ...(historySearch !== undefined ? { historySearch } : {}),
    ...(synthesisCache !== undefined ? { synthesisCache } : {}),
    ...(historyCompact !== undefined ? { historyCompact } : {}),
    ...(semanticCompact !== undefined ? { semanticCompact } : {}),
    ...(activeToolResultPrune !== undefined ? { activeToolResultPrune } : {}),
    ...(historyRewrite !== undefined ? { historyRewrite } : {}),
    minRecentTurns,
  };
}

export interface BuildManualCompactLookupPolicyOptions {
  highWaterName?: string;
}

// Overlay a bounded lookup-only historyCompact policy for manual compaction:
// replay loaded compact blocks but never synthesize fallback blocks, and cap
// the replayed history so a manual /compact cannot balloon the context. Keeps
// every compact default in one place so the CLI and desktop do not diverge.
export function buildManualCompactLookupPolicy(
  base: ContextBudgetPolicy | undefined,
  options: BuildManualCompactLookupPolicyOptions = {},
): ContextBudgetPolicy | undefined {
  if (!base) return undefined;
  const budgetedPolicy =
    base.maxHistoryEstimatedTokens === undefined
      ? { ...base, maxHistoryEstimatedTokens: 32_000 }
      : base;
  const current = budgetedPolicy.historyCompact;
  return {
    ...budgetedPolicy,
    historyCompact: {
      ...current,
      enabled: true,
      mode: 'lookup',
      highWaterRatio: 0.000001,
      tailEstimatedTokens: 1,
      minRecentTurns: current?.minRecentTurns ?? budgetedPolicy.minRecentTurns ?? 1,
      maxBlocks: current?.maxBlocks ?? 1,
      maxEstimatedTokens: current?.maxEstimatedTokens ?? 2_048,
      maxBlockEstimatedTokens: current?.maxBlockEstimatedTokens ?? 1_024,
      highWaterName: current?.highWaterName ?? options.highWaterName ?? 'manual-history-compact',
    },
  };
}

function buildStaleToolResultPrunePolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['staleToolResultPrune']> | undefined {
  const enabled = parseOptionalBoolean(
    env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE,
    'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE',
  );
  if (enabled === false) return undefined;
  return {
    enabled: true,
    maxResultEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS, 2048),
    minRecentTurnsFull: parsePositiveInt(
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS,
      parsePositiveInt(env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ),
  };
}

function buildActiveToolResultPrunePolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['activeToolResultPrune']> | undefined {
  const enabled = parseOptionalBoolean(
    env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE,
    'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  );
  if (enabled === false) return undefined;
  return {
    enabled: true,
    maxCurrentResultEstimatedTokens: parsePositiveInt(
      env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS,
      2048,
    ),
    minStepNumber:
      parseOptionalNonNegativeInt(env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER) ?? 1,
  };
}

function buildArchiveRetrievalPolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['archiveRetrieval']> | undefined {
  if (env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL !== 'on') return undefined;
  const mode = parseArchiveRetrievalMode(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE);
  return {
    enabled: true,
    ...(mode ? { mode } : {}),
    maxResults: parsePositiveInt(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS, 3),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS, 8192),
    maxBytes: parsePositiveInt(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES, 1024 * 1024),
    order: 'newest_first',
  };
}

function buildHistorySearchPolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['historySearch']> | undefined {
  if (env.MAKA_CONTEXT_HISTORY_SEARCH !== 'on') return undefined;
  return {
    enabled: true,
    maxResults: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_RESULTS, 5),
    around: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_SEARCH_AROUND, 1),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_TOKENS, 4096),
  };
}

function buildSynthesisCachePolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['synthesisCache']> | undefined {
  if (env.MAKA_CONTEXT_SYNTHESIS_CACHE !== 'on') return undefined;
  return {
    enabled: true,
    mode: parseSynthesisCacheMode(env.MAKA_CONTEXT_SYNTHESIS_CACHE_MODE),
    maxBlocks: parsePositiveInt(env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS, 1),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS, 2048),
    maxBlockEstimatedTokens: parsePositiveInt(
      env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS,
      1024,
    ),
    invalidateOnNewToolResult: true,
    schemaVersion: 1,
  };
}

function buildHistoryCompactPolicy(
  env: Record<string, string | undefined>,
  defaultHighWaterName: string,
  reserveTokens: number,
): NonNullable<ContextBudgetPolicy['historyCompact']> | undefined {
  const enabled = parseOptionalBoolean(
    env.MAKA_CONTEXT_HISTORY_COMPACT,
    'MAKA_CONTEXT_HISTORY_COMPACT',
  );
  if (enabled === false) return undefined;
  const highWaterRatio = parseOptionalRatio(env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_RATIO);
  const forceRatio = parseOptionalRatio(env.MAKA_CONTEXT_HISTORY_COMPACT_FORCE_RATIO);
  const targetRatio = parseOptionalRatio(env.MAKA_CONTEXT_HISTORY_COMPACT_TARGET_RATIO);
  const tailEstimatedTokens = parseOptionalPositiveInt(
    env.MAKA_CONTEXT_HISTORY_COMPACT_TAIL_TOKENS,
  );
  const minRecentTurns = parseOptionalPositiveInt(
    env.MAKA_CONTEXT_HISTORY_COMPACT_MIN_RECENT_TURNS,
  );
  const maxSummaryEstimatedTokens = parseOptionalPositiveInt(
    env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_SUMMARY_TOKENS,
  );
  const midTurn = buildHistoryCompactMidTurnPolicy(env, reserveTokens);
  return {
    enabled: true,
    mode: parseHistoryCompactMode(env.MAKA_CONTEXT_HISTORY_COMPACT_MODE),
    highWaterRatio: highWaterRatio ?? 1,
    ...(forceRatio !== undefined ? { forceRatio } : {}),
    ...(targetRatio !== undefined ? { targetRatio } : {}),
    tailEstimatedTokens: tailEstimatedTokens ?? 16_384,
    minRecentTurns: minRecentTurns ?? 3,
    ...(maxSummaryEstimatedTokens !== undefined ? { maxSummaryEstimatedTokens } : {}),
    maxBlocks: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCKS, 1),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_TOKENS, 2048),
    maxBlockEstimatedTokens: parsePositiveInt(
      env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCK_TOKENS,
      1024,
    ),
    highWaterName: env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_NAME ?? defaultHighWaterName,
    ...(midTurn !== undefined ? { midTurn } : {}),
  };
}

// Mid-turn capacity compaction is a runtime-owned default (issue #882 PR 3):
// whenever history compaction is enabled, the runtime derives midTurn from the
// selected model's window (`contextWindow - reserveTokens`, the same reserve as
// the turn-boundary budget) so every surface inherits the invariant without
// copying config. `MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN=off` stays as the
// explicit escape hatch. The backend still gates activation on the checkpoint
// seams, the persisted head anchor, and a KNOWN context window, so a session
// without model metadata (or a child with no anchor seam) never misfires even
// though the default is on.
function buildHistoryCompactMidTurnPolicy(
  env: Record<string, string | undefined>,
  reserveTokens: number,
): NonNullable<NonNullable<ContextBudgetPolicy['historyCompact']>['midTurn']> | undefined {
  const enabled = parseOptionalBoolean(
    env.MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN,
    'MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN',
  );
  if (enabled === false) return undefined;
  const reserveTailEvents = parseOptionalNonNegativeInt(
    env.MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN_TAIL_EVENTS,
  );
  return {
    enabled: true,
    reserveTokens,
    ...(reserveTailEvents !== undefined ? { reserveTailEvents } : {}),
  };
}

function buildHistoryRewriteGatePolicy(
  env: Record<string, string | undefined>,
  defaultName: string,
): NonNullable<ContextBudgetPolicy['historyRewrite']> | undefined {
  if (env.MAKA_CONTEXT_HISTORY_REWRITE !== 'on') return undefined;
  return {
    enabled: true,
    name: env.MAKA_CONTEXT_HISTORY_REWRITE_NAME ?? defaultName,
    historyRewriteVersion: env.MAKA_CONTEXT_HISTORY_REWRITE_VERSION ?? 'phase6-v1',
    resetReason:
      env.MAKA_CONTEXT_HISTORY_REWRITE_RESET_REASON ?? 'operator_enabled_history_rewrite_gate',
  };
}

// Semantic compaction is the #981/#986 attention-first experiment, distinct
// from the standard historyCompact mechanism. It defaults OFF and is opt-in per
// surface (issue #882 PR 3): an explicit MAKA_CONTEXT_SEMANTIC_COMPACT truthy
// value, or a MAKA_CONTEXT_SEMANTIC_COMPACT_MODE other than `off`, turns it on.
// This keeps the experiment out of every surface's default budget without each
// surface stripping it locally.
function buildSemanticCompactPolicy(
  env: Record<string, string | undefined>,
  defaultHighWaterName: string,
): NonNullable<ContextBudgetPolicy['semanticCompact']> | undefined {
  const enabled = parseOptionalBoolean(
    env.MAKA_CONTEXT_SEMANTIC_COMPACT,
    'MAKA_CONTEXT_SEMANTIC_COMPACT',
  );
  if (enabled === false) return undefined;
  const mode = parseSemanticCompactMode(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODE);
  if (mode === 'off') return undefined;
  // Default off: require an explicit opt-in (the boolean flag or an explicit
  // non-off mode). Neither present means the experiment stays out of the budget.
  if (enabled !== true && mode === undefined) return undefined;
  const archiveRequired = parseOptionalBoolean(
    env.MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED,
    'MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED',
  );
  return {
    enabled: true,
    mode: mode ?? 'replace',
    minStepNumber:
      parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER) ?? 2,
    // Attention compaction stays dormant through the first 128K estimated
    // provider tokens. The completed-span thresholds below only apply after
    // this high-water has been crossed.
    highWaterRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO) ?? 1,
    forceRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_FORCE_RATIO),
    targetRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_TARGET_RATIO),
    maxActiveEstimatedTokens:
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS) ??
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ESTIMATED_TOKENS) ??
      131_072,
    ...(parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES) !==
    undefined
      ? {
          minRecentMessages: parseOptionalNonNegativeInt(
            env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES,
          ),
        }
      : {}),
    ...(parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS) !==
    undefined
      ? {
          minRecentToolPairs: parseOptionalNonNegativeInt(
            env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS,
          ),
        }
      : {}),
    minSafePrefixEstimatedTokens:
      parseOptionalPositiveInt(
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAFE_PREFIX_ESTIMATED_TOKENS,
      ) ?? 4_096,
    minNewPrefixEstimatedTokens:
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NEW_PREFIX_ESTIMATED_TOKENS) ??
      4_096,
    maxAcceptedProjectionEstimatedTokens:
      parseOptionalPositiveInt(
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACCEPTED_PROJECTION_ESTIMATED_TOKENS,
      ) ??
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS) ??
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS) ??
      768,
    ...(parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS) !==
    undefined
      ? {
          maxSummaryEstimatedTokens: parseOptionalPositiveInt(
            env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS,
          ),
        }
      : {}),
    minSavingsTokens:
      parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS) ?? 256,
    minSavingsRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO),
    minNetSavingsTokens:
      parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS) ?? 256,
    compactCallTokenCostWeight: parseOptionalNonNegativeNumber(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT,
    ),
    maxCompactCallTokens:
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS) ?? 4096,
    maxConsecutiveInvalidSummaries:
      parseOptionalNonNegativeInt(
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES,
      ) ?? 2,
    invalidSummaryCooldownSteps:
      parseOptionalNonNegativeInt(
        env.MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS,
      ) ?? 8,
    timeoutMs: parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS),
    ...(archiveRequired !== undefined ? { archiveRequired } : {}),
    ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL
      ? { summarizerModel: env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL }
      : {}),
    ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION
      ? { promptVersion: env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION }
      : {}),
    highWaterName: env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME ?? defaultHighWaterName,
  };
}

// Single owner of the compaction reserve default. The classic 16384 reserve
// assumed large-window models; on an 8K window it derived a 1-token history
// budget and a 1-token mid_turn high water — every multi-step turn ran the
// summarizer for a checkpoint the replay gate could never admit. The default
// is therefore bounded by the KNOWN window (a quarter of it, capped at 16384;
// peers bound the same way: opencode caps its buffer by the model's output
// limit, gemini-cli triggers at a window fraction). An explicit
// MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS is respected verbatim, and an
// unknown window keeps the classic constant.
function defaultCompactReserveTokens(
  env: Record<string, string | undefined>,
  contextWindow: number | undefined,
): number {
  const explicit = parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS);
  if (explicit !== undefined) return explicit;
  if (contextWindow === undefined) return 16_384;
  return Math.min(16_384, Math.max(1, Math.floor(contextWindow / 4)));
}

function defaultHistoryBudgetTokens(
  connection: RuntimeExecutionConnection,
  contextWindow: number | undefined,
  reserveTokens: number,
): number | undefined {
  if (contextWindow !== undefined) {
    return Math.max(1, contextWindow - reserveTokens);
  }
  if (connection.providerType === 'deepseek') return undefined;
  return 32_000;
}

export function resolveSelectedModelContextWindow(
  connection: RuntimeExecutionConnection,
  modelId: string | undefined,
): number | undefined {
  const selectedModelId = modelId ?? connection.defaultModel;
  const model = selectedModelId
    ? connection.models?.find((candidate) => candidate.id === selectedModelId)
    : undefined;
  return (
    model?.contextWindow ??
    (selectedModelId
      ? lookupModelMetadata(connection.providerType, selectedModelId).contextWindow
      : undefined)
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseOptionalPositiveInt(value);
  return parsed ?? fallback;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalNonNegativeNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalRatio(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(1, parsed) : undefined;
}

function parseSynthesisCacheMode(value: string | undefined): 'lookup' | 'read_write' {
  return value === 'read_write' ? 'read_write' : 'lookup';
}

function parseHistoryCompactMode(
  value: string | undefined,
): NonNullable<ContextBudgetPolicy['historyCompact']>['mode'] {
  if (value === 'lookup' || value === 'read_write' || value === 'deterministic') return value;
  return 'read_write';
}

function parseSemanticCompactMode(
  value: string | undefined,
): NonNullable<ContextBudgetPolicy['semanticCompact']>['mode'] | undefined {
  if (!value) return undefined;
  if (
    value === 'off' ||
    value === 'validate_only' ||
    value === 'prepare_step_dry_run' ||
    value === 'replace'
  )
    return value;
  return undefined;
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  switch (normalized) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return false;
    default:
      throw new Error(`${name} must be a boolean, got ${JSON.stringify(value)}`);
  }
}

function parseArchiveRetrievalMode(
  value: string | undefined,
): NonNullable<ContextBudgetPolicy['archiveRetrieval']>['mode'] | undefined {
  return value === 'history_search_gated' || value === 'eager' ? value : undefined;
}
