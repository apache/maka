import type { RuntimeEvent } from '@maka/core';
import type { ThinkingLevel } from '@maka/core';
import type { ContextBudgetPolicy, InvocationResult } from '@maka/runtime';
import type { HeadlessSystemPromptMode } from './contracts.js';

export const HARBOR_CELL_OUTPUT_SCHEMA_VERSION = 1;

export interface HarborCellTokenSummary {
  input: number;
  output: number;
  cachedInput: number;
  cacheHitInput: number;
  cacheMissInput: number;
  cacheWriteInput: number;
  cacheMissInputSource?: 'explicit' | 'derived';
  reasoning: number;
  total: number;
  costUsd: number;
  pricingSource: 'runtime';
}

/** Prefer a child-inclusive cumulative checkpoint only when it safely extends
 * every counter in an existing final summary; a larger total alone is insufficient. */
export function selectHarborCellTokenSummary(
  current: HarborCellTokenSummary | undefined,
  checkpoint: HarborCellTokenSummary | null,
): HarborCellTokenSummary | undefined {
  if (!checkpoint) return current;
  if (!current) return checkpoint;
  if (
    !isConsistentCumulativeTokenSummary(current) ||
    !isConsistentCumulativeTokenSummary(checkpoint)
  ) {
    return current;
  }
  if (
    current.cacheMissInputSource === 'explicit' &&
    checkpoint.cacheMissInputSource !== 'explicit'
  ) {
    return current;
  }
  const currentCounts = [
    current.input,
    current.output,
    current.cachedInput,
    current.cacheHitInput,
    current.cacheMissInput,
    current.cacheWriteInput,
    current.reasoning,
    current.total,
    current.costUsd,
  ];
  const checkpointCounts = [
    checkpoint.input,
    checkpoint.output,
    checkpoint.cachedInput,
    checkpoint.cacheHitInput,
    checkpoint.cacheMissInput,
    checkpoint.cacheWriteInput,
    checkpoint.reasoning,
    checkpoint.total,
    checkpoint.costUsd,
  ];
  return checkpointCounts.every((value, index) => value >= currentCounts[index]!) &&
    checkpointCounts.some((value, index) => value > currentCounts[index]!)
    ? checkpoint
    : current;
}

function isConsistentCumulativeTokenSummary(summary: HarborCellTokenSummary): boolean {
  const counts = [
    summary.input,
    summary.output,
    summary.cachedInput,
    summary.cacheHitInput,
    summary.cacheMissInput,
    summary.cacheWriteInput,
    summary.reasoning,
    summary.total,
    summary.costUsd,
  ];
  return (
    counts.every((value) => Number.isFinite(value) && value >= 0) &&
    summary.cachedInput === summary.cacheHitInput &&
    summary.input === summary.cacheHitInput + summary.cacheMissInput + summary.cacheWriteInput &&
    summary.total === summary.input + summary.output &&
    summary.reasoning <= summary.output
  );
}

export interface HarborCellContextBudgetSummary {
  diagnosticEvents: number;
  enabledEvents: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  keptTurns: number;
  droppedTurns: number;
  keptEvents: number;
  droppedEvents: number;
  prunedToolResults: number;
  activePrunedToolResults: number;
  activeEstimatedTokensSaved: number;
  activeArchiveFailures: number;
  archivePlaceholders: number;
  archivePlaceholderReasonCounts: Record<string, number>;
  archiveWriteFailures: number;
  retrievedArchiveToolResults: number;
  retrievedArchiveEstimatedTokens: number;
  archiveRetrievalSkipped: number;
  archiveRetrievalSkippedReasonCounts: Record<string, number>;
  archiveRetrievalFailures: number;
  archiveRetrievalFailureReasonCounts: Record<string, number>;
  semanticCompactCallInputTokens: number;
  semanticCompactCallOutputTokens: number;
  semanticCompactCallCacheReadInputTokens: number;
  semanticCompactCallCacheWriteInputTokens: number;
  semanticCompactCallTotalTokens: number;
}

export type HarborCellContextBudgetPolicySnapshot =
  | { enabled: false }
  | ({ enabled: true } & ContextBudgetPolicy);

export interface HarborCellRuntimeRefs {
  invocationId: string;
  sessionId: string;
  runId: string;
  turnId: string;
}

export interface HarborCellExecutionIdentity {
  llmConnectionSlug: string;
  model: string;
  reasoningEffort?: ThinkingLevel;
  /** Present on artifacts written after prompt-source auditing was introduced. */
  systemPromptMode?: HeadlessSystemPromptMode;
  systemPromptHash: string;
  pricingProfile: string;
  /** Present on artifacts written after Headless Agent tool gating was introduced. */
  agentTools?: boolean;
}

export interface HarborCellDeadlineSettlement {
  source: 'benchmark.deadline';
  mode: 'immediate';
}

export interface HarborCellContinuationSummary {
  enabled: boolean;
  maxTurns: number;
  maxTotalRuntimeSteps: number;
  turnsUsed: number;
  continuedTurns: number;
  stepCapHits: number;
  capExhausted: boolean;
  totalRuntimeSteps: number;
  turns: HarborCellContinuationTurnSummary[];
}

export interface HarborCellContinuationTurnSummary {
  turnIndex: number;
  status: 'completed' | 'failed';
  stepCapHit: boolean;
  runtimeSteps: number;
}

export interface HarborCellToolSummary {
  providerVisibleToolCount: number;
  actualToolCalls: number;
  actualToolNames: string[];
  actualToolCallCounts: Record<string, number>;
}

export interface HarborCellTaskToolSummary {
  todoWriteCalls: number;
}

export interface HarborCellOutput {
  schemaVersion: typeof HARBOR_CELL_OUTPUT_SCHEMA_VERSION;
  status: InvocationResult['status'];
  errorClass?: string;
  runtimeEventsPath: string;
  promptHash?: string;
  executionIdentity?: HarborCellExecutionIdentity;
  deadlineSettlement?: HarborCellDeadlineSettlement;
  tokenSummary?: HarborCellTokenSummary;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  contextBudgetSummary?: HarborCellContextBudgetSummary;
  continuationSummary?: HarborCellContinuationSummary;
  toolSummary: HarborCellToolSummary;
  taskToolSummary?: HarborCellTaskToolSummary;
  steps: number;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  runtimeRefs: HarborCellRuntimeRefs;
}

