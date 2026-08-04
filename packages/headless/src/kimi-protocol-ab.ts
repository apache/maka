import { createHash } from 'node:crypto';
import type { ModelInfo } from '@maka/core';
import { renderAbComparisonMarkdown } from './ab-render.js';
import { buildRunManifestFingerprint, canonicalJson } from './ab-manifest.js';
import { buildAbRoundId, runAbComparison } from './ab-run.js';
import { summarizeAbComparison } from './ab-summary.js';
import type { AbArmSpec, AbComparisonSummary } from './ab-types.js';
import type { Config } from './contracts.js';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  runFixedPromptController,
  type FixedPromptTask,
  type FixedPromptTaskPlumbingFailedEvent,
  type FixedPromptTaskWalEvent,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import type { HarborBillingMode } from './harbor-task-runner.js';
import {
  assertProviderRequestTraceComplete,
  readProviderRequestTrace,
  type ProviderRequestTraceAnalysis,
  type ProviderRequestTraceCaptureAnalysis,
} from './provider-request-trace.js';

export type KimiProtocol = Extract<
  NonNullable<ModelInfo['apiProtocol']>,
  'anthropic-messages' | 'openai-chat'
>;

export interface KimiProtocolRequestMetrics {
  requests: number;
  completed: number;
  failed: number;
  interrupted: number;
  aborted: number;
  completeUsageRequests: number;
  missingUsageRequests: number;
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheMissInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  totalLatencyMs: number | null;
  meanLatencyMs: number | null;
  meanTimeToFirstTokenMs: number | null;
}

export interface KimiProtocolSmokeTrace {
  onlyIntendedDifferences: boolean;
  requestCount: number;
  sharedSegmentCount: number;
  differingSegments: readonly ['provider_options'] | readonly [];
  anthropicProviderId?: string;
  openaiProviderId?: string;
  error?: string;
}

export interface KimiProtocolAbEvidence {
  armId: 'anthropic' | 'openai';
  protocol: KimiProtocol;
  taskId: string;
  rep: number;
  eventId: string;
  traceEventsPath: string;
  trace: ProviderRequestTraceAnalysis;
}

export type KimiProtocolDefaultRecommendation = 'keep_anthropic_default' | 'openai_candidate';

const MIN_DEFAULT_CHANGE_IMPROVEMENT_RATIO = 0.01;
const MIN_DEFAULT_CHANGE_LATENCY_MS = 100;

export interface KimiProtocolAbResult {
  summary: AbComparisonSummary;
  evidence: KimiProtocolAbEvidence[];
  requestMetrics: {
    anthropic: KimiProtocolRequestMetrics;
    openai: KimiProtocolRequestMetrics;
  };
  smokeTrace: KimiProtocolSmokeTrace;
  defaultRecommendation: KimiProtocolDefaultRecommendation;
}

export interface RunKimiProtocolAbComparisonInput {
  runId: string;
  config: Config;
  systemPromptPath: string;
  resultsJsonlPath: string;
  evaluationTasks: readonly FixedPromptTask[];
  taskRunner: TaskRunner;
  reps?: number;
  maxConcurrency?: number;
  armExecution?: 'parallel' | 'sequential';
  budgetMs?: number;
  nonInferiorityMargin?: number;
  resumeFingerprint?: string;
  sharedAgentEnv?: Record<string, string>;
  requireExecutionIdentity?: boolean;
  requireFinalUsage?: boolean;
  expectedPricingProfile?: string;
  billingMode?: HarborBillingMode;
  now?: () => number;
  newId?: () => string;
}

const KIMI_PROTOCOL_ARMS = [
  {
    id: 'anthropic',
    protocol: 'anthropic-messages',
  },
  {
    id: 'openai',
    protocol: 'openai-chat',
  },
] as const;