export function buildHarborCellOutput(input: {
  invocation: InvocationResult;
  runtimeEventsPath: string;
  promptHash?: string;
  executionIdentity?: HarborCellExecutionIdentity;
  deadlineSettlement?: HarborCellDeadlineSettlement;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummaryEnabled?: boolean;
}): HarborCellOutput {
  const { invocation } = input;
  const tokenSummary = summarizeCellTokens(invocation.events);
  const promptHash = input.promptHash ?? promptHashField(invocation.events).promptHash;
  return {
    schemaVersion: HARBOR_CELL_OUTPUT_SCHEMA_VERSION,
    status: invocation.status,
    ...(invocation.failure?.class ? { errorClass: invocation.failure.class } : {}),
    runtimeEventsPath: input.runtimeEventsPath,
    ...(promptHash ? { promptHash } : {}),
    ...(input.executionIdentity ? { executionIdentity: input.executionIdentity } : {}),
    ...(input.deadlineSettlement ? { deadlineSettlement: input.deadlineSettlement } : {}),
    ...(tokenSummary ? { tokenSummary } : {}),
    ...(input.contextBudgetPolicy ? { contextBudgetPolicy: input.contextBudgetPolicy } : {}),
    ...contextBudgetSummaryField(invocation.events),
    ...(input.continuationSummary ? { continuationSummary: input.continuationSummary } : {}),
    toolSummary: summarizeCellTools(invocation.events),
    ...taskToolSummaryField(invocation.events, input.taskToolSummaryEnabled ?? false),
    steps: countRuntimeSteps(invocation.events),
    durationMs: invocation.finishedAt - invocation.startedAt,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    runtimeRefs: {
      invocationId: invocation.invocationId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
    },
  };
}

export function combineInvocations(invocations: readonly InvocationResult[]): InvocationResult {
  const first = invocations[0];
  const last = invocations[invocations.length - 1];
  if (!first || !last) throw new Error('cannot combine empty Harbor invocations');
  return {
    invocationId: last.invocationId,
    sessionId: last.sessionId,
    runId: last.runId,
    turnId: last.turnId,
    status: last.status,
    ...(last.failure ? { failure: last.failure } : {}),
    events: invocations.flatMap((candidate) => candidate.events),
    startedAt: first.startedAt,
    finishedAt: last.finishedAt,
  };
}

export function countRuntimeSteps(events: readonly RuntimeEvent[]): number {
  const turns = new Map<
    string,
    { reported: number; stepIds: Set<string>; legacyTextSteps: number }
  >();
  for (const event of events) {
    const turn = turns.get(event.turnId) ?? {
      reported: 0,
      stepIds: new Set<string>(),
      legacyTextSteps: 0,
    };
    turn.reported += event.actions?.tokenUsage?.runtimeSteps ?? 0;
    turns.set(event.turnId, turn);
    if (event.role !== 'model' || event.partial === true) continue;
    const stepId = event.refs?.stepId ?? event.refs?.providerEventId;
    if (stepId) {
      turn.stepIds.add(stepId);
    } else if (event.content?.kind === 'text') {
      turn.legacyTextSteps += 1;
    }
  }
  return [...turns.values()].reduce(
    (sum, turn) =>
      sum + (turn.reported > 0 ? turn.reported : turn.stepIds.size + turn.legacyTextSteps),
    0,
  );
}

export function validateHarborCellOutput(value: unknown): HarborCellOutput {
  if (!isRecord(value)) {
    throw new Error('Harbor cell output must be a JSON object');
  }
  const schemaVersion = requireNumber(value.schemaVersion, 'schemaVersion');
  if (value.schemaVersion !== HARBOR_CELL_OUTPUT_SCHEMA_VERSION) {
    throw new Error(`unsupported Harbor cell output schemaVersion: ${value.schemaVersion}`);
  }
  const status = requireStringUnion(value.status, 'status', ['completed', 'failed'] as const);
  const errorClass =
    'errorClass' in value ? requireOptionalString(value.errorClass, 'errorClass') : undefined;
  const runtimeEventsPath = requireString(value.runtimeEventsPath, 'runtimeEventsPath');
  const promptHash =
    'promptHash' in value ? requireOptionalString(value.promptHash, 'promptHash') : undefined;
  const executionIdentity =
    'executionIdentity' in value
      ? validateHarborCellExecutionIdentity(value.executionIdentity)
      : undefined;
  const deadlineSettlement =
    'deadlineSettlement' in value
      ? validateHarborCellDeadlineSettlement(value.deadlineSettlement)
      : undefined;
  const tokenSummary =
    'tokenSummary' in value ? validateHarborCellTokenSummary(value.tokenSummary) : undefined;
  const contextBudgetPolicy =
    'contextBudgetPolicy' in value
      ? validateContextBudgetPolicySnapshot(value.contextBudgetPolicy)
      : undefined;
  const contextBudgetSummary =
    'contextBudgetSummary' in value
      ? validateContextBudgetSummary(value.contextBudgetSummary)
      : undefined;
  const continuationSummary =
    'continuationSummary' in value
      ? validateContinuationSummary(value.continuationSummary)
      : undefined;
  const toolSummary = validateToolSummary(value.toolSummary);
  const taskToolSummary =
    'taskToolSummary' in value ? validateTaskToolSummary(value.taskToolSummary) : undefined;
  const steps = requireNumber(value.steps, 'steps');
  const durationMs = requireNumber(value.durationMs, 'durationMs');
  const startedAt = requireNumber(value.startedAt, 'startedAt');
  const finishedAt = requireNumber(value.finishedAt, 'finishedAt');
  const runtimeRefs = validateRuntimeRefs(value.runtimeRefs);
  const output: HarborCellOutput = {
    schemaVersion: schemaVersion as typeof HARBOR_CELL_OUTPUT_SCHEMA_VERSION,
    status,
    ...(errorClass !== undefined ? { errorClass } : {}),
    runtimeEventsPath,
    ...(promptHash !== undefined ? { promptHash } : {}),
    ...(executionIdentity !== undefined ? { executionIdentity } : {}),
    ...(deadlineSettlement !== undefined ? { deadlineSettlement } : {}),
    ...(tokenSummary ? { tokenSummary } : {}),
    ...(contextBudgetPolicy !== undefined ? { contextBudgetPolicy } : {}),
    ...(contextBudgetSummary !== undefined ? { contextBudgetSummary } : {}),
    ...(continuationSummary !== undefined ? { continuationSummary } : {}),
    toolSummary,
    ...(taskToolSummary !== undefined ? { taskToolSummary } : {}),
    steps,
    durationMs,
    startedAt,
    finishedAt,
    runtimeRefs,
  };
  return output;
}

function validateHarborCellDeadlineSettlement(value: unknown): HarborCellDeadlineSettlement {
  if (!isRecord(value)) throw new Error('deadlineSettlement must be a JSON object');
  return {
    source: requireStringUnion(value.source, 'deadlineSettlement.source', [
      'benchmark.deadline',
    ] as const),
    mode: requireStringUnion(value.mode, 'deadlineSettlement.mode', ['immediate'] as const),
  };
}

export function validateHarborCellExecutionIdentity(value: unknown): HarborCellExecutionIdentity {
  if (!isRecord(value)) throw new Error('executionIdentity must be a JSON object');
  return {
    llmConnectionSlug: requireString(
      value.llmConnectionSlug,
      'executionIdentity.llmConnectionSlug',
    ),
    model: requireString(value.model, 'executionIdentity.model'),
    ...('reasoningEffort' in value
      ? {
          reasoningEffort: requireThinkingLevel(
            value.reasoningEffort,
            'executionIdentity.reasoningEffort',
          ),
        }
      : {}),
    ...('systemPromptMode' in value
      ? {
          systemPromptMode: requireStringUnion(
            value.systemPromptMode,
            'executionIdentity.systemPromptMode',
            ['default', 'custom'] as const,
          ),
        }
      : {}),
    systemPromptHash: requireString(value.systemPromptHash, 'executionIdentity.systemPromptHash'),
    pricingProfile: requireString(value.pricingProfile, 'executionIdentity.pricingProfile'),
    ...('agentTools' in value
      ? { agentTools: requireBoolean(value.agentTools, 'executionIdentity.agentTools') }
      : {}),
  };
}

function requireThinkingLevel(value: unknown, path: string): ThinkingLevel {
  const levels: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const parsed = requireString(value, path);
  if (!levels.includes(parsed)) throw new Error(`${path} must be a supported reasoning effort`);
  return parsed as ThinkingLevel;
}

export function summarizeCellTaskTools(events: readonly RuntimeEvent[]): HarborCellTaskToolSummary {
  const summary: HarborCellTaskToolSummary = {
    todoWriteCalls: 0,
  };
  for (const event of events) {
    if (event.content?.kind !== 'function_call') continue;
    const name = event.content.name;
    if (name !== 'todo_write') continue;
    summary.todoWriteCalls += 1;
  }
  return summary;
}

function validateContinuationSummary(value: unknown): HarborCellContinuationSummary {
  if (!isRecord(value)) throw new Error('continuationSummary must be a JSON object');
  return {
    enabled: requireBoolean(value.enabled, 'continuationSummary.enabled'),
    maxTurns: requireNumber(value.maxTurns, 'continuationSummary.maxTurns'),
    maxTotalRuntimeSteps: requireNumber(
      value.maxTotalRuntimeSteps,
      'continuationSummary.maxTotalRuntimeSteps',
    ),
    turnsUsed: requireNumber(value.turnsUsed, 'continuationSummary.turnsUsed'),
    continuedTurns: requireNumber(value.continuedTurns, 'continuationSummary.continuedTurns'),
    stepCapHits: requireNumber(value.stepCapHits, 'continuationSummary.stepCapHits'),
    capExhausted: requireBoolean(value.capExhausted, 'continuationSummary.capExhausted'),
    totalRuntimeSteps: requireNumber(
      value.totalRuntimeSteps,
      'continuationSummary.totalRuntimeSteps',
    ),
    turns: requireContinuationTurns(value.turns),
  };
}

function requireContinuationTurns(value: unknown): HarborCellContinuationTurnSummary[] {
  if (!Array.isArray(value)) throw new Error('continuationSummary.turns must be a JSON array');
  return value.map((turn, index) => {
    if (!isRecord(turn))
      throw new Error(`continuationSummary.turns[${index}] must be a JSON object`);
    return {
      turnIndex: requireNumber(turn.turnIndex, `continuationSummary.turns[${index}].turnIndex`),
      status: requireStringUnion(turn.status, `continuationSummary.turns[${index}].status`, [
        'completed',
        'failed',
      ] as const),
      stepCapHit: requireBoolean(turn.stepCapHit, `continuationSummary.turns[${index}].stepCapHit`),
      runtimeSteps: requireNumber(
        turn.runtimeSteps,
        `continuationSummary.turns[${index}].runtimeSteps`,
      ),
    };
  });
}

export function summarizeCellTokens(
  events: readonly RuntimeEvent[],
): HarborCellTokenSummary | undefined {
  const summary: HarborCellTokenSummary = {
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheHitInput: 0,
    cacheMissInput: 0,
    cacheWriteInput: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
    pricingSource: 'runtime',
  };
  let sawExplicitCacheMiss = false;
  let sawDerivedCacheMiss = false;
  let sawUsage = false;
  for (const event of events) {
    const usage = event.actions?.tokenUsage;
    if (!usage) continue;
    sawUsage = true;
    summary.input += usage.input ?? 0;
    summary.output += usage.output ?? 0;
    const cacheHitInput = usage.cacheHitInput ?? usage.cacheRead ?? 0;
    const cacheWriteInput = usage.cacheWriteInput ?? usage.cacheCreation ?? 0;
    const derivedCacheMiss = Math.max(0, (usage.input ?? 0) - cacheHitInput - cacheWriteInput);
    summary.cacheHitInput += cacheHitInput;
    summary.cachedInput += cacheHitInput;
    summary.cacheMissInput += usage.cacheMissInput ?? derivedCacheMiss;
    summary.cacheWriteInput += cacheWriteInput;
    if (usage.cacheMissInputSource === 'explicit' || usage.cacheMissInput !== undefined) {
      sawExplicitCacheMiss = true;
    } else if (
      usage.input !== undefined ||
      usage.cacheHitInput !== undefined ||
      usage.cacheRead !== undefined ||
      cacheWriteInput > 0
    ) {
      sawDerivedCacheMiss = true;
    }
    summary.reasoning += usage.reasoning ?? 0;
    summary.total +=
      usage.total ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0);
    summary.costUsd += usage.costUsd ?? 0;
  }
  if (!sawUsage) return undefined;
  if (sawExplicitCacheMiss) {
    summary.cacheMissInputSource = 'explicit';
  } else if (sawDerivedCacheMiss) {
    summary.cacheMissInputSource = 'derived';
  }
  return summary;
}