export async function runKimiProtocolAbComparison(
  input: RunKimiProtocolAbComparisonInput,
): Promise<KimiProtocolAbResult> {
  if (input.config.llmConnectionSlug !== 'kimi-coding-plan') {
    throw new Error('Kimi protocol A/B requires the existing kimi-coding-plan connection');
  }
  for (const key of ['MAKA_MODEL_API_PROTOCOL', 'MAKA_HOST_MODEL_API_PROTOCOL'] as const) {
    if (input.sharedAgentEnv?.[key] !== undefined || process.env[key] !== undefined) {
      throw new Error(`Kimi protocol A/B owns ${key} per arm`);
    }
  }
  if (input.evaluationTasks.length === 0) {
    throw new Error('Kimi protocol A/B requires at least one evaluation task');
  }
  const evidenceByPair = new Map<string, KimiProtocolAbEvidence>();
  const arms = KIMI_PROTOCOL_ARMS.map(protocolArmSpec) as [AbArmSpec, AbArmSpec];
  const executeArm = async (armInput: {
    roundId: string;
    arm: AbArmSpec;
    task: FixedPromptTask;
    rep: number;
  }): Promise<{ event: FixedPromptTaskWalEvent; evidence?: KimiProtocolAbEvidence }> => {
    const { roundId, arm, task, rep } = armInput;
    const protocolArm = KIMI_PROTOCOL_ARMS.find((candidate) => candidate.id === arm.id);
    if (!protocolArm) throw new Error(`unknown Kimi protocol A/B arm: ${arm.id}`);
    const result = await runFixedPromptController({
      runId: input.runId,
      roundId,
      config: input.config,
      systemPromptPath: input.systemPromptPath,
      resultsJsonlPath: input.resultsJsonlPath,
      resultsTsvPath: `${input.resultsJsonlPath}.${roundId}.tsv`,
      tasks: [task],
      infraFailurePolicy: 'terminal',
      protectPassAtOne: true,
      resumeFingerprint: armResumeFingerprint(input.resumeFingerprint, protocolArm.protocol),
      taskRunner: (runnerInput) =>
        input.taskRunner({
          ...runnerInput,
          agentEnv: {
            ...(input.sharedAgentEnv ?? {}),
            MAKA_MODEL_API_PROTOCOL: protocolArm.protocol,
          },
        }),
      ...(input.requireExecutionIdentity !== undefined
        ? { requireExecutionIdentity: input.requireExecutionIdentity }
        : {}),
      ...(input.requireFinalUsage !== undefined
        ? { requireFinalUsage: input.requireFinalUsage }
        : {}),
      ...(input.expectedPricingProfile !== undefined
        ? { expectedPricingProfile: input.expectedPricingProfile }
        : {}),
      ...(input.billingMode !== undefined ? { billingMode: input.billingMode } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.newId ? { newId: input.newId } : {}),
    });
    const event = result.events.find((candidate) => candidate.taskId === task.id);
    if (!event) throw new Error(`Kimi protocol A/B arm ${roundId} produced no event`);
    if (event.type === 'task_infra_failed') return { event };
    if (!('traceEventsPath' in event) || !event.traceEventsPath) {
      return {
        event: requestTracePlumbingFailure(
          event,
          'missing_provider_request_trace',
          `Kimi protocol A/B arm ${roundId} produced no #1268 request trace`,
        ),
      };
    }
    if (!('runtimeRefs' in event) || !event.runtimeRefs) {
      return {
        event: requestTracePlumbingFailure(
          event,
          'invalid_provider_request_trace',
          `Kimi protocol A/B arm ${roundId} has no task execution identity for its #1268 request trace`,
        ),
      };
    }
    let trace: ProviderRequestTraceAnalysis;
    try {
      trace = await readProviderRequestTrace(event.traceEventsPath);
      assertProviderRequestTraceComplete(trace, {
        expectedIdentity: event.runtimeRefs,
        label: `Kimi protocol A/B arm ${roundId} request trace`,
      });
    } catch (error) {
      return {
        event: requestTracePlumbingFailure(
          event,
          'invalid_provider_request_trace',
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    const evidence: KimiProtocolAbEvidence = {
      armId: protocolArm.id,
      protocol: protocolArm.protocol,
      taskId: task.id,
      rep,
      eventId: event.id,
      traceEventsPath: event.traceEventsPath,
      trace,
    };
    evidenceByPair.set(evidencePairKey(evidence.armId, task.id, rep), evidence);
    return { event, evidence };
  };

  const preflightTask = input.evaluationTasks[0]!;
  const baselinePreflight = await executeArm({
    roundId: buildAbRoundId(undefined, arms[0].id, 0, preflightTask.id),
    arm: arms[0],
    task: preflightTask,
    rep: 0,
  });
  if (!baselinePreflight.evidence) {
    return invalidPreflightResult(input, baselinePreflight.event, undefined, evidenceByPair);
  }
  const candidatePreflight = await executeArm({
    roundId: buildAbRoundId(undefined, arms[1].id, 0, preflightTask.id),
    arm: arms[1],
    task: preflightTask,
    rep: 0,
  });
  if (!candidatePreflight.evidence) {
    return invalidPreflightResult(
      input,
      baselinePreflight.event,
      candidatePreflight.event,
      evidenceByPair,
    );
  }
  let smokeTrace: KimiProtocolSmokeTrace;
  try {
    smokeTrace = compareKimiProtocolSmokeTrace(
      baselinePreflight.evidence.trace,
      candidatePreflight.evidence.trace,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidPreflightResult(
      input,
      baselinePreflight.event,
      requestTracePlumbingFailure(
        candidatePreflight.event,
        'invalid_provider_request_trace',
        message,
      ),
      evidenceByPair,
      message,
    );
  }

  const summary = await runAbComparison({
    runId: input.runId,
    arms,
    evaluationTasks: input.evaluationTasks,
    ...(input.reps !== undefined ? { reps: input.reps } : {}),
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
    armExecution: input.armExecution ?? 'sequential',
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.nonInferiorityMargin !== undefined
      ? { nonInferiorityMargin: input.nonInferiorityMargin }
      : {}),
    runArm: async (armInput) => (await executeArm(armInput)).event,
  });
  const evidence = [...evidenceByPair.values()];
  evidence.sort(
    (left, right) =>
      left.rep - right.rep ||
      left.taskId.localeCompare(right.taskId) ||
      left.armId.localeCompare(right.armId),
  );
  const anthropicEvidence = evidence.filter((entry) => entry.armId === 'anthropic');
  const openaiEvidence = evidence.filter((entry) => entry.armId === 'openai');
  const anthropic = summarizeKimiProtocolRequestMetrics(
    anthropicEvidence.map((entry) => entry.trace),
  );
  const openai = summarizeKimiProtocolRequestMetrics(openaiEvidence.map((entry) => entry.trace));
  const completeTelemetry =
    anthropic.requests > 0 &&
    openai.requests > 0 &&
    anthropic.missingUsageRequests === 0 &&
    openai.missingUsageRequests === 0;
  const correctnessUnchanged =
    summary.pairedAttempts.evaluatedPairs > 0 &&
    summary.pairedAttempts.wins === 0 &&
    summary.pairedAttempts.losses === 0 &&
    summary.pairedAttempts.missingPairIds.length === 0 &&
    summary.pairedAttempts.excludedPairIds.length === 0;
  return {
    summary,
    evidence,
    requestMetrics: { anthropic, openai },
    smokeTrace,
    defaultRecommendation: recommendKimiProtocolDefault({
      conclusive: summary.decision === 'non_inferior',
      correctnessUnchanged,
      hasSuccessfulPair:
        summary.pairedAttempts.baselinePassed > 0 && summary.pairedAttempts.candidatePassed > 0,
      completeTelemetry,
      anthropic,
      openai,
      anthropicCostUsd: summary.baseline.totalCostUsd,
      openaiCostUsd: summary.candidate.totalCostUsd,
    }),
  };
}

function invalidPreflightResult(
  input: RunKimiProtocolAbComparisonInput,
  baseline: FixedPromptTaskWalEvent,
  candidate: FixedPromptTaskWalEvent | undefined,
  evidenceByPair: ReadonlyMap<string, KimiProtocolAbEvidence>,
  error?: string,
): KimiProtocolAbResult {
  const reps = input.reps ?? 3;
  const baselineRuns = Array.from({ length: reps }, (_, index) => (index === 0 ? [baseline] : []));
  const candidateRuns = Array.from({ length: reps }, (_, index) =>
    index === 0 && candidate ? [candidate] : [],
  );
  const summary = summarizeAbComparison({
    runId: input.runId,
    roundId: 'ab-summary',
    baselineArmId: 'anthropic',
    candidateArmId: 'openai',
    evaluationTaskIds: input.evaluationTasks.map((task) => task.id),
    baselineRuns,
    candidateRuns,
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.nonInferiorityMargin !== undefined
      ? { nonInferiorityMargin: input.nonInferiorityMargin }
      : {}),
  });
  const evidence = [...evidenceByPair.values()].sort(
    (left, right) =>
      left.rep - right.rep ||
      left.taskId.localeCompare(right.taskId) ||
      left.armId.localeCompare(right.armId),
  );
  const anthropic = summarizeKimiProtocolRequestMetrics(
    evidence.filter((entry) => entry.armId === 'anthropic').map((entry) => entry.trace),
  );
  const openai = summarizeKimiProtocolRequestMetrics(
    evidence.filter((entry) => entry.armId === 'openai').map((entry) => entry.trace),
  );
  const failure =
    error ??
    (candidate?.type === 'task_plumbing_failed' ? candidate.error : undefined) ??
    (baseline.type === 'task_plumbing_failed' ? baseline.error : undefined) ??
    'Kimi protocol smoke preflight did not produce complete request evidence';
  return {
    summary,
    evidence,
    requestMetrics: { anthropic, openai },
    smokeTrace: {
      onlyIntendedDifferences: false,
      requestCount: 0,
      sharedSegmentCount: 0,
      differingSegments: [],
      error: failure,
    },
    defaultRecommendation: 'keep_anthropic_default',
  };
}

function requestTracePlumbingFailure(
  event: FixedPromptTaskWalEvent,
  errorClass: Extract<
    FixedPromptTaskPlumbingFailedEvent['errorClass'],
    'missing_provider_request_trace' | 'invalid_provider_request_trace'
  >,
  error: string,
): FixedPromptTaskPlumbingFailedEvent {
  return {
    ...event,
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_plumbing_failed',
    id: `${event.id}:provider-request-trace`,
    status: 'plumbing_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass,
    error,
  };
}

function evidencePairKey(
  armId: KimiProtocolAbEvidence['armId'],
  taskId: string,
  rep: number,
): string {
  return `${armId}\u0000${taskId}\u0000${rep}`;
}

export function kimiProtocolAbArms(): [AbArmSpec, AbArmSpec] {
  return KIMI_PROTOCOL_ARMS.map(protocolArmSpec) as [AbArmSpec, AbArmSpec];
}

export function renderKimiProtocolAbMarkdown(result: KimiProtocolAbResult): string {
  const metrics = (label: string, value: KimiProtocolRequestMetrics) =>
    `- ${label}: requests=${value.requests}, completed=${value.completed}, missing_usage=${value.missingUsageRequests}, input=${value.inputTokens}, cache_read=${value.cacheReadInputTokens}, cache_miss=${value.cacheMissInputTokens}, cache_write=${value.cacheWriteInputTokens}, output=${value.outputTokens}, reasoning=${value.reasoningTokens}, total=${value.totalTokens}, total_latency_ms=${value.totalLatencyMs ?? 'null'}, mean_latency_ms=${value.meanLatencyMs ?? 'null'}, mean_ttft_ms=${value.meanTimeToFirstTokenMs ?? 'null'}`;
  return [
    '# Kimi Coding Plan Protocol A/B',
    '',
    '- Provider: `kimi-coding-plan` (single existing connection)',
    '- Baseline protocol: `anthropic-messages`',
    '- Candidate protocol: `openai-chat`',
    `- Smoke trace: ${result.smokeTrace.onlyIntendedDifferences ? 'pass' : 'fail'}; differing request segment: ${result.smokeTrace.differingSegments.join(', ')}`,
    `- Default recommendation: \`${result.defaultRecommendation}\``,
    '',
    '## Request-level metrics',
    '',
    metrics('Anthropic', result.requestMetrics.anthropic),
    metrics('OpenAI', result.requestMetrics.openai),
    '',
    '## Raw request telemetry',
    '',
    ...result.evidence.map(
      (entry) =>
        `- ${entry.armId} task=${entry.taskId} rep=${entry.rep}: event=${entry.eventId}; trace=${entry.traceEventsPath}; trace_id=${entry.trace.traceId ?? 'unknown'}`,
    ),
    '',
    renderAbComparisonMarkdown(result.summary).trimEnd(),
    '',
  ].join('\n');
}

export function compareKimiProtocolSmokeTrace(
  anthropic: ProviderRequestTraceAnalysis,
  openai: ProviderRequestTraceAnalysis,
): KimiProtocolSmokeTrace {
  const anthropicCaptures = requireCaptures(anthropic, 'Anthropic');
  const openaiCaptures = requireCaptures(openai, 'OpenAI');
  if (anthropicCaptures.length !== openaiCaptures.length) {
    throw new Error('Kimi protocol smoke trace request count differs');
  }
  let sharedSegmentCount = 0;
  for (const [index, anthropicCapture] of anthropicCaptures.entries()) {
    const openaiCapture = openaiCaptures[index]!;
    const request = `request ${index + 1}`;
    if (anthropicCapture.step !== openaiCapture.step) {
      throw new Error(`Kimi protocol smoke trace ${request} step differs`);
    }
    if (anthropicCapture.modelId !== openaiCapture.modelId) {
      throw new Error(`Kimi protocol smoke trace ${request} model differs`);
    }
    if (anthropicCapture.providerId !== openaiCapture.providerId) {
      throw new Error(`Kimi protocol smoke trace ${request} provider connection differs`);
    }
    const anthropicShared = sharedSegments(anthropicCapture);
    const openaiShared = sharedSegments(openaiCapture);
    if (canonicalJson(anthropicShared) !== canonicalJson(openaiShared)) {
      throw new Error(`Kimi protocol smoke trace ${request} shared request segment differs`);
    }
    if (
      !anthropicCapture.requestPayloadWithoutProviderOptionsHash ||
      !openaiCapture.requestPayloadWithoutProviderOptionsHash
    ) {
      throw new Error(
        `Kimi protocol smoke trace ${request} is missing non-protocol request parameter evidence`,
      );
    }
    if (
      anthropicCapture.requestPayloadWithoutProviderOptionsHash !==
      openaiCapture.requestPayloadWithoutProviderOptionsHash
    ) {
      throw new Error(
        `Kimi protocol smoke trace ${request} non-protocol request parameters differ`,
      );
    }
    const anthropicOptions = providerOptionSegments(anthropicCapture);
    const openaiOptions = providerOptionSegments(openaiCapture);
    if (
      anthropicOptions.length === 0 ||
      openaiOptions.length === 0 ||
      canonicalJson(anthropicOptions) === canonicalJson(openaiOptions)
    ) {
      throw new Error(`Kimi protocol smoke trace ${request} must differ in provider_options`);
    }
    sharedSegmentCount += anthropicShared.length;
  }
  return {
    onlyIntendedDifferences: true,
    requestCount: anthropicCaptures.length,
    sharedSegmentCount,
    differingSegments: ['provider_options'],
    anthropicProviderId: anthropicCaptures[0]!.providerId,
    openaiProviderId: openaiCaptures[0]!.providerId,
  };
}

export function summarizeKimiProtocolRequestMetrics(
  traces: readonly ProviderRequestTraceAnalysis[],
): KimiProtocolRequestMetrics {
  const attempts = traces.flatMap((trace) => trace.attempts);
  const completeUsage = attempts.filter(
    (attempt) =>
      attempt.inputTokens !== undefined &&
      attempt.cacheReadInputTokens !== undefined &&
      attempt.cacheMissInputTokens !== undefined &&
      attempt.cacheWriteInputTokens !== undefined &&
      attempt.outputTokens !== undefined &&
      attempt.reasoningTokens !== undefined,
  );
  const ttft = attempts
    .map((attempt) => attempt.timeToFirstTokenMs)
    .filter((value): value is number => value !== undefined);
  const completeSum = (
    select: (attempt: (typeof attempts)[number]) => number | undefined,
  ): number | null => {
    const values = attempts.map(select);
    if (values.length === 0 || values.some((value) => value === undefined)) return null;
    return (values as number[]).reduce((total, value) => total + value, 0);
  };
  const inputTokens = completeSum((attempt) => attempt.inputTokens);
  const outputTokens = completeSum((attempt) => attempt.outputTokens);
  return {
    requests: attempts.length,
    completed: attempts.filter((attempt) => attempt.status === 'completed').length,
    failed: attempts.filter((attempt) => attempt.status === 'failed').length,
    interrupted: attempts.filter((attempt) => attempt.status === 'interrupted').length,
    aborted: attempts.filter((attempt) => attempt.status === 'aborted').length,
    completeUsageRequests: completeUsage.length,
    missingUsageRequests: attempts.length - completeUsage.length,
    inputTokens,
    cacheReadInputTokens: completeSum((attempt) => attempt.cacheReadInputTokens),
    cacheMissInputTokens: completeSum((attempt) => attempt.cacheMissInputTokens),
    cacheWriteInputTokens: completeSum((attempt) => attempt.cacheWriteInputTokens),
    outputTokens,
    reasoningTokens: completeSum((attempt) => attempt.reasoningTokens),
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    totalLatencyMs:
      attempts.length > 0
        ? attempts.reduce((total, attempt) => total + attempt.latencyMs, 0)
        : null,
    meanLatencyMs: mean(attempts.map((attempt) => attempt.latencyMs)),
    meanTimeToFirstTokenMs: mean(ttft),
  };
}

export function recommendKimiProtocolDefault(input: {
  conclusive: boolean;
  correctnessUnchanged: boolean;
  hasSuccessfulPair: boolean;
  completeTelemetry: boolean;
  anthropic: KimiProtocolRequestMetrics;
  openai: KimiProtocolRequestMetrics;
  anthropicCostUsd?: number;
  openaiCostUsd?: number;
}): KimiProtocolDefaultRecommendation {
  if (
    !input.conclusive ||
    !input.correctnessUnchanged ||
    !input.hasSuccessfulPair ||
    !input.completeTelemetry
  ) {
    return 'keep_anthropic_default';
  }
  const improvesTokens =
    input.openai.totalTokens !== null &&
    input.anthropic.totalTokens !== null &&
    materiallyImproves(input.openai.totalTokens, input.anthropic.totalTokens);
  const improvesLatency =
    input.openai.totalLatencyMs !== null &&
    input.anthropic.totalLatencyMs !== null &&
    materiallyImproves(
      input.openai.totalLatencyMs,
      input.anthropic.totalLatencyMs,
      MIN_DEFAULT_CHANGE_LATENCY_MS,
    );
  const improvesCost =
    input.openaiCostUsd !== undefined &&
    input.anthropicCostUsd !== undefined &&
    materiallyImproves(input.openaiCostUsd, input.anthropicCostUsd);
  const tokensDoNotRegress =
    input.openai.totalTokens === null ||
    input.anthropic.totalTokens === null ||
    input.openai.totalTokens <= input.anthropic.totalTokens;
  const latencyDoesNotRegress =
    input.openai.totalLatencyMs === null ||
    input.anthropic.totalLatencyMs === null ||
    input.openai.totalLatencyMs <= input.anthropic.totalLatencyMs;
  const costDoesNotRegress =
    input.openaiCostUsd === undefined ||
    input.anthropicCostUsd === undefined ||
    input.openaiCostUsd <= input.anthropicCostUsd;
  return tokensDoNotRegress &&
    latencyDoesNotRegress &&
    costDoesNotRegress &&
    (improvesTokens || improvesLatency || improvesCost)
    ? 'openai_candidate'
    : 'keep_anthropic_default';
}

function materiallyImproves(
  candidate: number,
  baseline: number,
  minimumAbsoluteImprovement = 0,
): boolean {
  const improvement = baseline - candidate;
  return (
    baseline > 0 &&
    improvement > 0 &&
    improvement >= minimumAbsoluteImprovement &&
    improvement / baseline >= MIN_DEFAULT_CHANGE_IMPROVEMENT_RATIO
  );
}

function protocolArmSpec(arm: (typeof KIMI_PROTOCOL_ARMS)[number]): AbArmSpec {
  return {
    id: arm.id,
    kind: 'provider',
    fingerprint: `sha256:${createHash('sha256').update(arm.protocol).digest('hex')}`,
    metadata: { provider: 'kimi-coding-plan', protocol: arm.protocol },
  };
}

function armResumeFingerprint(base: string | undefined, protocol: KimiProtocol): string {
  return buildRunManifestFingerprint({ version: 1, base: base ?? null, protocol });
}

function requireCaptures(
  trace: ProviderRequestTraceAnalysis,
  label: string,
): readonly ProviderRequestTraceCaptureAnalysis[] {
  if (trace.captures.length === 0) {
    throw new Error(`${label} Kimi protocol smoke trace has no requests`);
  }
  return trace.captures;
}

function sharedSegments(capture: ProviderRequestTraceCaptureAnalysis) {
  return capture.segments.filter((segment) => segment.kind !== 'provider_options');
}

function providerOptionSegments(capture: ProviderRequestTraceCaptureAnalysis) {
  return capture.segments.filter((segment) => segment.kind === 'provider_options');
}

function mean(values: readonly number[]): number | null {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}