export function summarizeCellTools(events: readonly RuntimeEvent[]): HarborCellToolSummary {
  const counts = new Map<string, number>();
  let providerVisibleToolCount = 0;
  for (const event of events) {
    const content = event.content;
    if (content?.kind === 'function_call') {
      counts.set(content.name, (counts.get(content.name) ?? 0) + 1);
    }
    const promptSegments = event.actions?.tokenUsage?.promptSegments;
    if (promptSegments) {
      for (const segment of promptSegments) {
        if (segment.kind === 'tool_schema' && typeof segment.toolCount === 'number') {
          providerVisibleToolCount = Math.max(providerVisibleToolCount, segment.toolCount);
        }
      }
    }
  }
  const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    providerVisibleToolCount,
    actualToolCalls: sorted.reduce((sum, [, count]) => sum + count, 0),
    actualToolNames: sorted.map(([name]) => name),
    actualToolCallCounts: Object.fromEntries(sorted),
  };
}

export function summarizeCellContextBudget(
  events: readonly RuntimeEvent[],
): HarborCellContextBudgetSummary | undefined {
  const summary: HarborCellContextBudgetSummary = {
    diagnosticEvents: 0,
    enabledEvents: 0,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    keptTurns: 0,
    droppedTurns: 0,
    keptEvents: 0,
    droppedEvents: 0,
    prunedToolResults: 0,
    activePrunedToolResults: 0,
    activeEstimatedTokensSaved: 0,
    activeArchiveFailures: 0,
    archivePlaceholders: 0,
    archivePlaceholderReasonCounts: {},
    archiveWriteFailures: 0,
    retrievedArchiveToolResults: 0,
    retrievedArchiveEstimatedTokens: 0,
    archiveRetrievalSkipped: 0,
    archiveRetrievalSkippedReasonCounts: {},
    archiveRetrievalFailures: 0,
    archiveRetrievalFailureReasonCounts: {},
    semanticCompactCallInputTokens: 0,
    semanticCompactCallOutputTokens: 0,
    semanticCompactCallCacheReadInputTokens: 0,
    semanticCompactCallCacheWriteInputTokens: 0,
    semanticCompactCallTotalTokens: 0,
  };

  for (const event of events) {
    const diagnostic = event.actions?.tokenUsage?.contextBudget;
    if (!diagnostic) continue;
    summary.diagnosticEvents += 1;
    if (diagnostic.enabled) summary.enabledEvents += 1;
    summary.estimatedTokensBefore += diagnostic.estimatedTokensBefore;
    summary.estimatedTokensAfter += diagnostic.estimatedTokensAfter;
    summary.keptTurns += diagnostic.keptTurns;
    summary.droppedTurns += diagnostic.droppedTurns;
    summary.keptEvents += diagnostic.keptEvents;
    summary.droppedEvents += diagnostic.droppedEvents;
    summary.prunedToolResults += diagnostic.prunedToolResults ?? 0;
    summary.activePrunedToolResults += diagnostic.activePrunedToolResults ?? 0;
    summary.activeEstimatedTokensSaved += diagnostic.activeEstimatedTokensSaved ?? 0;
    summary.activeArchiveFailures += diagnostic.activeArchiveFailures ?? 0;
    summary.archivePlaceholders += diagnostic.archivePlaceholders ?? 0;
    mergeCountRecord(
      summary.archivePlaceholderReasonCounts,
      diagnostic.archivePlaceholderReasonCounts,
    );
    summary.archiveWriteFailures += diagnostic.archiveWriteFailures ?? 0;
    summary.retrievedArchiveToolResults += diagnostic.retrievedArchiveToolResults ?? 0;
    summary.retrievedArchiveEstimatedTokens += diagnostic.retrievedArchiveEstimatedTokens ?? 0;
    summary.archiveRetrievalSkipped += diagnostic.archiveRetrievalSkipped ?? 0;
    mergeCountRecord(
      summary.archiveRetrievalSkippedReasonCounts,
      diagnostic.archiveRetrievalSkippedReasonCounts,
    );
    summary.archiveRetrievalFailures += diagnostic.archiveRetrievalFailures ?? 0;
    mergeCountRecord(
      summary.archiveRetrievalFailureReasonCounts,
      diagnostic.archiveRetrievalFailureReasonCounts,
    );
    for (const decision of diagnostic.compactionDecisions ?? []) {
      if (decision.boundaryKind !== 'semanticCompact') continue;
      summary.semanticCompactCallInputTokens += decision.compactCallInputTokens ?? 0;
      summary.semanticCompactCallOutputTokens += decision.compactCallOutputTokens ?? 0;
      summary.semanticCompactCallCacheReadInputTokens +=
        decision.compactCallCacheReadInputTokens ?? 0;
      summary.semanticCompactCallCacheWriteInputTokens +=
        decision.compactCallCacheWriteInputTokens ?? 0;
      summary.semanticCompactCallTotalTokens += decision.compactCallTotalTokens ?? 0;
    }
  }

  return summary.diagnosticEvents > 0 ? summary : undefined;
}

function promptHashField(events: readonly RuntimeEvent[]): Pick<HarborCellOutput, 'promptHash'> {
  for (const event of events) {
    const hash = event.actions?.tokenUsage?.systemPromptHash;
    if (hash) return { promptHash: hash };
  }
  return {};
}

function contextBudgetSummaryField(
  events: readonly RuntimeEvent[],
): Pick<HarborCellOutput, 'contextBudgetSummary'> {
  const contextBudgetSummary = summarizeCellContextBudget(events);
  return contextBudgetSummary ? { contextBudgetSummary } : {};
}

function taskToolSummaryField(
  events: readonly RuntimeEvent[],
  enabled: boolean,
): Pick<HarborCellOutput, 'taskToolSummary'> {
  const taskToolSummary = summarizeCellTaskTools(events);
  return enabled || taskToolSummary.todoWriteCalls > 0 ? { taskToolSummary } : {};
}

export function validateHarborCellTokenSummary(value: unknown): HarborCellTokenSummary {
  if (!isRecord(value)) throw new Error('tokenSummary must be a JSON object');
  return {
    input: requireNumber(value.input, 'tokenSummary.input'),
    output: requireNumber(value.output, 'tokenSummary.output'),
    cachedInput: optionalNumber(value.cachedInput, 'tokenSummary.cachedInput') ?? 0,
    cacheHitInput:
      optionalNumber(value.cacheHitInput, 'tokenSummary.cacheHitInput') ??
      optionalNumber(value.cachedInput, 'tokenSummary.cachedInput') ??
      0,
    cacheMissInput: optionalNumber(value.cacheMissInput, 'tokenSummary.cacheMissInput') ?? 0,
    cacheWriteInput: optionalNumber(value.cacheWriteInput, 'tokenSummary.cacheWriteInput') ?? 0,
    ...cacheMissInputSourceField(value.cacheMissInputSource),
    reasoning: requireNumber(value.reasoning, 'tokenSummary.reasoning'),
    total: requireNumber(value.total, 'tokenSummary.total'),
    costUsd: requireNumber(value.costUsd, 'tokenSummary.costUsd'),
    pricingSource:
      requireOptionalStringUnion(value.pricingSource, 'tokenSummary.pricingSource', [
        'runtime',
      ] as const) ?? 'runtime',
  };
}

function validateToolSummary(value: unknown): HarborCellToolSummary {
  if (!isRecord(value)) throw new Error('toolSummary must be a JSON object');
  const actualToolCallCounts = validateToolCallCounts(value.actualToolCallCounts);
  return {
    providerVisibleToolCount: requireNumber(
      value.providerVisibleToolCount,
      'toolSummary.providerVisibleToolCount',
    ),
    actualToolCalls: requireNumber(value.actualToolCalls, 'toolSummary.actualToolCalls'),
    actualToolNames: validateStringArray(value.actualToolNames, 'toolSummary.actualToolNames'),
    actualToolCallCounts,
  };
}

function validateTaskToolSummary(value: unknown): HarborCellTaskToolSummary {
  if (!isRecord(value)) throw new Error('taskToolSummary must be a JSON object');
  return {
    todoWriteCalls: requireNumber(value.todoWriteCalls, 'taskToolSummary.todoWriteCalls'),
  };
}

function validateContextBudgetSummary(value: unknown): HarborCellContextBudgetSummary {
  if (!isRecord(value)) throw new Error('contextBudgetSummary must be a JSON object');
  return {
    diagnosticEvents: requireNumber(
      value.diagnosticEvents,
      'contextBudgetSummary.diagnosticEvents',
    ),
    enabledEvents: requireNumber(value.enabledEvents, 'contextBudgetSummary.enabledEvents'),
    estimatedTokensBefore: requireNumber(
      value.estimatedTokensBefore,
      'contextBudgetSummary.estimatedTokensBefore',
    ),
    estimatedTokensAfter: requireNumber(
      value.estimatedTokensAfter,
      'contextBudgetSummary.estimatedTokensAfter',
    ),
    keptTurns: requireNumber(value.keptTurns, 'contextBudgetSummary.keptTurns'),
    droppedTurns: requireNumber(value.droppedTurns, 'contextBudgetSummary.droppedTurns'),
    keptEvents: requireNumber(value.keptEvents, 'contextBudgetSummary.keptEvents'),
    droppedEvents: requireNumber(value.droppedEvents, 'contextBudgetSummary.droppedEvents'),
    prunedToolResults: requireNumber(
      value.prunedToolResults,
      'contextBudgetSummary.prunedToolResults',
    ),
    activePrunedToolResults:
      optionalNumber(
        value.activePrunedToolResults,
        'contextBudgetSummary.activePrunedToolResults',
      ) ?? 0,
    activeEstimatedTokensSaved:
      optionalNumber(
        value.activeEstimatedTokensSaved,
        'contextBudgetSummary.activeEstimatedTokensSaved',
      ) ?? 0,
    activeArchiveFailures:
      optionalNumber(value.activeArchiveFailures, 'contextBudgetSummary.activeArchiveFailures') ??
      0,
    archivePlaceholders: requireNumber(
      value.archivePlaceholders,
      'contextBudgetSummary.archivePlaceholders',
    ),
    archivePlaceholderReasonCounts:
      optionalCountRecord(
        value.archivePlaceholderReasonCounts,
        'contextBudgetSummary.archivePlaceholderReasonCounts',
      ) ?? {},
    archiveWriteFailures: requireNumber(
      value.archiveWriteFailures,
      'contextBudgetSummary.archiveWriteFailures',
    ),
    retrievedArchiveToolResults: requireNumber(
      value.retrievedArchiveToolResults,
      'contextBudgetSummary.retrievedArchiveToolResults',
    ),
    retrievedArchiveEstimatedTokens: requireNumber(
      value.retrievedArchiveEstimatedTokens,
      'contextBudgetSummary.retrievedArchiveEstimatedTokens',
    ),
    archiveRetrievalSkipped: requireNumber(
      value.archiveRetrievalSkipped,
      'contextBudgetSummary.archiveRetrievalSkipped',
    ),
    archiveRetrievalSkippedReasonCounts:
      optionalCountRecord(
        value.archiveRetrievalSkippedReasonCounts,
        'contextBudgetSummary.archiveRetrievalSkippedReasonCounts',
      ) ?? {},
    archiveRetrievalFailures: requireNumber(
      value.archiveRetrievalFailures,
      'contextBudgetSummary.archiveRetrievalFailures',
    ),
    archiveRetrievalFailureReasonCounts:
      optionalCountRecord(
        value.archiveRetrievalFailureReasonCounts,
        'contextBudgetSummary.archiveRetrievalFailureReasonCounts',
      ) ?? {},
    semanticCompactCallInputTokens:
      optionalNumber(
        value.semanticCompactCallInputTokens,
        'contextBudgetSummary.semanticCompactCallInputTokens',
      ) ?? 0,
    semanticCompactCallOutputTokens:
      optionalNumber(
        value.semanticCompactCallOutputTokens,
        'contextBudgetSummary.semanticCompactCallOutputTokens',
      ) ?? 0,
    semanticCompactCallCacheReadInputTokens:
      optionalNumber(
        value.semanticCompactCallCacheReadInputTokens,
        'contextBudgetSummary.semanticCompactCallCacheReadInputTokens',
      ) ?? 0,
    semanticCompactCallCacheWriteInputTokens:
      optionalNumber(
        value.semanticCompactCallCacheWriteInputTokens,
        'contextBudgetSummary.semanticCompactCallCacheWriteInputTokens',
      ) ?? 0,
    semanticCompactCallTotalTokens:
      optionalNumber(
        value.semanticCompactCallTotalTokens,
        'contextBudgetSummary.semanticCompactCallTotalTokens',
      ) ?? 0,
  };
}

function mergeCountRecord(
  target: Record<string, number>,
  source: Record<string, number> | undefined,
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function optionalCountRecord(value: unknown, path: string): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object`);
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    result[key] = requireNumber(raw, `${path}.${key}`);
  }
  return result;
}

function validateContextBudgetPolicySnapshot(
  value: unknown,
): HarborCellContextBudgetPolicySnapshot {
  if (!isRecord(value)) throw new Error('contextBudgetPolicy must be a JSON object');
  const enabled = requireBoolean(value.enabled, 'contextBudgetPolicy.enabled');
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    name: requireString(value.name, 'contextBudgetPolicy.name'),
    ...(optionalNumber(value.maxHistoryTurns, 'contextBudgetPolicy.maxHistoryTurns') !== undefined
      ? {
          maxHistoryTurns: optionalNumber(
            value.maxHistoryTurns,
            'contextBudgetPolicy.maxHistoryTurns',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxHistoryEstimatedTokens,
      'contextBudgetPolicy.maxHistoryEstimatedTokens',
    ) !== undefined
      ? {
          maxHistoryEstimatedTokens: optionalNumber(
            value.maxHistoryEstimatedTokens,
            'contextBudgetPolicy.maxHistoryEstimatedTokens',
          ),
        }
      : {}),
    ...(value.staleToolResultPrune !== undefined
      ? { staleToolResultPrune: validateStaleToolResultPruneSnapshot(value.staleToolResultPrune) }
      : {}),
    ...(value.activeToolResultPrune !== undefined
      ? {
          activeToolResultPrune: validateActiveToolResultPruneSnapshot(value.activeToolResultPrune),
        }
      : {}),
    ...(value.activeFullCompact !== undefined
      ? { activeFullCompact: validateActiveFullCompactSnapshot(value.activeFullCompact) }
      : {}),
    ...(value.semanticCompact !== undefined
      ? { semanticCompact: validateSemanticCompactSnapshot(value.semanticCompact) }
      : {}),
    ...(value.archiveRetrieval !== undefined
      ? { archiveRetrieval: validateArchiveRetrievalSnapshot(value.archiveRetrieval) }
      : {}),
    minRecentTurns: requireNumber(value.minRecentTurns, 'contextBudgetPolicy.minRecentTurns'),
  };
}

function validateStaleToolResultPruneSnapshot(
  value: unknown,
): NonNullable<ContextBudgetPolicy['staleToolResultPrune']> {
  if (!isRecord(value))
    throw new Error('contextBudgetPolicy.staleToolResultPrune must be a JSON object');
  return {
    enabled: requireBoolean(value.enabled, 'contextBudgetPolicy.staleToolResultPrune.enabled'),
    maxResultEstimatedTokens: requireNumber(
      value.maxResultEstimatedTokens,
      'contextBudgetPolicy.staleToolResultPrune.maxResultEstimatedTokens',
    ),
    minRecentTurnsFull: requireNumber(
      value.minRecentTurnsFull,
      'contextBudgetPolicy.staleToolResultPrune.minRecentTurnsFull',
    ),
  };
}

function validateActiveToolResultPruneSnapshot(
  value: unknown,
): NonNullable<ContextBudgetPolicy['activeToolResultPrune']> {
  if (!isRecord(value))
    throw new Error('contextBudgetPolicy.activeToolResultPrune must be a JSON object');
  return {
    enabled: requireBoolean(value.enabled, 'contextBudgetPolicy.activeToolResultPrune.enabled'),
    maxCurrentResultEstimatedTokens: requireNumber(
      value.maxCurrentResultEstimatedTokens,
      'contextBudgetPolicy.activeToolResultPrune.maxCurrentResultEstimatedTokens',
    ),
    minStepNumber: requireNumber(
      value.minStepNumber,
      'contextBudgetPolicy.activeToolResultPrune.minStepNumber',
    ),
  };
}

function validateActiveFullCompactSnapshot(
  value: unknown,
): NonNullable<ContextBudgetPolicy['activeFullCompact']> {
  if (!isRecord(value))
    throw new Error('contextBudgetPolicy.activeFullCompact must be a JSON object');
  return {
    enabled: requireBoolean(value.enabled, 'contextBudgetPolicy.activeFullCompact.enabled'),
    ...(value.mode !== undefined
      ? {
          mode: requireStringUnion(value.mode, 'contextBudgetPolicy.activeFullCompact.mode', [
            'off',
            'index_only',
            'validate_only',
            'prepare_step_dry_run',
          ] as const),
        }
      : {}),
    ...(optionalNumber(
      value.minStepNumber,
      'contextBudgetPolicy.activeFullCompact.minStepNumber',
    ) !== undefined
      ? {
          minStepNumber: optionalNumber(
            value.minStepNumber,
            'contextBudgetPolicy.activeFullCompact.minStepNumber',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.highWaterRatio,
      'contextBudgetPolicy.activeFullCompact.highWaterRatio',
    ) !== undefined
      ? {
          highWaterRatio: optionalNumber(
            value.highWaterRatio,
            'contextBudgetPolicy.activeFullCompact.highWaterRatio',
          ),
        }
      : {}),
    ...(optionalNumber(value.forceRatio, 'contextBudgetPolicy.activeFullCompact.forceRatio') !==
    undefined
      ? {
          forceRatio: optionalNumber(
            value.forceRatio,
            'contextBudgetPolicy.activeFullCompact.forceRatio',
          ),
        }
      : {}),
    ...(optionalNumber(value.targetRatio, 'contextBudgetPolicy.activeFullCompact.targetRatio') !==
    undefined
      ? {
          targetRatio: optionalNumber(
            value.targetRatio,
            'contextBudgetPolicy.activeFullCompact.targetRatio',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxActiveEstimatedTokens,
      'contextBudgetPolicy.activeFullCompact.maxActiveEstimatedTokens',
    ) !== undefined
      ? {
          maxActiveEstimatedTokens: optionalNumber(
            value.maxActiveEstimatedTokens,
            'contextBudgetPolicy.activeFullCompact.maxActiveEstimatedTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minRecentMessages,
      'contextBudgetPolicy.activeFullCompact.minRecentMessages',
    ) !== undefined
      ? {
          minRecentMessages: optionalNumber(
            value.minRecentMessages,
            'contextBudgetPolicy.activeFullCompact.minRecentMessages',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minRecentToolPairs,
      'contextBudgetPolicy.activeFullCompact.minRecentToolPairs',
    ) !== undefined
      ? {
          minRecentToolPairs: optionalNumber(
            value.minRecentToolPairs,
            'contextBudgetPolicy.activeFullCompact.minRecentToolPairs',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxSummaryEstimatedTokens,
      'contextBudgetPolicy.activeFullCompact.maxSummaryEstimatedTokens',
    ) !== undefined
      ? {
          maxSummaryEstimatedTokens: optionalNumber(
            value.maxSummaryEstimatedTokens,
            'contextBudgetPolicy.activeFullCompact.maxSummaryEstimatedTokens',
          ),
        }
      : {}),
    ...(value.archiveRequired !== undefined
      ? {
          archiveRequired: requireBoolean(
            value.archiveRequired,
            'contextBudgetPolicy.activeFullCompact.archiveRequired',
          ),
        }
      : {}),
    ...(value.highWaterName !== undefined
      ? {
          highWaterName: requireString(
            value.highWaterName,
            'contextBudgetPolicy.activeFullCompact.highWaterName',
          ),
        }
      : {}),
  };
}

function validateSemanticCompactSnapshot(
  value: unknown,
): NonNullable<ContextBudgetPolicy['semanticCompact']> {
  if (!isRecord(value))
    throw new Error('contextBudgetPolicy.semanticCompact must be a JSON object');
  return {
    enabled: requireBoolean(value.enabled, 'contextBudgetPolicy.semanticCompact.enabled'),
    ...(value.mode !== undefined
      ? {
          mode: requireStringUnion(value.mode, 'contextBudgetPolicy.semanticCompact.mode', [
            'off',
            'validate_only',
            'prepare_step_dry_run',
            'replace',
          ] as const),
        }
      : {}),
    ...(optionalNumber(value.minStepNumber, 'contextBudgetPolicy.semanticCompact.minStepNumber') !==
    undefined
      ? {
          minStepNumber: optionalNumber(
            value.minStepNumber,
            'contextBudgetPolicy.semanticCompact.minStepNumber',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.highWaterRatio,
      'contextBudgetPolicy.semanticCompact.highWaterRatio',
    ) !== undefined
      ? {
          highWaterRatio: optionalNumber(
            value.highWaterRatio,
            'contextBudgetPolicy.semanticCompact.highWaterRatio',
          ),
        }
      : {}),
    ...(optionalNumber(value.forceRatio, 'contextBudgetPolicy.semanticCompact.forceRatio') !==
    undefined
      ? {
          forceRatio: optionalNumber(
            value.forceRatio,
            'contextBudgetPolicy.semanticCompact.forceRatio',
          ),
        }
      : {}),
    ...(optionalNumber(value.targetRatio, 'contextBudgetPolicy.semanticCompact.targetRatio') !==
    undefined
      ? {
          targetRatio: optionalNumber(
            value.targetRatio,
            'contextBudgetPolicy.semanticCompact.targetRatio',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxActiveEstimatedTokens,
      'contextBudgetPolicy.semanticCompact.maxActiveEstimatedTokens',
    ) !== undefined
      ? {
          maxActiveEstimatedTokens: optionalNumber(
            value.maxActiveEstimatedTokens,
            'contextBudgetPolicy.semanticCompact.maxActiveEstimatedTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minRecentMessages,
      'contextBudgetPolicy.semanticCompact.minRecentMessages',
    ) !== undefined
      ? {
          minRecentMessages: optionalNumber(
            value.minRecentMessages,
            'contextBudgetPolicy.semanticCompact.minRecentMessages',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minRecentToolPairs,
      'contextBudgetPolicy.semanticCompact.minRecentToolPairs',
    ) !== undefined
      ? {
          minRecentToolPairs: optionalNumber(
            value.minRecentToolPairs,
            'contextBudgetPolicy.semanticCompact.minRecentToolPairs',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minSafePrefixEstimatedTokens,
      'contextBudgetPolicy.semanticCompact.minSafePrefixEstimatedTokens',
    ) !== undefined
      ? {
          minSafePrefixEstimatedTokens: optionalNumber(
            value.minSafePrefixEstimatedTokens,
            'contextBudgetPolicy.semanticCompact.minSafePrefixEstimatedTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minNewPrefixEstimatedTokens,
      'contextBudgetPolicy.semanticCompact.minNewPrefixEstimatedTokens',
    ) !== undefined
      ? {
          minNewPrefixEstimatedTokens: optionalNumber(
            value.minNewPrefixEstimatedTokens,
            'contextBudgetPolicy.semanticCompact.minNewPrefixEstimatedTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxAcceptedProjectionEstimatedTokens,
      'contextBudgetPolicy.semanticCompact.maxAcceptedProjectionEstimatedTokens',
    ) !== undefined
      ? {
          maxAcceptedProjectionEstimatedTokens: optionalNumber(
            value.maxAcceptedProjectionEstimatedTokens,
            'contextBudgetPolicy.semanticCompact.maxAcceptedProjectionEstimatedTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxSummaryEstimatedTokens,
      'contextBudgetPolicy.semanticCompact.maxSummaryEstimatedTokens',
    ) !== undefined
      ? {
          maxSummaryEstimatedTokens: optionalNumber(
            value.maxSummaryEstimatedTokens,
            'contextBudgetPolicy.semanticCompact.maxSummaryEstimatedTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minSavingsTokens,
      'contextBudgetPolicy.semanticCompact.minSavingsTokens',
    ) !== undefined
      ? {
          minSavingsTokens: optionalNumber(
            value.minSavingsTokens,
            'contextBudgetPolicy.semanticCompact.minSavingsTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minSavingsRatio,
      'contextBudgetPolicy.semanticCompact.minSavingsRatio',
    ) !== undefined
      ? {
          minSavingsRatio: optionalNumber(
            value.minSavingsRatio,
            'contextBudgetPolicy.semanticCompact.minSavingsRatio',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.minNetSavingsTokens,
      'contextBudgetPolicy.semanticCompact.minNetSavingsTokens',
    ) !== undefined
      ? {
          minNetSavingsTokens: optionalNumber(
            value.minNetSavingsTokens,
            'contextBudgetPolicy.semanticCompact.minNetSavingsTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.compactCallTokenCostWeight,
      'contextBudgetPolicy.semanticCompact.compactCallTokenCostWeight',
    ) !== undefined
      ? {
          compactCallTokenCostWeight: optionalNumber(
            value.compactCallTokenCostWeight,
            'contextBudgetPolicy.semanticCompact.compactCallTokenCostWeight',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxCompactCallTokens,
      'contextBudgetPolicy.semanticCompact.maxCompactCallTokens',
    ) !== undefined
      ? {
          maxCompactCallTokens: optionalNumber(
            value.maxCompactCallTokens,
            'contextBudgetPolicy.semanticCompact.maxCompactCallTokens',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.maxConsecutiveInvalidSummaries,
      'contextBudgetPolicy.semanticCompact.maxConsecutiveInvalidSummaries',
    ) !== undefined
      ? {
          maxConsecutiveInvalidSummaries: optionalNumber(
            value.maxConsecutiveInvalidSummaries,
            'contextBudgetPolicy.semanticCompact.maxConsecutiveInvalidSummaries',
          ),
        }
      : {}),
    ...(optionalNumber(
      value.invalidSummaryCooldownSteps,
      'contextBudgetPolicy.semanticCompact.invalidSummaryCooldownSteps',
    ) !== undefined
      ? {
          invalidSummaryCooldownSteps: optionalNumber(
            value.invalidSummaryCooldownSteps,
            'contextBudgetPolicy.semanticCompact.invalidSummaryCooldownSteps',
          ),
        }
      : {}),
    ...(optionalNumber(value.timeoutMs, 'contextBudgetPolicy.semanticCompact.timeoutMs') !==
    undefined
      ? {
          timeoutMs: optionalNumber(
            value.timeoutMs,
            'contextBudgetPolicy.semanticCompact.timeoutMs',
          ),
        }
      : {}),
    ...(value.archiveRequired !== undefined
      ? {
          archiveRequired: requireBoolean(
            value.archiveRequired,
            'contextBudgetPolicy.semanticCompact.archiveRequired',
          ),
        }
      : {}),
    ...(value.summarizerModel !== undefined
      ? {
          summarizerModel: requireString(
            value.summarizerModel,
            'contextBudgetPolicy.semanticCompact.summarizerModel',
          ),
        }
      : {}),
    ...(value.promptVersion !== undefined
      ? {
          promptVersion: requireString(
            value.promptVersion,
            'contextBudgetPolicy.semanticCompact.promptVersion',
          ),
        }
      : {}),
    ...(value.highWaterName !== undefined
      ? {
          highWaterName: requireString(
            value.highWaterName,
            'contextBudgetPolicy.semanticCompact.highWaterName',
          ),
        }
      : {}),
  };
}

function validateArchiveRetrievalSnapshot(
  value: unknown,
): NonNullable<ContextBudgetPolicy['archiveRetrieval']> {
  if (!isRecord(value))
    throw new Error('contextBudgetPolicy.archiveRetrieval must be a JSON object');
  return {
    enabled: requireBoolean(value.enabled, 'contextBudgetPolicy.archiveRetrieval.enabled'),
    ...(value.mode !== undefined
      ? {
          mode: requireStringUnion(value.mode, 'contextBudgetPolicy.archiveRetrieval.mode', [
            'eager',
            'history_search_gated',
          ] as const),
        }
      : {}),
    maxResults: requireNumber(value.maxResults, 'contextBudgetPolicy.archiveRetrieval.maxResults'),
    maxEstimatedTokens: requireNumber(
      value.maxEstimatedTokens,
      'contextBudgetPolicy.archiveRetrieval.maxEstimatedTokens',
    ),
    maxBytes: requireNumber(value.maxBytes, 'contextBudgetPolicy.archiveRetrieval.maxBytes'),
    order: requireStringUnion(value.order, 'contextBudgetPolicy.archiveRetrieval.order', [
      'newest_first',
    ] as const),
  };
}

function validateToolCallCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new Error('toolSummary.actualToolCallCounts must be a JSON object');
  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    counts[key] = requireNumber(raw, `toolSummary.actualToolCallCounts.${key}`);
  }
  return counts;
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

function validateRuntimeRefs(value: unknown): HarborCellRuntimeRefs {
  if (!isRecord(value)) throw new Error('runtimeRefs must be a JSON object');
  return {
    invocationId: requireString(value.invocationId, 'runtimeRefs.invocationId'),
    sessionId: requireString(value.sessionId, 'runtimeRefs.sessionId'),
    runId: requireString(value.runId, 'runtimeRefs.runId'),
    turnId: requireString(value.turnId, 'runtimeRefs.turnId'),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${field} must be a non-empty string when present`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNumber(value, field);
}

function requireStringUnion<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function requireOptionalStringUnion<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  return requireStringUnion(value, field, allowed);
}

function cacheMissInputSourceField(
  value: unknown,
): Pick<HarborCellTokenSummary, 'cacheMissInputSource'> {
  const cacheMissInputSource = requireOptionalStringUnion(
    value,
    'tokenSummary.cacheMissInputSource',
    ['explicit', 'derived'] as const,
  );
  return cacheMissInputSource ? { cacheMissInputSource } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
