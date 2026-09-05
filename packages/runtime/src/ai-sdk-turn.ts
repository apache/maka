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
 * One AI SDK turn: request projection, provider steps, retries, tool
 * settlement, steering, terminal events, and per-turn cleanup. Session-level
 * construction and cross-turn routing remain in AiSdkBackend.
 */

import type {
  AbortEvent,
  CompleteEvent,
  ErrorEvent,
  ProviderRetryEvent,
  ProviderRetryReason,
  SessionEvent,
  TextCompleteEvent,
  TextDeltaEvent,
  ThinkingCompleteEvent,
  ThinkingDeltaEvent,
  TokenUsageEvent,
  ToolResultContent,
  ToolResultEvent,
  ToolStartEvent,
} from '@maka/core/events';
import type {
  AssistantMessage,
  AssistantStepContentKind,
  AssistantThinkingPart,
  SessionHeader,
  SystemNoteMessage,
  TokenUsageMessage,
} from '@maka/core/session';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { DEFAULT_TOOL_MODE, isToolMode, type ToolMode } from '@maka/core/tool-mode';
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import type { ContextBudgetDiagnostic, LlmCallRecord } from '@maka/core/usage-stats/types';
import { stripUndefinedDeep } from '@maka/core/tool-args-identity';
import type { PlanToolResult } from './plan-tools.js';
import {
  YIELD_AGENT_GRAPH_TOOL_NAME,
  type YieldAgentGraphToolResult,
} from './stream-graph-supervisor-tools.js';
import type {
  ModelFinishReason,
  ModelMessage,
  ModelStepOutcome,
  ModelToolSet,
  NormalizedUsage,
  ModelFailureKind,
  ToolCallPart,
} from './model-protocol.js';
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';

import { AsyncEventQueue } from './async-queue.js';
import { AdmissionLimiter } from './admission-limiter.js';
import {
  type CodeModeExecutionResult,
  DEFAULT_CODE_MODE_EXECUTION_POLICY,
  executeCodeCell,
} from './code-mode.js';
import {
  StreamWatchdog,
  formatStreamWatchdogError,
  type StreamWatchdogPhase,
} from './stream-watchdog.js';
import {
  ToolRuntime,
  isRuntimeCommitBoundaryError,
  type MakaTool,
  type MakaToolContext,
  type DurableSessionEventSink,
} from './tool-runtime.js';
import {
  ModelAdapter,
  type NormalizedAiSdkUsage,
  type ModelStreamResult,
  type RepairableAiSdkToolCall,
} from './model-adapter.js';
import { persistedOpenAiResponsesStepMessages } from './openai-responses-continuation.js';
import { nonCanonicalContentOrder } from './runtime-event-read-model.js';
import {
  composeRequestProjection,
  type DispatchRequestShape,
  type RequestProjectionContext,
} from './request-projection.js';
import {
  decodePlaintextResponsesReasoningState,
  responsesReasoningItemId,
} from './responses-reasoning-state.js';
import type { ActiveToolResultPruneDiagnosticPatch } from './active-tool-result-prune.js';
import { finitePositive } from './context-budget-helpers.js';
import type {
  AutomaticMemoryCompactionDecision,
  AutomaticMemoryCompactionDispatch,
  ProviderImageBudget,
} from './ai-sdk-compaction.js';
import {
  contextDiagnosticsCompactionOf,
  type ContextDiagnosticsCompaction,
} from './context-diagnostics.js';
import {
  AiSdkCompaction,
  hasActiveToolResultPruneDiagnosticPatch,
  hasBlockingReplayDiagnostics,
} from './ai-sdk-compaction.js';
import { RunTrace } from './run-trace.js';
import {
  REQUEST_SANDBOX_BOUNDARY_TOOL_NAME,
  SANDBOX_BOUNDARY_DENIED_FOR_TURN,
  SANDBOX_BOUNDARY_FINALIZATION_PROMPT,
} from './sandbox-boundary-tool.js';
import {
  buildRuntimeEventModelReplayPlan,
  buildSteeringEnvelope,
  collectToolActivityTurnIds,
  compatibleProviderReasoningReplayEventIds,
  formatTextWithInlineRefs,
  steeringMessagesMissingFromBase,
  steeringModelMessage,
  type RuntimeEventModelReplayPlan,
  type RuntimeEventReplayFallbackGate,
} from './model-history.js';
import { toolSchemaCharsForDiagnostics } from './request-shape.js';
import { ProviderRequestTelemetry } from './provider-request-telemetry.js';
import { AiSdkMessageProjection } from './ai-sdk-message-projection.js';
import { ToolAvailabilityRuntime, type ToolAvailabilityPlan } from './tool-availability.js';
import { renderSwarmModePrompt } from './swarm-mode.js';
import { renderGraphModePrompt } from './graph-mode.js';
import type { MemoryExtractionSourceSnapshot } from './memory-extraction.js';
import { modelUsesNativeOpenAiResponses } from './model-runtime.js';
import {
  applyRuntimeEventContextBudget,
  buildContextBudgetDiagnosticShell,
  mergeContextBudgetDiagnostic,
  mergeContextBudgetDiagnosticPatches,
  minimalContextBudgetDiagnostic,
  shouldAppendContextCompactedNote,
  shouldAppendContextCompactionFailedOpenNote,
} from './context-budget.js';
import { isHistoryCompactContentEvent } from './history-compaction.js';
import {
  canContinueHistoryCompactCheckpointForModel,
  isProviderHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import { resolveSelectedModelContextWindow } from './context-budget-policy.js';
import type { AiSdkBackendInput } from './ai-sdk-backend.js';
import {
  INVALID_TOOL_NAME,
  isProviderSandboxBoundaryAttempt,
  repairMakaToolCall,
} from './ai-sdk-tool-repair.js';

export interface AiSdkSessionState {
  contextProviderDroppingReported: boolean;
  cumulativeUsageCheckpoint?: NormalizedAiSdkUsage;
}

export interface AiSdkTurnDependencies {
  backend: AiSdkBackendInput;
  modelAdapter: ModelAdapter;
  messageProjection: AiSdkMessageProjection;
  providerTelemetry: ProviderRequestTelemetry;
  compaction: AiSdkCompaction;
  toolAvailabilityRuntime: ToolAvailabilityRuntime;
  codeCellAdmission: AdmissionLimiter;
  resolvedProviderOptions: Record<string, unknown>;
  session: AiSdkSessionState;
  newId: () => string;
  now: () => number;
  maxSteps?: number;
  providerRetrySleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  createToolRuntime: (turn: AiSdkTurn) => ToolRuntime;
}

type PriorReplayResult = {
  status: 'ready';
  messages: ModelMessage[];
  gate: RuntimeEventReplayFallbackGate;
  diagnostics: RuntimeEventModelReplayPlan['diagnostics'];
  runtimeEventCount?: number;
  contextBudget?: ContextBudgetDiagnostic;
  latestHistoryCompactCheckpoint?: HistoryCompactCheckpoint;
};

const CHILD_STEP_BUDGET_FINALIZATION_PROMPT = [
  '<step_budget_finalization>',
  'This is the final budgeted step for this child-agent turn.',
  'Do not call tools. Return the best concise final answer now using evidence already gathered.',
  'Clearly separate verified findings from inference and explicitly name any remaining gaps.',
  '</step_budget_finalization>',
].join('\n');

function providerToolResultContent(
  toolName: string,
  output: unknown,
  input?: unknown,
): ToolResultContent {
  if (output === undefined) {
    return {
      kind: 'text',
      text: `${toolName} completed without a structured result.`,
    };
  }
  if (toolName !== 'WebSearch') {
    return { kind: 'json', value: output };
  }
  const queryFromInput = providerWebSearchQuery(input);
  if (Array.isArray(output)) {
    const rows: Array<{
      title: string;
      url: string;
      snippet: string;
      source: string;
    }> = [];
    for (const result of output) {
      if (
        !result ||
        typeof result !== 'object' ||
        (result as { type?: unknown }).type !== 'web_search_result' ||
        typeof (result as { url?: unknown }).url !== 'string'
      ) {
        continue;
      }
      const item = result as {
        url: string;
        title?: unknown;
        pageAge?: unknown;
      };
      try {
        const parsed = new URL(item.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        rows.push({
          title: typeof item.title === 'string' && item.title.trim() ? item.title : parsed.hostname,
          url: parsed.toString(),
          snippet: typeof item.pageAge === 'string' ? item.pageAge : '',
          source: parsed.hostname,
        });
      } catch {
        // Provider source rows are untrusted; malformed URLs are dropped.
      }
    }
    return {
      kind: 'web_search',
      provider: 'model',
      query: queryFromInput,
      rows,
    };
  }
  if (!output || typeof output !== 'object') return { kind: 'json', value: output };
  const providerError = output as { type?: unknown; errorCode?: unknown };
  if (
    providerError.type === 'web_search_tool_result_error' ||
    typeof providerError.errorCode === 'string'
  ) {
    return {
      kind: 'web_search_error',
      ok: false,
      provider: 'model',
      ...(queryFromInput ? { query: queryFromInput } : {}),
      reason: 'provider_error',
      message:
        typeof providerError.errorCode === 'string'
          ? `Provider web search failed: ${providerError.errorCode}`
          : 'Provider web search failed.',
    };
  }
  const action = (output as { action?: unknown }).action;
  const sources = (output as { sources?: unknown }).sources;
  let query = queryFromInput;
  if (action && typeof action === 'object') {
    const value = action as {
      type?: unknown;
      query?: unknown;
      queries?: unknown;
    };
    if (Array.isArray(value.queries)) {
      query = value.queries.filter((item): item is string => typeof item === 'string').join(' | ');
    } else if (typeof value.query === 'string') {
      query = value.query;
    }
  }
  const rows: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
  }> = [];
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (
        !source ||
        typeof source !== 'object' ||
        (source as { type?: unknown }).type !== 'url' ||
        typeof (source as { url?: unknown }).url !== 'string'
      ) {
        continue;
      }
      const url = (source as { url: string }).url;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        rows.push({
          title: parsed.hostname,
          url: parsed.toString(),
          snippet: '',
          source: parsed.hostname,
        });
      } catch {
        // Provider source rows are untrusted; malformed URLs are dropped.
      }
    }
  }
  return { kind: 'web_search', provider: 'model', query, rows };
}

function providerWebSearchQuery(input: unknown): string {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return '';
    }
  }
  if (!value || typeof value !== 'object') return '';
  const query = (value as { query?: unknown }).query;
  return typeof query === 'string' ? query : '';
}

function mergeTextProviderOptions(
  current: NonNullable<ModelMessage['providerOptions']> | undefined,
  next: NonNullable<ModelMessage['providerOptions']>,
  textOffset: number,
): NonNullable<ModelMessage['providerOptions']> {
  const shifted = structuredClone(next);
  const shiftedOpenAi = shifted.openai;
  if (shiftedOpenAi && typeof shiftedOpenAi === 'object' && !Array.isArray(shiftedOpenAi)) {
    const annotations = (shiftedOpenAi as { annotations?: unknown }).annotations;
    if (Array.isArray(annotations) && textOffset > 0) {
      (shiftedOpenAi as { annotations: unknown[] }).annotations = annotations.map((annotation) => {
        if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
          return annotation;
        }
        const value = { ...annotation } as Record<string, unknown>;
        if (typeof value.startIndex === 'number') value.startIndex += textOffset;
        if (typeof value.endIndex === 'number') value.endIndex += textOffset;
        if (typeof value.start_index === 'number') value.start_index += textOffset;
        if (typeof value.end_index === 'number') value.end_index += textOffset;
        return value;
      });
    }
  }
  if (!current) return shifted;

  const merged = { ...structuredClone(current), ...shifted };
  const currentOpenAi = current.openai;
  if (
    currentOpenAi &&
    typeof currentOpenAi === 'object' &&
    !Array.isArray(currentOpenAi) &&
    shiftedOpenAi &&
    typeof shiftedOpenAi === 'object' &&
    !Array.isArray(shiftedOpenAi)
  ) {
    const left = currentOpenAi as Record<string, unknown>;
    const right = shiftedOpenAi as Record<string, unknown>;
    const openai: Record<string, unknown> = { ...left, ...right };
    const leftAnnotations = Array.isArray(left.annotations) ? left.annotations : [];
    const rightAnnotations = Array.isArray(right.annotations) ? right.annotations : [];
    if (leftAnnotations.length > 0 || rightAnnotations.length > 0) {
      openai.annotations = [...leftAnnotations, ...rightAnnotations];
    }
    if (
      typeof left.itemId === 'string' &&
      typeof right.itemId === 'string' &&
      left.itemId !== right.itemId
    ) {
      delete openai.itemId;
    }
    merged.openai = openai as NonNullable<ModelMessage['providerOptions']>[string];
  }
  return merged;
}

function projectToolModePlan(
  plan: ToolAvailabilityPlan,
  toolMode: ToolMode,
  execTool: MakaTool,
): ToolAvailabilityPlan {
  if (toolMode === 'direct') return plan;
  const withExec = (names: readonly string[]): string[] =>
    [...new Set([...names, execTool.name])].sort((a, b) => a.localeCompare(b));
  const invalid = plan.providerTools.filter((tool) => tool.name === INVALID_TOOL_NAME);
  const visible = [
    ...plan.providerTools.filter((tool) => tool.name !== INVALID_TOOL_NAME),
    execTool,
  ].sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...plan,
    providerTools: [...visible, ...invalid],
    activeTools: withExec(plan.activeTools),
    ...(plan.projectActiveTools
      ? {
          projectActiveTools: (options) => ({
            activeTools: withExec(plan.projectActiveTools?.(options).activeTools ?? []),
          }),
        }
      : {}),
    currentRepairToolNames: () => withExec(plan.currentRepairToolNames()),
    diagnostics: (activeTools, visibleToolSchemaChars) => {
      const baseActive = activeTools.filter((name) => name !== execTool.name);
      const baseChars = toolSchemaCharsForDiagnostics(plan.providerTools, baseActive);
      const diagnostic = plan.diagnostics(baseActive, baseChars);
      if (!diagnostic) return undefined;
      const execSchemaChars = Math.max(0, visibleToolSchemaChars - baseChars);
      return {
        ...diagnostic,
        visibleToolCount: (diagnostic.visibleToolCount ?? baseActive.length) + 1,
        fullToolCount:
          (diagnostic.fullToolCount ?? baseActive.length + (diagnostic.hiddenToolCount ?? 0)) + 1,
        visibleToolSchemaChars,
        fullToolSchemaChars:
          (diagnostic.fullToolSchemaChars ??
            baseChars + (diagnostic.toolSchemaCharReduction ?? 0)) + execSchemaChars,
      };
    },
  };
}

function nestableToolSnapshot(
  providerTools: readonly MakaTool[],
  activeToolNames: readonly string[],
): ReadonlyMap<string, MakaTool> {
  const active = new Set(activeToolNames);
  return new Map(
    providerTools
      .filter(
        (tool) =>
          active.has(tool.name) &&
          tool.name !== INVALID_TOOL_NAME &&
          tool.name !== 'exec' &&
          tool.providerTool === undefined &&
          tool.nesting !== 'direct_only',
      )
      .map((tool) => [tool.name, tool] as const),
  );
}

const codeModeJsonSchemaOptions = {
  allErrors: true,
  strict: false,
  validateFormats: false,
} as const;
const codeModeDraft7Validator = new Ajv(codeModeJsonSchemaOptions);
const codeModeDraft2019Validator = new Ajv2019(codeModeJsonSchemaOptions);
const codeModeDraft2020Validator = new Ajv2020(codeModeJsonSchemaOptions);
const codeModeCompiledSchemas = new WeakMap<object, ValidateFunction>();

async function validateCodeModeToolInput(tool: MakaTool, input: unknown): Promise<unknown> {
  const parameters = tool.parameters as {
    safeParseAsync?: (
      value: unknown,
    ) => Promise<{ success: true; data: unknown } | { success: false; error: unknown }>;
    safeParse?: (
      value: unknown,
    ) => { success: true; data: unknown } | { success: false; error: unknown };
    validate?: (
      value: unknown,
    ) =>
      | { success: true; value: unknown }
      | { success: false; error: unknown }
      | Promise<{ success: true; value: unknown } | { success: false; error: unknown }>;
    jsonSchema?: unknown;
  };
  const parserResult = parameters.safeParseAsync
    ? await parameters.safeParseAsync(input)
    : parameters.safeParse?.(input);
  if (parserResult) {
    if (parserResult.success) return parserResult.data;
    throw invalidCodeModeToolArguments(tool.name, parserResult.error);
  }

  if (parameters.validate) {
    const validationResult = await parameters.validate(input);
    if (validationResult.success) return validationResult.value;
    throw invalidCodeModeToolArguments(tool.name, validationResult.error);
  }

  const schema = await parameters.jsonSchema;
  const validator = compileCodeModeJsonSchema(schema ?? tool.parameters);
  if (!validator || validator(input)) return input;
  throw invalidCodeModeToolArguments(tool.name, validator.errors);
}

function compileCodeModeJsonSchema(schema: unknown): ValidateFunction | undefined {
  if (typeof schema === 'boolean') return codeModeDraft2020Validator.compile(schema);
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
  const cached = codeModeCompiledSchemas.get(schema);
  if (cached) return cached;
  const declaredDialect = (schema as { readonly $schema?: unknown }).$schema;
  const dialect = typeof declaredDialect === 'string' ? declaredDialect : '';
  const validator = dialect.includes('draft-07')
    ? codeModeDraft7Validator
    : dialect.includes('2019-09')
      ? codeModeDraft2019Validator
      : codeModeDraft2020Validator;
  const schemaForCompile = dialect.startsWith('https://json-schema.org/draft-07/schema')
    ? { ...schema, $schema: dialect.replace('https://', 'http://') }
    : schema;
  const compiled = validator.compile(schemaForCompile as AnySchema);
  codeModeCompiledSchemas.set(schema, compiled);
  return compiled;
}

function invalidCodeModeToolArguments(toolName: string, error: unknown): Error {
  return new Error(`Invalid arguments for tool "${toolName}": ${schemaErrorSummary(error)}`);
}

function schemaErrorSummary(error: unknown): string {
  if (error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)) {
    const issues = (error as { issues: Array<{ path?: unknown; message?: unknown }> }).issues;
    return issues
      .slice(0, 5)
      .map((issue) => {
        const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
        const message = typeof issue.message === 'string' ? issue.message : 'invalid value';
        return path ? `${path}: ${message}` : message;
      })
      .join('; ')
      .slice(0, 1000);
  }
  if (Array.isArray(error)) {
    return (error as ErrorObject[])
      .slice(0, 5)
      .map((issue) => {
        const path = issue.instancePath || issue.schemaPath;
        return `${path || 'input'} ${issue.message ?? 'is invalid'}`;
      })
      .join('; ')
      .slice(0, 1000);
  }
  return 'input does not match the declared schema';
}

function joinPromptFragments(fragments: readonly (string | undefined)[]): string | undefined {
  const joined = fragments
    .map((fragment) => fragment?.trim())
    .filter((fragment): fragment is string => Boolean(fragment))
    .join('\n\n');
  return joined.length > 0 ? joined : undefined;
}

const MAX_WAITING_CODE_MODE_CELLS = 1;

const MAX_PROVIDER_ATTEMPTS_PER_STEP = 10;
const MAX_IDLE_WATCHDOG_RETRIES_PER_STEP = 1;
const MAX_INCOMPLETE_STREAM_RETRIES_PER_STEP = 1;
// A mid-stream cut after partial thinking seals one transcript fragment per
// retry. A gateway that systematically kills long thinking streams (the
// 2026-08-28 incident shape) would otherwise spend the full attempt budget
// accumulating fragments before failing anyway, so fail fast after one.
const MAX_SEALED_THINKING_RETRIES_PER_STEP = 1;
const PROVIDER_RETRY_BASE_DELAY_MS = 1_000;
const PROVIDER_RETRY_MAX_DELAY_MS = 32_000;
const PROVIDER_RETRY_JITTER_FACTOR = 0.25;

function providerRetryDelayMs(failedAttempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = Math.min(
    PROVIDER_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1),
    PROVIDER_RETRY_MAX_DELAY_MS,
  );
  return Math.ceil(base + Math.random() * PROVIDER_RETRY_JITTER_FACTOR * base);
}

function providerRetryReason(kind: ModelFailureKind): ProviderRetryReason {
  switch (kind) {
    case 'network':
    case 'provider_unavailable':
    case 'rate_limit':
    case 'timeout':
      return kind;
    case 'provider_capacity':
      return 'provider_capacity';
    default:
      return 'unknown';
  }
}

function isIncompleteProviderFinishReason(reason: ModelFinishReason | undefined): boolean {
  return reason === undefined || reason === 'other' || reason === 'unknown';
}

/**
 * The mutable state of ONE `send()`.
 *
 * Identity is readonly and captured at dispatch: a tool that executes minutes
 * later commits against the run that actually issued it, never against whatever
 * run happens to be current when it finishes. The remaining fields are the
 * turn's own stream/abort bookkeeping, isolated so an overlapping turn on the
 * same backend cannot observe or clear them.
 *
 * Each turn owns its ToolRuntime for the same reason: gating, the loop gate,
 * the subagent and child-run limiters, durable attempts, and step admission are
 * all per-turn facts.
 */

export class AiSdkTurn {
  readonly abortController = new AbortController();
  readonly activeTools = new Map<string, MakaTool>();
  aborted = false;
  loopStopRequested = false;
  loopStopReason: CompleteEvent['stopReason'] | undefined;
  watchdog: StreamWatchdog | null = null;
  runTrace: RunTrace | null = null;
  readonly imageBudget: ProviderImageBudget = { used: 0, decisions: new Map() };
  injectedSteeringMessages: ModelMessage[] = [];
  memoryExtractRequested = false;
  memorySourceMessages: readonly ModelMessage[] | undefined;
  memorySourceEventMessagePositions: Readonly<Record<string, readonly number[]>> | undefined;
  memorySourceSystemPrompt: string | undefined;
  memorySourceTools: ModelToolSet | undefined;
  memorySourceActiveTools: readonly string[] | undefined;
  finalAssistantText: string | undefined;
  codeModeTools: ReadonlyMap<string, MakaTool> | undefined;
  readonly turnId: string;
  readonly runId: string | undefined;
  readonly orchestration: EffectiveOrchestration;
  readonly toolRuntime: ToolRuntime;

  constructor(
    private readonly deps: AiSdkTurnDependencies,
    private readonly request: BackendSendInput,
  ) {
    this.turnId = request.turnId;
    this.runId = request.runId;
    this.orchestration =
      request.orchestration ??
      resolveEffectiveOrchestration(deps.backend.header.orchestrationMode, undefined);
    this.toolRuntime = deps.createToolRuntime(this);
  }

  async *run(): AsyncIterable<SessionEvent> {
    yield* this.runWithinScope(this.request);
  }

  /** Release resources after the backend removes this turn from its active index. */
  async close(): Promise<void> {
    this.deps.modelAdapter.endContinuation(this.turnId);
    await this.toolRuntime.endTurn(this.aborted ? 'aborted' : 'completed');
  }

  requestStop(reason: 'user_stop' | 'redirect', mode: 'immediate' | 'after_step'): void {
    if (mode === 'after_step') {
      this.loopStopRequested = true;
      this.runTrace?.abortRequested(reason);
      return;
    }
    this.aborted = true;
    this.abortController.abort();
    this.runTrace?.abortRequested(reason);
  }

  async endAbortedTools(): Promise<void> {
    await this.toolRuntime.endTurn('aborted');
  }

  async respondToSandboxBoundary(decision: SandboxBoundaryResponse): Promise<boolean> {
    return await this.toolRuntime.respondToSandboxBoundaryResponse(decision);
  }

  respondToUserQuestion(response: UserQuestionResponse): boolean {
    return this.toolRuntime.respondToUserQuestion(response);
  }

  memorySourceSnapshot(
    boundary:
      | { readonly trigger: 'remember'; readonly toolCallId: string }
      | { readonly trigger: 'extract'; readonly terminalEventId: string },
  ): MemoryExtractionSourceSnapshot | undefined {
    if (
      !this.runId ||
      !this.memorySourceMessages ||
      !this.memorySourceTools ||
      !this.memorySourceActiveTools
    ) {
      return undefined;
    }
    const sourceMessages =
      boundary.trigger === 'extract' && this.finalAssistantText
        ? [
            ...this.memorySourceMessages,
            {
              role: 'assistant' as const,
              content: [{ type: 'text' as const, text: this.finalAssistantText }],
            } as ModelMessage,
          ]
        : this.memorySourceMessages;
    const memoryProjection = projectMemoryConversationPrefix(
      sourceMessages,
      this.memorySourceEventMessagePositions,
    );
    return {
      ...boundary,
      sourceHeader: memoryExtractionModelHeader(this.deps.backend.header),
      ...(this.memorySourceSystemPrompt
        ? { sourceSystemPrompt: this.memorySourceSystemPrompt }
        : {}),
      sourceMessages: structuredClone(memoryProjection.messages),
      ...(memoryProjection.eventMessagePositions
        ? {
            sourceEventMessagePositions: structuredClone(memoryProjection.eventMessagePositions),
          }
        : {}),
      sourceTools: { ...this.memorySourceTools },
      sourceActiveTools: [...this.memorySourceActiveTools],
      sourceProviderOptions: structuredClone(this.deps.resolvedProviderOptions),
      ...(this.deps.modelAdapter.maxOutputTokens() !== undefined
        ? { sourceMaxOutputTokens: this.deps.modelAdapter.maxOutputTokens() }
        : {}),
      ...(resolveSelectedModelContextWindow(
        this.deps.backend.connection,
        this.deps.backend.modelId,
      ) !== undefined
        ? {
            sourceContextWindowTokens: resolveSelectedModelContextWindow(
              this.deps.backend.connection,
              this.deps.backend.modelId,
            ),
          }
        : {}),
      sessionId: this.deps.backend.sessionId,
      runId: this.runId,
      turnId: this.turnId,
      workspaceKey: this.deps.backend.header.workspaceRoot,
    };
  }

  private dispatchAutomaticMemoryCompaction(dispatch: AutomaticMemoryCompactionDispatch): void {
    const capabilities = this.deps.backend.memoryExtraction;
    const boundary = dispatch.checkpoint.memoryExtractionBoundary;
    if (
      !capabilities ||
      !this.runId ||
      !boundary ||
      modelUsesNativeOpenAiResponses(this.deps.backend.connection, this.deps.backend.modelId)
    ) {
      return;
    }
    try {
      capabilities.extract({
        trigger: 'compaction',
        sourceHeader: memoryExtractionModelHeader(this.deps.backend.header),
        // Compaction messages are rebuilt from the durable RuntimeEvent prefix
        // inside the background lane, avoiding a full Memory projection here.
        sourceMessages: [],
        rebuildSourceContextFromCompactionCheckpoint: true,
        sourceTools: {},
        sourceActiveTools: [],
        ...(this.deps.modelAdapter.maxOutputTokens() !== undefined
          ? { sourceMaxOutputTokens: this.deps.modelAdapter.maxOutputTokens() }
          : {}),
        ...(resolveSelectedModelContextWindow(
          this.deps.backend.connection,
          this.deps.backend.modelId,
        ) !== undefined
          ? {
              sourceContextWindowTokens: resolveSelectedModelContextWindow(
                this.deps.backend.connection,
                this.deps.backend.modelId,
              ),
            }
          : {}),
        sessionId: this.deps.backend.sessionId,
        runId: this.runId,
        turnId: this.turnId,
        workspaceKey: this.deps.backend.header.workspaceRoot,
        compactionCheckpointId: dispatch.checkpoint.checkpointId,
        compactionBoundaryEventId: boundary.runtimeEventId,
      });
    } catch {
      // Automatic memory extraction is fail-open and must never perturb the caller.
    }
  }

  private automaticMemoryCompactionSupported(): boolean {
    return (
      this.deps.backend.memoryExtraction !== undefined &&
      !modelUsesNativeOpenAiResponses(this.deps.backend.connection, this.deps.backend.modelId)
    );
  }

  private automaticMemoryCompactionDecision(): AutomaticMemoryCompactionDecision {
    const capabilities = this.deps.backend.memoryExtraction;
    if (!capabilities) return { disposition: 'eligible', dispatch: false };
    if (this.deps.backend.header.subagentParent || this.deps.backend.header.isArchived) {
      return { disposition: 'policy_denied', dispatch: false };
    }
    const gate = capabilities.automaticGate?.() ?? {
      allowed: false as const,
      reason: 'unavailable' as const,
    };
    if (gate.allowed) return { disposition: 'eligible', dispatch: true };
    return gate.reason === 'unavailable'
      ? { disposition: 'eligible', dispatch: false }
      : { disposition: 'policy_denied', dispatch: false };
  }

  private createCodeModeExecTool(eventSink: DurableSessionEventSink): MakaTool<{ code: string }> {
    return {
      name: 'exec',
      description: [
        'Execute a bounded orchestration cell over the active tools.',
        'Use tools.<name>(args), await dependent calls, and Promise.all for independent calls.',
        'The sandbox has no process, filesystem, network, timer, eval, import, or cross-cell state.',
        'Terminate by returning a JSON-serializable value. Failures return a structured diagnostic.',
      ].join(' '),
      parameters: z.object({ code: z.string() }),
      executionSemantics: 'exclusive_step',
      nesting: 'direct_only',
      recoveryMode: 'never_auto_retry',
      impl: (args, context) => this.executeCodeModeCell(eventSink, args.code, context),
    };
  }

  // --------------------------------------------------------------------------
  // manual history compaction
  // --------------------------------------------------------------------------

  private async *runWithinScope(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turnId = input.turnId;
    const maxSteps = input.maxSteps ?? this.deps.maxSteps;
    const toolRuntime = this.toolRuntime;
    const turnAbortController = this.abortController;

    const midTurnState = this.deps.compaction.buildMidTurnCapacityCompactState(input);
    const queue = new AsyncEventQueue<SessionEvent>();
    const codeModeExecTool = this.createCodeModeExecTool(queue);

    // One AssistantMessage is flushed per provider step (not per turn), so the
    // ledger records the text↔tool timeline at step granularity and each step's
    // Anthropic thinking signature stays paired with its own thinking text. The
    // turn's first step reuses this id; every later step rotates to a fresh one
    // at its step boundary (see the stream loop below).
    let currentStepMessageId = this.deps.newId();
    let stepText = '';
    let stepTextProviderOptions: NonNullable<ModelMessage['providerOptions']> | undefined;
    let stepTextPartStartOffset = 0;
    let stepThinkingParts: AssistantThinkingPart[] = [];
    let stepThinkingPartsById = new Map<string, AssistantThinkingPart>();
    let stepContentOrder: AssistantStepContentKind[] = [];
    const recordStepContent = (kind: AssistantStepContentKind): void => {
      if (!stepContentOrder.includes(kind)) stepContentOrder.push(kind);
    };
    // Flush the current step's AssistantMessage (text + thinking) and the paired
    // terminal thinking/text events, then clear the per-step accumulators.
    // Persist when the step produced text OR reasoning — a thinking-only step
    // (Anthropic's signed/omitted reasoning has empty text) still round-trips its
    // signed block; a pure-tool step (no text, no thinking) writes nothing, so
    // tool-only steps leave no placeholder assistant row. thinking_complete
    // precedes text_complete so the read-model attaches this step's reasoning to
    // this step's assistant row. Hoisted to turn scope so both the streaming
    // path and the abort/error handler can flush a partial step.
    const resetStep = (): void => {
      stepText = '';
      stepTextProviderOptions = undefined;
      stepTextPartStartOffset = 0;
      stepThinkingParts = [];
      stepThinkingPartsById = new Map();
      stepContentOrder = [];
    };
    const flushStep = async (): Promise<void> => {
      const hasThinking = stepThinkingParts.length > 0;
      if (stepText.length === 0 && !hasThinking) {
        resetStep();
        return;
      }
      const stepId = currentStepMessageId;
      const thinkingText = stepThinkingParts.map((part) => part.text).join('');
      const contentOrder = nonCanonicalContentOrder(stepContentOrder);
      const msg: AssistantMessage = {
        type: 'assistant',
        id: stepId,
        turnId,
        ts: this.deps.now(),
        text: stepText,
        ...(stepTextProviderOptions !== undefined
          ? { providerOptions: stepTextProviderOptions }
          : {}),
        ...(contentOrder ? { contentOrder } : {}),
        modelId: this.deps.backend.modelId,
        ...(hasThinking
          ? {
              thinking: {
                text: thinkingText,
                ...(stepThinkingParts.length === 1 && stepThinkingParts[0]!.signature !== undefined
                  ? { signature: stepThinkingParts[0]!.signature }
                  : {}),
                ...(stepThinkingParts.length === 1 &&
                stepThinkingParts[0]!.providerOptions !== undefined
                  ? { providerOptions: stepThinkingParts[0]!.providerOptions }
                  : {}),
                ...(stepThinkingParts.length > 1 ? { parts: stepThinkingParts } : {}),
              },
            }
          : {}),
      };
      await this.deps.backend.appendMessage(msg);
      if (hasThinking) {
        for (const part of stepThinkingParts) {
          queue.push({
            type: 'thinking_complete',
            id: this.deps.newId(),
            turnId,
            ts: this.deps.now(),
            messageId: stepId,
            text: part.text,
            ...(part.signature !== undefined ? { signature: part.signature } : {}),
            // No sanitiser here, unlike the tool call below: these options are
            // not the provider's object. `translateChunk` rebuilds reasoning
            // metadata from two named string fields, so an omitted provider
            // field cannot arrive as an explicit `undefined` and break the
            // canonical encoding. Passing the provider's object through
            // instead would need the same `stripUndefinedDeep` a tool call has.
            ...(part.providerOptions !== undefined
              ? { providerOptions: part.providerOptions }
              : {}),
          } satisfies ThinkingCompleteEvent);
        }
      }
      queue.push({
        type: 'text_complete',
        id: this.deps.newId(),
        turnId,
        ts: this.deps.now(),
        messageId: stepId,
        text: stepText,
        ...(stepTextProviderOptions !== undefined
          ? { providerOptions: stepTextProviderOptions }
          : {}),
      } satisfies TextCompleteEvent);
      this.finalAssistantText = stepText.length > 0 ? stepText : undefined;
      resetStep();
    };
    let tokenUsage: NormalizedAiSdkUsage | undefined;
    let tokenUsageCostUsd: number | undefined;
    // Per-send sum of every COMPLETED step's usage, merged at each finish-step
    // boundary. When the send aborts (mid-turn exhaust, user stop, stream
    // error) the SDK's cumulative `usage` promise may not resolve, but this sum is
    // real provider-reported evidence for the steps that did finish — IF every
    // completed step produced a usable sample. One unusable sample makes the
    // sum a partial cost, and LlmCallRecord has no partial marker, so the flag
    // fails the whole fallback closed (#972: incomplete usage is no usage).
    let completedStepUsage: NormalizedAiSdkUsage | undefined;
    let sawUnusableStepUsage = false;
    // Input tokens from the last completed step — the actual prompt token count
    // of the final API request. Used to compute contextRemaining for the TUI
    // statusline ctx segment (#1067): contextRemaining = contextWindow - this.
    // result.usage.inputTokens is cumulative across steps and would produce
    // misleading >100% percentages, so the per-step value is captured here.
    let lastStepInputTokens: number | undefined;
    /** Tool count of the request that produced `lastStepInputTokens`. */
    let lastStepActiveToolCount: number | undefined;
    // Output tokens of the same step: with the input they are the baseline the
    // next request is judged from (everything the model produced is re-sent).
    let lastStepOutputTokens: number | undefined;
    let streamStatus: LlmCallRecord['status'] = 'success';
    let streamErrorClass: string | undefined;
    let runtimeSteps = 0;
    let toolAvailabilityForTelemetry: ReturnType<ToolAvailabilityPlan['diagnostics']> = undefined;
    let contextBudgetForTelemetry: ContextBudgetDiagnostic | undefined;
    let contextCompactedNoteWritten = false;
    let contextCompactionFailedOpenNoteWritten = false;
    let contextWindowOverrunNoteWritten = false;
    let contextReportedWindowNoteWritten = false;
    let contextOverflowAfterCompactionNoteWritten = false;
    let contextWindowSuggestionNoteWritten = false;
    // Request index (0-based) at which the active prune last rewrote the
    // request. A step Maka pruned is not append-only, so usage may legitimately
    // shrink.
    let pruneAppliedAtStep: number | undefined;
    const trace = new RunTrace({
      sessionId: this.deps.backend.sessionId,
      turnId,
      connectionSlug: this.deps.backend.connection.slug,
      providerId: this.deps.backend.connection.providerType,
      modelId: this.deps.backend.modelId,
      newId: this.deps.newId,
      now: this.deps.now,
      record: this.deps.backend.recordRunTrace,
    });
    this.runTrace = trace;
    trace.turnStarted({
      orchestrationMode: this.orchestration.mode,
      orchestrationSource: this.orchestration.source,
      agentSwarmAuthorization: this.orchestration.agentSwarmAuthorization,
    });
    if (this.deps.backend.planTraceContext) {
      trace.emit('plan', 'plan_context_resolved', 'Plan context resolved', {
        ...this.deps.backend.planTraceContext,
      });
      if (this.deps.backend.planTraceContext.executionId) {
        trace.emit('plan', 'plan_execution_started', 'Plan execution turn started', {
          ...this.deps.backend.planTraceContext,
        });
      }
    }
    const providerRequestTracker = this.deps.providerTelemetry.createTracker({
      turnId,
      callKind: 'main',
      modelId: this.deps.backend.modelId,
      runId: this.runId,
    });
    const providerRequestTraceId = providerRequestTracker?.traceId;

    // --- Resolve model (API key already attached at construct time) ---
    let model: unknown;
    try {
      model = this.deps.modelAdapter.resolveModel();
      trace.modelResolved();
    } catch (err) {
      trace.modelResolveFailed(err);
      queue.push(this.makeErrorEvent(turnId, err));
      queue.push({
        type: 'complete',
        id: this.deps.newId(),
        turnId,
        ts: this.deps.now(),
        stopReason: 'error',
      } satisfies CompleteEvent);
      queue.close();
      yield* this.drain(queue);
      return;
    }

    // --- Build the provider-visible schema set. Tool execution stays in Runtime. ---
    // One immutable runtime owns the bound search catalog and cached index.
    // Mutable activation belongs to this turn.
    const requiredOrchestrationTools =
      this.orchestration.mode === 'swarm'
        ? new Set([
            'agent_list',
            'update_agent_graph',
            'yield_agent_graph',
            'agent_swarm_status',
            'agent_output',
          ])
        : this.orchestration.mode === 'graph'
          ? new Set([
              'agent_list',
              'view_agent_graph',
              'update_agent_graph',
              'yield_agent_graph',
              'agent_swarm_status',
              'agent_output',
            ])
          : new Set<string>();
    const requestedToolMode: unknown =
      input.toolMode === undefined ? DEFAULT_TOOL_MODE : input.toolMode;
    if (!isToolMode(requestedToolMode)) {
      throw new Error(`Invalid tool mode: ${String(requestedToolMode)}`);
    }
    const toolMode = requestedToolMode;
    if (toolMode === 'code_mode' && this.deps.backend.tools.some((tool) => tool.name === 'exec')) {
      throw new Error('Tool name "exec" is reserved for Code Mode.');
    }
    const plan = projectToolModePlan(
      this.deps.toolAvailabilityRuntime.prepare(this.activeTools, requiredOrchestrationTools),
      toolMode,
      codeModeExecTool,
    );
    const providerTools = plan.providerTools;
    let activeToolResultPruneDiagnosticPatch: ActiveToolResultPruneDiagnosticPatch = {};
    let midTurnCompactDiagnosticPatch: Partial<ContextBudgetDiagnostic> | undefined;
    // Tool names the repair path matches a mis-cased call against — follows the
    // current step's snapshot so a tool activated mid-turn is repairable on the
    // step it becomes active, not routed to `invalid`.
    const boundaryAwareToolNames = (names: readonly string[]): string[] => {
      if (toolRuntime.shouldFinalizeSandboxBoundary()) return [];
      return toolRuntime.hasSandboxBoundaryDenial()
        ? names.filter((name) => name !== REQUEST_SANDBOX_BOUNDARY_TOOL_NAME)
        : [...names];
    };
    const currentRepairToolNames = () => boundaryAwareToolNames(plan.currentRepairToolNames());
    if (plan.gating) {
      toolRuntime.setGating(plan.gating);
    }

    const modelTools: ModelToolSet = {};
    for (const t of providerTools) {
      modelTools[t.name] = t.providerTool
        ? { kind: 'provider', providerTool: t.providerTool }
        : {
            kind: 'function',
            description: t.description,
            inputSchema: t.parameters,
          };
    }

    // Resolve the stable Provider envelope before automatic Compaction freezes
    // its source. The same value is reused by the primary request; Memory does
    // not resolve or mutate Agent configuration after the checkpoint commits.
    let systemPrompt: string | undefined;
    try {
      systemPrompt = joinPromptFragments([
        await this.resolveSystemPrompt(),
        this.orchestration?.mode === 'swarm' ? renderSwarmModePrompt() : undefined,
        this.orchestration?.mode === 'graph' ? renderGraphModePrompt() : undefined,
      ]);
    } catch (err) {
      trace.modelStreamFailed(this.deps.modelAdapter.classifyError(err), err);
      queue.push(this.makeErrorEvent(turnId, err));
      queue.push({
        type: 'complete',
        id: this.deps.newId(),
        turnId,
        ts: this.deps.now(),
        stopReason: 'error',
      } satisfies CompleteEvent);
      queue.close();
      yield* this.drain(queue);
      return;
    }

    // --- Build messages from RuntimeEvent history and its compatibility projection. ---
    const priorReplayResult = await this.buildPriorMessages(input);
    if (this.aborted) {
      queue.push({
        type: 'abort',
        id: this.deps.newId(),
        turnId,
        ts: this.deps.now(),
        reason: 'user_stop',
      } satisfies AbortEvent);
      queue.push({
        type: 'complete',
        id: this.deps.newId(),
        turnId,
        ts: this.deps.now(),
        stopReason: 'user_stop',
      } satisfies CompleteEvent);
      queue.close();
      yield* this.drain(queue);
      return;
    }
    const priorReplay = priorReplayResult;
    if (input.continuation && priorReplay.messages.length === 0) {
      const replay = priorReplayFailureTrace(priorReplay);
      const error = new ContinuationReplayEmptyError(replay.gate, replay.diagnosticCodes);
      trace.modelStreamFailed(error.code, error, replay);
      queue.push(this.makeErrorEvent(turnId, error));
      queue.push({
        type: 'complete',
        id: this.deps.newId(),
        turnId,
        ts: this.deps.now(),
        stopReason: 'error',
      } satisfies CompleteEvent);
      queue.close();
      yield* this.drain(queue);
      return;
    }
    if (midTurnState) {
      // Roll-forward seed: the latest durable checkpoint (loaded or written at
      // turn start) so a mid-turn summary only re-reads the newly folded span.
      const checkpoint = priorReplay.latestHistoryCompactCheckpoint;
      midTurnState.previousCheckpoint =
        checkpoint &&
        canContinueHistoryCompactCheckpointForModel(
          checkpoint,
          this.deps.backend.connection,
          this.deps.backend.header.llmConnectionId,
          this.deps.backend.modelId,
        )
          ? checkpoint
          : undefined;
    }
    /**
     * The fold THIS request's prompt was built under (#2323).
     *
     * Called once per physical dispatch rather than once per send, because the
     * boundary moves between dispatches of the same send: mid-turn capacity
     * compaction advances it before a later step, and overflow recovery
     * advances it before it resends the request the provider just rejected.
     * Sealed from session state at settlement it would be whichever fold
     * arrived last — not the one the sealed prompt was actually made of.
     *
     * Mid-turn state is the single rolling authority whenever the turn has one:
     * it is seeded just above from the pre-turn checkpoint and is what both of
     * those folds write to. A turn without that seam can only have been built
     * under the pre-turn checkpoint.
     */
    const requestHistoryCompactBoundary = (): ContextDiagnosticsCompaction | undefined => {
      const checkpoint = midTurnState
        ? midTurnState.previousCheckpoint
        : priorReplay.latestHistoryCompactCheckpoint;
      return checkpoint ? contextDiagnosticsCompactionOf(checkpoint) : undefined;
    };

    // --- Background pump: streamText → stream → normalize → queue ---
    const pumpDone: Promise<void> = (async () => {
      const watchdogState: { current: StreamWatchdog | null } = {
        current: null,
      };
      let providerRequestAbortController = new AbortController();
      const watchdogTimeoutState: {
        current: {
          readonly phase: StreamWatchdogPhase;
          readonly error: Error;
        } | null;
      } = { current: null };
      const currentWatchdogTimeout = () => watchdogTimeoutState.current;
      const consumeWatchdogTimeout = () => {
        const timeout = watchdogTimeoutState.current;
        watchdogTimeoutState.current = null;
        return timeout;
      };
      let lastCompletedStepHadToolResult = false;
      let terminalProviderErrorReason: string | undefined;
      try {
        const startWatchdog = (): void => {
          watchdogState.current?.stop();
          const next = new StreamWatchdog({
            now: this.deps.now,
            connectTimeoutMs: this.deps.backend.streamConnectTimeoutMs,
            idleTimeoutMs: this.deps.backend.streamIdleTimeoutMs,
            ...this.deps.backend.streamWatchdogTimer,
            onTimeout: (timeout) => {
              const error = new Error(formatStreamWatchdogError(timeout));
              watchdogTimeoutState.current = { phase: timeout.phase, error };
              providerRequestAbortController.abort(error);
            },
          });
          watchdogState.current = next;
          this.watchdog = next;
          next.start();
        };
        const activeTools = plan.activeTools;
        const currentUserContent = input.continuation
          ? undefined
          : await this.deps.messageProjection.buildCurrentUserContent(
              this.imageBudget,
              input.text,
              input.attachments,
              input.directoryReferences,
              input.quotes,
              input.headAnchorRuntimeEvent?.id,
            );
        const messages =
          currentUserContent === undefined
            ? [...priorReplay.messages]
            : [
                ...priorReplay.messages,
                {
                  role: 'user' as const,
                  content: currentUserContent,
                } as ModelMessage,
              ];
        const loadDurableTurnEvents = async (): Promise<RuntimeEvent[]> => {
          const loadTurnRuntimeEvents = this.deps.backend.loadTurnRuntimeEvents;
          if (!loadTurnRuntimeEvents) {
            throw new Error('durable current-run reader is required for tool continuation');
          }
          await queue.waitUntilConsumedThroughCurrent();
          return (await loadTurnRuntimeEvents(turnId)).filter((event) => event.turnId === turnId);
        };
        const loadDurableTurnProjection = async (): Promise<ModelMessage[]> => {
          const turnEvents = await loadDurableTurnEvents();
          const projectionCheckpoint = midTurnState?.projectionCheckpoint;
          const rawProjectionEvents = projectionCheckpoint
            ? [
                ...midTurnState.priorContentEvents,
                ...turnEvents.filter(isHistoryCompactContentEvent),
              ]
            : turnEvents;
          let replayEvents = rawProjectionEvents;
          if (projectionCheckpoint) {
            const checkpointMatch = matchHistoryCompactCheckpointPrefix(
              projectionCheckpoint,
              rawProjectionEvents,
            );
            if (checkpointMatch.reason) {
              throw new Error(`durable checkpoint projection mismatch: ${checkpointMatch.reason}`);
            }
            replayEvents = projectHistoryCompactCheckpointReplay(
              projectionCheckpoint,
              checkpointMatch.coveredRuntimeEvents,
              checkpointMatch.successorRuntimeEvents,
            );
            // The checkpoint was capacity-validated before it was persisted.
            // Do not re-run that gate against a later, larger successor tail:
            // the active-step shaper must see that growth so it can roll the
            // checkpoint forward instead of resurrecting raw history.
          }
          // The current Turn is model-visible history like any other, so it is
          // folded through the same reducer before it becomes messages. Without
          // this, a result archived at step N is rebuilt in full at step N+1 and
          // the ledger's account of what the model sees stops being true.
          const foldedReplayEvents =
            await this.deps.compaction.foldEffectiveModelHistory(replayEvents);
          const replayPlan = buildRuntimeEventModelReplayPlan(foldedReplayEvents, {
            toolActivityTurnIds: collectToolActivityTurnIds([
              ...(input.runtimeContext ?? []),
              ...turnEvents,
            ]),
          });
          if (
            hasBlockingReplayDiagnostics(replayPlan) ||
            (replayPlan.hasProviderNativeSemantics &&
              !this.deps.messageProjection.canReplayProviderNative(replayPlan))
          ) {
            throw new Error('durable current-run projection is not replayable');
          }
          const currentTurnMessages =
            await this.deps.messageProjection.materializeRuntimeReplayPlan(
              replayPlan,
              this.imageBudget,
              projectionCheckpoint,
              compatibleProviderReasoningReplayEventIds(
                replayEvents,
                input.runtimeContextInvocations,
                this.deps.backend.providerStateIdentity,
                this.deps.backend.modelId,
                this.runId,
              ),
            );
          return projectionCheckpoint
            ? currentTurnMessages
            : [...priorReplay.messages, ...currentTurnMessages];
        };
        // Tool Availability describes the provider-visible (active) subset. A
        // group loaded this turn expands that subset on later requests, so the
        // terminal trace is refined against the final active set below.
        contextBudgetForTelemetry = priorReplay.contextBudget;
        const computeToolAvailability = (active: readonly string[]) => {
          const toolSchemaChars = toolSchemaCharsForDiagnostics(providerTools, active);
          return plan.diagnostics(active, toolSchemaChars);
        };
        toolAvailabilityForTelemetry = computeToolAvailability(activeTools);
        trace.modelStreamStarted(activeTools, {
          ...(toolAvailabilityForTelemetry !== undefined
            ? { toolAvailability: toolAvailabilityForTelemetry }
            : {}),
          ...(priorReplay.contextBudget ? { contextBudget: priorReplay.contextBudget } : {}),
        });

        const onMidTurnDiagnosticPatch = (patch: Partial<ContextBudgetDiagnostic>): void => {
          midTurnCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
            midTurnCompactDiagnosticPatch,
            patch,
          );
        };
        const midTurnCapacityHook = this.deps.compaction.buildMidTurnCapacityCompactProjection(
          turnId,
          midTurnState,
          queue,
          providerTools,
          onMidTurnDiagnosticPatch,
          this,
          this.automaticMemoryCompactionSupported()
            ? () => this.automaticMemoryCompactionDecision()
            : undefined,
          this.automaticMemoryCompactionSupported()
            ? (dispatch) => this.dispatchAutomaticMemoryCompaction(dispatch)
            : undefined,
          turnAbortController.signal,
        );
        // When mid-turn capacity compaction is active, the prune must also cover
        // the newest completed step; see collectPrunableCompletedStepToolCallIds.
        const activeToolResultPruneIncludesNewestStep = midTurnState !== undefined;
        const activeToolResultPruneHook = this.deps.compaction.buildActiveToolResultPruneProjection(
          turnId,
          activeToolResultPruneIncludesNewestStep,
          (patch) => {
            pruneAppliedAtStep = runtimeSteps;
            activeToolResultPruneDiagnosticPatch = mergeActiveToolResultPruneDiagnosticPatches(
              activeToolResultPruneDiagnosticPatch,
              patch,
            );
          },
        );
        const shapedProjection = composeRequestProjection(
          plan.projectActiveTools,
          midTurnCapacityHook,
          activeToolResultPruneHook,
        );
        // Hooks shape; nothing measures the final payload. Whether it fits is
        // the provider's answer (#4559).
        const requestProjection = shapedProjection;

        const completedProviderSteps: RequestProjectionContext['completedSteps'][number][] = [];
        let requestMessages: ModelMessage[] = messages;
        // The compaction module runs at most once per send. This tracks the
        // reactive entry; the proactive one sets the same flag on the mid-turn
        // state, and each consults the other, so a send that already folded
        // reports the oversized message instead of folding again (#4559).
        let overflowRetryUsed = false;
        let result: ModelStreamResult;
        let providerOutcome: ModelStepOutcome;
        let finishReason: ModelFinishReason = 'stop';
        let terminalProviderError: unknown;
        agentLoop: for (;;) {
          await this.drainSteeringInto(input, queue);
          if (this.deps.backend.loadTurnRuntimeEvents) {
            requestMessages = await loadDurableTurnProjection();
          } else {
            const missingSteering = steeringMessagesMissingFromBase(
              this.injectedSteeringMessages,
              requestMessages,
            );
            if (missingSteering.length > 0)
              requestMessages = [...requestMessages, ...missingSteering];
          }
          // Resolved BEFORE request projection so the capacity measurement and
          // the request that goes out are the same request: a finalization step
          // adds prompt fragments and sends no tool schemas, and an anchor
          // paired with the un-finalized shape describes a different payload.
          const finalChildSummaryStep =
            this.deps.backend.header.collaborationMode === 'agent' &&
            maxSteps !== undefined &&
            maxSteps > 1 &&
            runtimeSteps === maxSteps - 1 &&
            completedProviderSteps.length > 0;
          const sandboxBoundaryFinalizationStep =
            toolRuntime.shouldFinalizeSandboxBoundary() ||
            (toolRuntime.hasSandboxBoundaryDenial() &&
              maxSteps !== undefined &&
              runtimeSteps === maxSteps - 1);
          if (sandboxBoundaryFinalizationStep) {
            toolRuntime.forceSandboxBoundaryFinalization();
          }
          const requestSystemPrompt = joinPromptFragments([
            systemPrompt,
            finalChildSummaryStep ? CHILD_STEP_BUDGET_FINALIZATION_PROMPT : undefined,
            toolRuntime.hasSandboxBoundaryDenial() ? SANDBOX_BOUNDARY_DENIED_FOR_TURN : undefined,
            sandboxBoundaryFinalizationStep ? SANDBOX_BOUNDARY_FINALIZATION_PROMPT : undefined,
          ]);
          const resolveDispatch = (
            active: readonly string[] | undefined,
          ): DispatchRequestShape => ({
            systemPromptChars: requestSystemPrompt?.length ?? 0,
            activeTools:
              finalChildSummaryStep || sandboxBoundaryFinalizationStep
                ? []
                : boundaryAwareToolNames(active ?? plan.currentRepairToolNames()),
          });
          const shaped = requestProjection
            ? await requestProjection({
                completedSteps: completedProviderSteps,
                stepNumber: runtimeSteps,
                model,
                messages: requestMessages,
                resolveDispatch,
              })
            : undefined;
          const projectedMessages = shaped?.messages ?? requestMessages;
          const activeToolsForRequest = resolveDispatch(shaped?.activeTools).activeTools;
          providerRequestTracker?.setStep(runtimeSteps);
          let attemptMessages = projectedMessages;
          let providerAttempt = 1;
          let idleWatchdogRetryCount = 0;
          let incompleteStreamRetryCount = 0;
          let sealedThinkingRetryCount = 0;
          const returnedToolCalls: ToolCallPart[] = [];
          let providerToolActivityCount = 0;
          const providerToolInputs = new Map<string, unknown>();
          let providerStepUsage: NormalizedUsage | undefined;
          for (;;) {
            providerRequestAbortController = new AbortController();
            watchdogTimeoutState.current = null;
            startWatchdog();
            // Monotonic facts for this physical request. The step accumulators
            // are cleared after flushStep(), so they cannot decide whether a
            // later stream failure is safe to retry.
            let attemptSawText = false;
            let attemptSawThinking = false;
            let attemptSawToolActivity = false;
            let attemptSawContinuationMetadata = false;
            let attemptReachedStepBoundary = false;
            const attemptHasNoObservableOutput = () =>
              !attemptSawText &&
              !attemptSawThinking &&
              !attemptSawToolActivity &&
              !attemptSawContinuationMetadata &&
              !attemptReachedStepBoundary;
            // Thinking is the only output that can be sealed into its own
            // message before a retry: flushStep() closes the fragment under
            // the current message id and the retry streams into a fresh one,
            // so the user never sees spliced or duplicated content. Text,
            // tool activity, continuation metadata, and step boundaries stay
            // non-recoverable for the reasons each of them is tracked.
            const attemptCanRecoverWithSealedThinking = () =>
              !attemptSawText &&
              !attemptSawToolActivity &&
              !attemptSawContinuationMetadata &&
              !attemptReachedStepBoundary;
            this.memorySourceMessages = [...attemptMessages];
            this.memorySourceEventMessagePositions =
              this.deps.messageProjection.memoryEventMessagePositions(attemptMessages);
            this.memorySourceSystemPrompt = requestSystemPrompt;
            this.memorySourceTools = modelTools;
            this.memorySourceActiveTools = [...activeToolsForRequest];
            this.finalAssistantText = undefined;
            // Keep a denied boundary request as a Code Mode trap: the provider
            // no longer sees it as a direct tool, but a nested retry must still
            // reach ToolRuntime's denial latch instead of becoming an endlessly
            // variable unknown-tool error inside `exec`.
            const codeModeActiveTools =
              toolRuntime.hasSandboxBoundaryDenial() && activeToolsForRequest.includes('exec')
                ? [...activeToolsForRequest, REQUEST_SANDBOX_BOUNDARY_TOOL_NAME]
                : activeToolsForRequest;
            this.codeModeTools =
              toolMode === 'code_mode'
                ? nestableToolSnapshot(providerTools, codeModeActiveTools)
                : undefined;
            const requestWatchdog = watchdogState.current;
            // Read here, beside the messages it describes: `attemptMessages` is
            // rebuilt in place by overflow recovery, and the boundary it folded
            // under must travel with that rebuild, not with the step.
            const historyCompactBoundary = requestHistoryCompactBoundary();
            result = await this.deps.modelAdapter.startStream({
              model,
              messages: attemptMessages,
              tools: modelTools,
              activeTools: activeToolsForRequest,
              onStreamActivity: () => requestWatchdog?.markActivity(),
              repairToolCall: async ({
                toolCall,
                error,
              }: {
                toolCall: RepairableAiSdkToolCall;
                error: unknown;
              }) => {
                return repairMakaToolCall({
                  toolCall,
                  availableToolNames: currentRepairToolNames(),
                  toolParameters: (name) =>
                    providerTools.find((candidate) => candidate.name === name)?.parameters,
                  toolCategoryHint: (name) =>
                    providerTools.find((candidate) => candidate.name === name)?.categoryHint,
                  error,
                });
              },
              system: requestSystemPrompt,
              abortSignal: AbortSignal.any([
                turnAbortController.signal,
                providerRequestAbortController.signal,
              ]),
              ...(providerRequestTracker ? { providerRequestTracker } : {}),
              ...(historyCompactBoundary ? { historyCompactBoundary } : {}),
              continuationKey: this.turnId,
            });

            for await (const event of result.events) {
              if (this.aborted) break;
              if (event.kind === 'error') {
                // Settlement owns the failure; stop before any synthesized
                // trailer and consume the one authoritative outcome below.
                break;
              }
              const incompleteFinish =
                (event.kind === 'finish' || event.kind === 'step-finish') &&
                isIncompleteProviderFinishReason(event.finishReason);
              if ((event.kind === 'finish' || event.kind === 'step-finish') && !incompleteFinish) {
                attemptReachedStepBoundary = true;
              }
              if (event.kind === 'step-finish') {
                // AI SDK can synthesize `finish-step(other)` when the provider
                // stream reaches EOF without a terminal frame. That is not a
                // completed model step and must not consume the step budget or
                // checkpoint imaginary usage before the safe retry below.
                if (!incompleteFinish) {
                  // Step boundary: AI SDK 7 delimits steps with `finish-step`
                  // (and `step-finish` for legacy replay fixtures); the adapter
                  // reduces both to this event. A duplicate boundary is harmless:
                  // the second flush no-ops (accumulators already cleared) and one
                  // extra id rotation just discards an unused id.
                  runtimeSteps += 1;
                  const stepUsage = event.usage;
                  providerStepUsage = stepUsage;
                  if (!stepUsage) sawUnusableStepUsage = true;
                  // Silent eviction / rewrite check (#4559): this step only
                  // appended (no fold, no prune, no image omission) yet the
                  // provider counted no more input tokens than for the previous
                  // request. Not-greater, not strictly-fewer: a provider that
                  // truncates to a fixed window (Ollama's `num_ctx`) reports the
                  // same total on every later request while Maka keeps
                  // appending, so a plateau is the signal, and an equal count
                  // after an append is already impossible without provider-side
                  // eviction or rewriting. Input against input: the previous
                  // reply's reasoning may not be resent, so input + output is
                  // not the floor of the next input on every wire.
                  const completedRequestIndex = runtimeSteps - 1;
                  // A finalization step resolves an empty tool set, so its
                  // request legitimately drops several thousand schema tokens
                  // with no fold, prune or image omission. Maka shaped that
                  // request; the provider did not drop anything.
                  const toolSchemaShrank =
                    lastStepActiveToolCount !== undefined &&
                    activeToolsForRequest.length < lastStepActiveToolCount;
                  // Across the send boundary the comparison is the same one,
                  // against the last request a provider accepted before this
                  // send. A provider that truncates to a fixed window reports
                  // the same input on every later request while the user keeps
                  // adding turns, and a send of one or two steps never sees
                  // that from the inside: the live evidence plateaus at 3,716
                  // input tokens across eight turns with nothing reported
                  // (#4623). The first request of a send therefore compares
                  // against the persisted anchor, which is route-validated
                  // where it is read; a fold before that request would explain
                  // a smaller input by itself, so it disables the comparison.
                  const acrossSends = completedRequestIndex === 0;
                  const priorInput = acrossSends
                    ? midTurnState?.compactionAppliedThisSend === true
                      ? undefined
                      : midTurnState?.priorAcceptedInputTokens
                    : lastStepInputTokens;
                  if (
                    !this.deps.session.contextProviderDroppingReported &&
                    !toolSchemaShrank &&
                    midTurnState &&
                    priorInput !== undefined &&
                    midTurnState.replacedStepNumber !== completedRequestIndex &&
                    pruneAppliedAtStep !== completedRequestIndex &&
                    midTurnState.omittedImageToolResults.size === 0 &&
                    stepUsage !== undefined &&
                    Number.isFinite(stepUsage.inputTokens) &&
                    stepUsage.inputTokens > 0 &&
                    // Across sends the test is equality, not "did not grow".
                    // Inside a send Maka knows it only appended, so any
                    // shortfall is the provider's. Across the boundary it does
                    // not: a manual compaction leaves the pre-compaction anchor
                    // behind, a turn can carry a smaller tool set, and a user
                    // can edit or branch history. All three shrink the input
                    // legitimately, and none of them lands on exactly the same
                    // count. A provider truncating to a fixed window does, on
                    // every later request.
                    (acrossSends
                      ? stepUsage.inputTokens === priorInput
                      : stepUsage.inputTokens <= priorInput)
                  ) {
                    this.deps.session.contextProviderDroppingReported = true;
                    const note: SystemNoteMessage = {
                      type: 'system_note',
                      id: this.deps.newId(),
                      turnId,
                      ts: this.deps.now(),
                      kind: 'context_provider_dropping',
                      data: { inputTokens: stepUsage.inputTokens, priorInputTokens: priorInput },
                    };
                    await this.deps.backend.appendMessage(note).catch(() => {});
                  }
                  // Fail closed: reset on every step boundary so a missing final
                  // step's usage does not leave a stale value from an earlier step.
                  // The reply needed more room than the declared window had
                  // left after this request's own input. Both halves are the
                  // provider's numbers, read after the fact: the reserve that
                  // should have kept them apart was measured from a smaller
                  // previous reply. Say so once per send; the next request
                  // folds anyway because the baseline now exceeds the window.
                  if (
                    !contextWindowOverrunNoteWritten &&
                    midTurnState?.capacity !== undefined &&
                    stepUsage !== undefined &&
                    Number.isFinite(stepUsage.inputTokens) &&
                    stepUsage.inputTokens > 0 &&
                    Number.isFinite(stepUsage.outputTokens) &&
                    stepUsage.outputTokens > 0 &&
                    stepUsage.inputTokens + stepUsage.outputTokens > midTurnState.capacity
                  ) {
                    contextWindowOverrunNoteWritten = true;
                    const note: SystemNoteMessage = {
                      type: 'system_note',
                      id: this.deps.newId(),
                      turnId,
                      ts: this.deps.now(),
                      kind: 'context_window_overrun',
                      data: {
                        usedTokens: stepUsage.inputTokens + stepUsage.outputTokens,
                        declaredContextWindow: midTurnState.capacity,
                      },
                    };
                    await this.deps.backend.appendMessage(note).catch(() => {});
                  }
                  // Nothing declared, and the provider accepted a request past
                  // the window this model reports. Every other signal in this
                  // design stays dark there: no rejection to recover from, no
                  // plateau to read, and no declaration to arm the proactive
                  // threshold, so the session degrades quietly and
                  // indefinitely (#4634). Report the two real numbers and
                  // leave the decision with the user: a reported window is a
                  // hint, and Maka still declares nothing on their behalf.
                  //
                  // Once per crossing, not once per send. On these providers
                  // usage keeps growing past the line (305K → 322K observed),
                  // so the note fires on the transition: the previous accepted
                  // total was still inside the reported window and this one is
                  // not. The baseline carries that previous total across
                  // sessions through the persisted anchor, so a resumed
                  // session does not repeat a crossing it already reported.
                  if (
                    !contextReportedWindowNoteWritten &&
                    midTurnState !== undefined &&
                    midTurnState.capacity === undefined &&
                    stepUsage !== undefined &&
                    Number.isFinite(stepUsage.inputTokens) &&
                    stepUsage.inputTokens > 0 &&
                    Number.isFinite(stepUsage.outputTokens)
                  ) {
                    const reported = resolveSelectedModelContextWindow(
                      this.deps.backend.connection,
                      this.deps.backend.modelId,
                    );
                    const used = stepUsage.inputTokens + Math.max(0, stepUsage.outputTokens);
                    // `baselineTokens` still describes the request before this
                    // one: the capacity hook sets it from the previous step, or
                    // from the persisted anchor on a send's first request.
                    const previousTotal = midTurnState.baselineTokens;
                    const crossedNow =
                      reported !== undefined &&
                      used > reported &&
                      (previousTotal === undefined || previousTotal <= reported);
                    if (reported !== undefined && crossedNow) {
                      contextReportedWindowNoteWritten = true;
                      const note: SystemNoteMessage = {
                        type: 'system_note',
                        id: this.deps.newId(),
                        turnId,
                        ts: this.deps.now(),
                        kind: 'context_reported_window_exceeded',
                        data: { usedTokens: used, reportedContextWindow: reported },
                      };
                      await this.deps.backend.appendMessage(note).catch(() => {});
                    }
                  }
                  lastStepInputTokens = stepUsage?.inputTokens;
                  lastStepOutputTokens = stepUsage?.outputTokens;
                  lastStepActiveToolCount = activeToolsForRequest.length;
                  // A `finishReason: length` is deliberately not a trigger. The
                  // reply may have been cut because the provider ran out of
                  // window room, or because the provider's own output cap is
                  // lower than the one Maka sends. Those are indistinguishable
                  // from outside, and an indistinguishable signal must not
                  // drive an action; the cut reply is visible to the user
                  // either way (#4559).
                  if (stepUsage) {
                    completedStepUsage = mergeNormalizedUsage(completedStepUsage, stepUsage);
                    this.deps.session.cumulativeUsageCheckpoint = mergeNormalizedUsage(
                      this.deps.session.cumulativeUsageCheckpoint,
                      stepUsage,
                    );
                    await this.deps.backend.recordUsageCheckpoint?.({
                      ...this.deps.session.cumulativeUsageCheckpoint,
                      costUsd: this.deps.providerTelemetry.normalizedUsageCostUsd(
                        this.deps.session.cumulativeUsageCheckpoint,
                      ),
                    });
                  }
                }
              }
              if (event.kind === 'text-start') {
                if (stepText.length > 0 && event.providerItemBoundary === true) {
                  await flushStep();
                  currentStepMessageId = this.deps.newId();
                }
                stepTextPartStartOffset = stepText.length;
              } else if (event.kind === 'text') {
                if (event.text.length > 0) recordStepContent('text');
                stepText += event.text;
                if (event.text.length > 0) attemptSawText = true;
                queue.push({
                  type: 'text_delta',
                  id: this.deps.newId(),
                  turnId,
                  ts: this.deps.now(),
                  messageId: currentStepMessageId,
                  text: event.text,
                } satisfies TextDeltaEvent);
              } else if (event.kind === 'text-end') {
                if (event.providerOptions !== undefined) {
                  attemptSawContinuationMetadata = true;
                  stepTextProviderOptions = mergeTextProviderOptions(
                    stepTextProviderOptions,
                    stripUndefinedDeep(event.providerOptions) as NonNullable<
                      ModelMessage['providerOptions']
                    >,
                    stepTextPartStartOffset,
                  );
                }
                if (event.providerItemBoundary === true) {
                  await flushStep();
                  currentStepMessageId = this.deps.newId();
                }
              } else if (event.kind === 'thinking-start') {
                if (event.providerOptions !== undefined) {
                  attemptSawContinuationMetadata = true;
                }
                const part: AssistantThinkingPart = {
                  text: '',
                  ...(event.providerOptions !== undefined
                    ? { providerOptions: event.providerOptions }
                    : {}),
                };
                stepThinkingParts.push(part);
                if (event.reasoningPartId) {
                  stepThinkingPartsById.set(event.reasoningPartId, part);
                }
              } else if (event.kind === 'thinking') {
                if (event.text.length > 0) recordStepContent('thinking');
                if (event.text.length > 0) attemptSawThinking = true;
                if (event.providerOptions !== undefined) {
                  if (event.providerOptionsOrigin !== 'maka_transport') {
                    attemptSawContinuationMetadata = true;
                  }
                }
                const partId =
                  event.reasoningPartId ?? responsesReasoningItemId(event.providerOptions);
                let part: AssistantThinkingPart | undefined;
                if (typeof partId === 'string' && partId.length > 0) {
                  part = stepThinkingPartsById.get(partId);
                  if (
                    part &&
                    event.providerOptions === undefined &&
                    decodePlaintextResponsesReasoningState(part.providerOptions).kind === 'valid'
                  ) {
                    // The SDK does not suppress a stray delta after
                    // output_item.done. Keep it out of the finalized item or
                    // its durable summary boundaries will no longer match.
                    part = { text: '' };
                    stepThinkingParts.push(part);
                    stepThinkingPartsById.set(partId, part);
                  }
                  if (!part) {
                    part = { text: '' };
                    stepThinkingParts.push(part);
                    stepThinkingPartsById.set(partId, part);
                  }
                } else {
                  part = stepThinkingParts.at(-1);
                  if (
                    part &&
                    decodePlaintextResponsesReasoningState(part.providerOptions).kind === 'valid'
                  ) {
                    // An invalid next item has no usable stream id. Do not
                    // append its deltas to the finalized item: partial-error
                    // flush must keep that item's durable boundaries valid.
                    part = undefined;
                  }
                }
                if (!part) {
                  part = { text: '' };
                  stepThinkingParts.push(part);
                }
                const nextPartText = part.text + event.text;
                if (
                  event.reasoningSummaryText !== undefined &&
                  event.reasoningSummaryText !== nextPartText
                ) {
                  throw new Error(
                    'Streamed plaintext Responses reasoning does not match final provider summary',
                  );
                }
                part.text = nextPartText;
                if (event.providerOptions !== undefined) {
                  part.providerOptions = event.providerOptions;
                }
                queue.push({
                  type: 'thinking_delta',
                  id: this.deps.newId(),
                  turnId,
                  ts: this.deps.now(),
                  messageId: currentStepMessageId,
                  text: event.text,
                } satisfies ThinkingDeltaEvent);
              } else if (event.kind === 'thinking-signature') {
                attemptSawContinuationMetadata = true;
                let part = event.reasoningPartId
                  ? stepThinkingPartsById.get(event.reasoningPartId)
                  : stepThinkingParts.at(-1);
                if (!part) {
                  part = { text: '' };
                  stepThinkingParts.push(part);
                  if (event.reasoningPartId) {
                    stepThinkingPartsById.set(event.reasoningPartId, part);
                  }
                }
                part.signature = event.signature;
              } else if (event.kind === 'provider-tool-input') {
                // The provider has started its own tool. Even without a
                // final tool-call/result event, retrying can repeat external
                // work that the Runtime cannot observe or reconcile.
                attemptSawToolActivity = true;
              } else if (event.kind === 'tool-call') {
                attemptSawToolActivity = true;
                recordStepContent('tools');
                if (event.toolCall.providerExecuted) {
                  providerToolActivityCount += 1;
                  providerToolInputs.set(event.toolCall.toolCallId, event.toolCall.input);
                  queue.push({
                    type: 'tool_start',
                    id: this.deps.newId(),
                    turnId,
                    ts: this.deps.now(),
                    toolUseId: event.toolCall.toolCallId,
                    toolName: event.toolCall.toolName,
                    args: event.toolCall.input,
                    providerExecuted: true,
                    activityKind: 'websearch',
                    displayName: 'Web search',
                    stepId: currentStepMessageId,
                    ...(event.toolCall.providerOptions !== undefined
                      ? {
                          providerOptions: stripUndefinedDeep(event.toolCall.providerOptions),
                        }
                      : {}),
                  } satisfies ToolStartEvent);
                } else {
                  returnedToolCalls.push(event.toolCall);
                }
              } else if (event.kind === 'provider-tool-result') {
                attemptSawToolActivity = true;
                providerToolActivityCount += 1;
                const providerOutput = stripUndefinedDeep(event.output);
                queue.push({
                  type: 'tool_result',
                  id: this.deps.newId(),
                  turnId,
                  ts: this.deps.now(),
                  toolUseId: event.toolCallId,
                  providerExecuted: true,
                  ...(providerOutput !== undefined ? { providerOutput } : {}),
                  isError: event.isError === true,
                  content: providerToolResultContent(
                    event.toolName,
                    providerOutput,
                    providerToolInputs.get(event.toolCallId),
                  ),
                } satisfies ToolResultEvent);
                providerToolInputs.delete(event.toolCallId);
              } else if (event.kind === 'step-finish' && !incompleteFinish) {
                // The step's text/thinking deltas are all in (the stream is
                // drained in order), so flush this step's AssistantMessage and
                // rotate to a fresh id for the next step. Tool settlement
                // below receives this step's pre-rotation id, so durable replay
                // can regroup calls with this reasoning/text.
                await flushStep();
                if (midTurnState) {
                  // Durability clock: step N's thinking/text completion events
                  // are enqueued by flushStep just above, so only after this
                  // boundary can a seq-ack wait for step N mean anything. Wake
                  // waiters AFTER the increment or they would re-check a stale
                  // count and sleep.
                  midTurnState.flushedSteps += 1;
                  queue.wake();
                }
              }
            }
            watchdogState.current?.stop();
            // This timeout belongs to the physical request that just settled.
            // Consume it before recovery/flush work: a later persistence error
            // must not be reported as the already-handled watchdog timeout.
            const settledWatchdogTimeout = consumeWatchdogTimeout();
            providerOutcome = await result.outcome;
            const incompleteStreamTerminal = providerOutcome.kind === 'truncated';
            const incompleteStreamHasNoObservableOutput =
              incompleteStreamTerminal &&
              !attemptSawText &&
              !attemptSawThinking &&
              !attemptSawToolActivity &&
              !attemptSawContinuationMetadata;
            const attemptFailure =
              settledWatchdogTimeout?.error ??
              (providerOutcome.kind === 'completed' ? undefined : providerOutcome.failure);

            if (attemptFailure && !this.aborted) {
              const failure =
                settledWatchdogTimeout || providerOutcome.kind === 'completed'
                  ? this.deps.modelAdapter.normalizeFailure(attemptFailure)
                  : providerOutcome.failure;
              if (this.loopStopRequested) {
                terminalProviderError = settledWatchdogTimeout?.error ?? failure;
                terminalProviderErrorReason =
                  lastCompletedStepHadToolResult && failure.kind === 'timeout'
                    ? 'model_after_tool_timeout'
                    : undefined;
                break agentLoop;
              }
              // A retry is a fresh provider request that would run at least one
              // more step; with the send-level budget already spent there is
              // nothing left to grant it, so the error is terminal.
              const stepBudgetRemains = maxSteps === undefined || runtimeSteps < maxSteps;
              const recovered =
                stepBudgetRemains && attemptHasNoObservableOutput()
                  ? await this.deps.compaction.recoverFromOverflowError({
                      error: attemptFailure,
                      retryAlreadyUsed:
                        overflowRetryUsed || (midTurnState?.compactionAttemptedThisSend ?? false),
                      midTurnState,
                      turnId,
                      stepNumber: runtimeSteps,
                      currentMessages: attemptMessages,
                      activeTools: activeToolsForRequest,
                      queue,
                      onDiagnosticPatch: onMidTurnDiagnosticPatch,
                      origin: this,
                      ...(this.automaticMemoryCompactionSupported()
                        ? {
                            memoryCompactionDecision: () =>
                              this.automaticMemoryCompactionDecision(),
                            onMemoryCompaction: (dispatch: AutomaticMemoryCompactionDispatch) =>
                              this.dispatchAutomaticMemoryCompaction(dispatch),
                          }
                        : {}),
                      abortSignal: turnAbortController.signal,
                    })
                  : undefined;
              if (recovered) {
                overflowRetryUsed = true;
                // Recovery rebuilds the request from the durable ledger, whose
                // tool results intentionally retain their full bodies. Re-enter
                // the active-result projection before dispatch so an archived
                // result cannot reappear in provider context on the retry.
                const recoveredProjection = activeToolResultPruneHook
                  ? await activeToolResultPruneHook({
                      completedSteps: completedProviderSteps,
                      stepNumber: runtimeSteps,
                      model,
                      messages: recovered.messages,
                      activeTools: activeToolsForRequest,
                      resolveDispatch,
                    })
                  : undefined;
                attemptMessages = recoveredProjection?.messages ?? recovered.messages;
                continue;
              }
              // Window suggestion (#4559): the provider rejected a request and
              // no recovery is left — the one fold is spent, or there was no
              // seam. The baseline is a proven-fit total (input + output of an
              // accepted request), so it is a number the user can declare; the
              // trigger is `>=`, so declaring exactly it folds before this
              // point next time. Once per send, and only when the turn is
              // about to surface the error rather than continue.
              const acceptedTotal = midTurnState?.lastAcceptedTotalTokens;
              if (
                !contextWindowSuggestionNoteWritten &&
                failure.kind === 'context_overflow' &&
                midTurnState &&
                acceptedTotal !== undefined &&
                (midTurnState.capacity === undefined || acceptedTotal < midTurnState.capacity)
              ) {
                contextWindowSuggestionNoteWritten = true;
                const note: SystemNoteMessage = {
                  type: 'system_note',
                  id: this.deps.newId(),
                  turnId,
                  ts: this.deps.now(),
                  kind: 'context_window_suggestion',
                  data: {
                    suggestedContextWindow: acceptedTotal,
                    ...(midTurnState.capacity !== undefined
                      ? { declaredContextWindow: midTurnState.capacity }
                      : {}),
                  },
                };
                await this.deps.backend.appendMessage(note).catch(() => {});
              }
              // A folded projection was selected in this send and the provider
              // still rejects the request. That is worth saying, because the
              // usual remedy has already been applied; it is NOT proof that the
              // new message alone is the cause, since what remains also carries
              // the system prompt, the tool schemas, the summary and the recent
              // tail. A fold that failed open is deliberately excluded: that
              // request went out with its full raw history, so nothing about
              // its size can be concluded (#4559).
              if (
                !contextOverflowAfterCompactionNoteWritten &&
                failure.kind === 'context_overflow' &&
                midTurnState?.compactionAppliedThisSend === true
              ) {
                contextOverflowAfterCompactionNoteWritten = true;
                const note: SystemNoteMessage = {
                  type: 'system_note',
                  id: this.deps.newId(),
                  turnId,
                  ts: this.deps.now(),
                  kind: 'context_overflow_after_compaction',
                };
                await this.deps.backend.appendMessage(note).catch(() => {});
              }
              const idleWatchdogRecovery =
                settledWatchdogTimeout?.phase === 'idle' &&
                idleWatchdogRetryCount < MAX_IDLE_WATCHDOG_RETRIES_PER_STEP &&
                attemptCanRecoverWithSealedThinking();
              const incompleteStreamRecovery =
                incompleteStreamTerminal &&
                incompleteStreamRetryCount < MAX_INCOMPLETE_STREAM_RETRIES_PER_STEP &&
                incompleteStreamHasNoObservableOutput;
              // Same seal-and-retry contract as the watchdog path, entered when
              // the failure arrives as a retryable provider/network error
              // instead of a local idle timeout. `!idleWatchdogRecovery` keeps
              // every watchdog-shaped outcome on its existing path, and
              // `!attemptHasNoObservableOutput()` keeps no-output retries on
              // the plain budget so this one is spent only on sealed fragments.
              const sealedThinkingRecovery =
                !idleWatchdogRecovery &&
                failure.retryable &&
                sealedThinkingRetryCount < MAX_SEALED_THINKING_RETRIES_PER_STEP &&
                attemptCanRecoverWithSealedThinking() &&
                !attemptHasNoObservableOutput();
              if (
                (failure.retryable || idleWatchdogRecovery || incompleteStreamRecovery) &&
                failure.kind !== 'context_overflow' &&
                providerAttempt < MAX_PROVIDER_ATTEMPTS_PER_STEP &&
                stepBudgetRemains &&
                (attemptHasNoObservableOutput() ||
                  idleWatchdogRecovery ||
                  incompleteStreamRecovery ||
                  sealedThinkingRecovery)
              ) {
                if (idleWatchdogRecovery) idleWatchdogRetryCount += 1;
                if (sealedThinkingRecovery) sealedThinkingRetryCount += 1;
                if (incompleteStreamRecovery) incompleteStreamRetryCount += 1;
                if (
                  (idleWatchdogRecovery || sealedThinkingRecovery) &&
                  stepThinkingParts.length > 0
                ) {
                  await flushStep();
                  currentStepMessageId = this.deps.newId();
                }
                // The failed request did not return authoritative usage. Keep
                // effectiveness recoverable, but fail final metering closed.
                sawUnusableStepUsage = true;
                const delayMs = providerRetryDelayMs(providerAttempt, failure.retryAfterMs);
                const nextAttempt = providerAttempt + 1;
                const maxAttempts =
                  idleWatchdogRecovery || incompleteStreamRecovery || sealedThinkingRecovery
                    ? nextAttempt
                    : MAX_PROVIDER_ATTEMPTS_PER_STEP;
                const reason = providerRetryReason(failure.kind);
                queue.push({
                  type: 'provider_retry',
                  id: this.deps.newId(),
                  turnId,
                  ts: this.deps.now(),
                  phase: 'scheduled',
                  attempt: nextAttempt,
                  maxAttempts,
                  delayMs,
                  remainingMs: delayMs,
                  reason,
                } satisfies ProviderRetryEvent);
                await this.deps.providerRetrySleep(delayMs, turnAbortController.signal);
                providerAttempt = nextAttempt;
                queue.push({
                  type: 'provider_retry',
                  id: this.deps.newId(),
                  turnId,
                  ts: this.deps.now(),
                  phase: 'started',
                  attempt: providerAttempt,
                  maxAttempts,
                  reason,
                } satisfies ProviderRetryEvent);
                continue;
              }
              // Unrecoverable (not context-length, latch spent, no seam, or no
              // safe fold): surface the real provider error via the terminal
              // handler after settling any authoritative usage — never a
              // fabricated success.
              terminalProviderError = settledWatchdogTimeout?.error ?? failure;
              terminalProviderErrorReason =
                lastCompletedStepHadToolResult && failure.kind === 'timeout'
                  ? 'model_after_tool_timeout'
                  : undefined;
              break agentLoop;
            }
            break;
          }

          // If the stream loop exited because stop() flipped this.aborted while a
          // provider kept yielding after abort instead of throwing, route to the
          // abort handling below. Without this, the post-stream success path would
          // persist a partial assistant turn and emit a false end_turn completion.
          if (this.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }

          // Catch-all: flush any residual step content if the provider closed the
          // stream without a trailing `finish-step` for the last step.
          const providerStepId = currentStepMessageId;
          await flushStep();

          if (providerOutcome.kind !== 'completed') throw providerOutcome.failure;
          finishReason = providerOutcome.finishReason;
          await queue.waitUntilConsumedThroughCurrent();

          if (returnedToolCalls.length > 0) {
            const continuationBudgetRemains = maxSteps === undefined || runtimeSteps < maxSteps;
            if (continuationBudgetRemains && !this.deps.backend.loadTurnRuntimeEvents) {
              throw new Error('durable current-run reader is required for tool continuation');
            }
            if (this.deps.backend.loadTurnRuntimeEvents) {
              // Queue consumption alone does not prove that the latest assistant
              // facts remain readable. Fail before any external tool side effect
              // when the authoritative ledger became unavailable after the step.
              await loadDurableTurnEvents();
            }
            const toolsByName = new Map(providerTools.map((tool) => [tool.name, tool]));
            const settlementOutcomes = await Promise.allSettled(
              returnedToolCalls.map(async (toolCall) => {
                if (toolCall.providerExecuted) {
                  throw new Error(
                    `Provider-executed tool call "${toolCall.toolName}" is outside the main-agent tool loop`,
                  );
                }
                const sandboxBoundaryAttempt = isProviderSandboxBoundaryAttempt(toolCall);
                const deniedBoundaryRequest =
                  toolRuntime.hasSandboxBoundaryDenial() &&
                  toolCall.toolName.toLowerCase() === REQUEST_SANDBOX_BOUNDARY_TOOL_NAME;
                if (deniedBoundaryRequest) {
                  toolRuntime.forceSandboxBoundaryFinalization();
                }
                const blockedToolCall = sandboxBoundaryFinalizationStep || deniedBoundaryRequest;
                const requestedTool = blockedToolCall
                  ? undefined
                  : toolsByName.get(toolCall.toolName);
                const tool = requestedTool ?? toolsByName.get(INVALID_TOOL_NAME);
                if (!tool) throw new Error('Runtime invalid-tool fallback is unavailable');
                const unavailableError = sandboxBoundaryFinalizationStep
                  ? 'Sandbox boundary finalization does not permit tool execution.'
                  : deniedBoundaryRequest
                    ? SANDBOX_BOUNDARY_DENIED_FOR_TURN
                    : 'returned tool is unavailable';
                return await toolRuntime.settleToolCall({
                  tool,
                  turnId,
                  stepId: providerStepId,
                  toolCallId: toolCall.toolCallId,
                  // Provider metadata is persisted verbatim into an immutable
                  // RuntimeEvent, and a field the response did not carry
                  // arrives as an explicit `undefined` — which JSON drops, so
                  // the event no longer reads back as it was written and the
                  // store refuses it. One refusal took every tool-calling turn
                  // with it.
                  ...(toolCall.providerOptions !== undefined
                    ? {
                        providerOptions: stripUndefinedDeep(toolCall.providerOptions),
                      }
                    : {}),
                  input:
                    requestedTool !== undefined
                      ? toolCall.input
                      : {
                          tool: toolCall.toolName,
                          error: unavailableError,
                          ...(sandboxBoundaryAttempt ? { sandboxBoundaryAttempt: true } : {}),
                        },
                  abortSignal: turnAbortController.signal,
                  eventSink: queue,
                });
              }),
            );
            const rejectedSettlement = settlementOutcomes.find(
              (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
            );
            if (rejectedSettlement) throw rejectedSettlement.reason;
            const settlements = settlementOutcomes.map((outcome) => {
              // A rejected settlement was handled above, so preserving the
              // original array shape also preserves tool-call identity by index.
              if (outcome.status === 'rejected') throw outcome.reason;
              return outcome.value;
            });
            for (let index = 0; index < settlements.length; index += 1) {
              const settlement = settlements[index]!;
              const toolCall = returnedToolCalls[index];
              if (isPlanToolResult(settlement.result)) {
                this.handlePlanToolResult(settlement.result, queue);
              }
              if (
                returnedToolCalls.length === 1 &&
                toolCall?.toolName === YIELD_AGENT_GRAPH_TOOL_NAME &&
                isAgentGraphYieldToolResult(settlement.result)
              ) {
                this.handleAgentGraphYieldToolResult(settlement.result);
              }
            }
            await queue.waitUntilConsumedThroughCurrent();

            const continuationWillRun =
              (maxSteps === undefined || runtimeSteps < maxSteps) &&
              !this.loopStopRequested &&
              !this.aborted;
            if (continuationWillRun && providerOutcome.continuation === 'pending') {
              const persistedProjection = await loadDurableTurnProjection();
              const responseMessages = persistedOpenAiResponsesStepMessages(
                attemptMessages,
                persistedProjection,
                returnedToolCalls.map((toolCall) => toolCall.toolCallId),
              );
              if (responseMessages) {
                this.deps.modelAdapter.recordContinuationResponse(this.turnId, responseMessages);
              } else {
                this.deps.modelAdapter.clearContinuation(this.turnId);
              }
            }
          }

          completedProviderSteps.push({
            toolCalls: returnedToolCalls,
            ...(providerStepUsage ? { usage: providerStepUsage } : {}),
          });
          lastCompletedStepHadToolResult = returnedToolCalls.length > 0;
          const stepLimitReached = maxSteps !== undefined && runtimeSteps >= maxSteps;
          if (
            sandboxBoundaryFinalizationStep ||
            (stepLimitReached &&
              (toolRuntime.shouldFinalizeSandboxBoundary() ||
                toolRuntime.hasSandboxBoundaryDenial()))
          ) {
            this.loopStopReason = 'permission_handoff';
            this.loopStopRequested = true;
          }
          const mayTakeAnotherStep = !stepLimitReached && !this.loopStopRequested && !this.aborted;
          if (returnedToolCalls.length > 0 && mayTakeAnotherStep) {
            currentStepMessageId = this.deps.newId();
            continue agentLoop;
          }
          // Continuing the turn needs the durable current-run reader, for the
          // same reason the tool-call edge above demands it: the next request
          // has to carry the assistant output this step just produced, and only
          // the ledger projection has it. The no-reader fallback at the top of
          // the loop appends steering alone, which would ask the model to
          // redirect work it cannot see. Without a reader this edge is skipped
          // rather than throwing — the turn still completes and the Host folds
          // the message into the next Turn, which is today's behaviour.
          if (mayTakeAnotherStep && this.deps.backend.loadTurnRuntimeEvents) {
            // Last chance for a steer that landed after this turn's final
            // tool-call boundary — including the only boundary a tool-free
            // turn has, which precedes the model's first token. Without it the
            // message is never pulled at all, and whether Steer works would
            // depend on the model happening to call a tool afterwards (#3529).
            // A step-limited turn deliberately skips this: its budget is spent,
            // and the Host folds the message into the next Turn instead.
            const injectedBefore = this.injectedSteeringMessages.length;
            await this.drainSteeringInto(input, queue);
            // Re-read the stop flags: the drain awaits a durable push, so an
            // `after_step` stop or an abort can land while it is in flight, and
            // `mayTakeAnotherStep` is stale by now. Stop wins — the message is
            // already durable, so the Host folds it into the next Turn.
            if (
              this.injectedSteeringMessages.length > injectedBefore &&
              !this.loopStopRequested &&
              !this.aborted
            ) {
              currentStepMessageId = this.deps.newId();
              continue agentLoop;
            }
          }
          break agentLoop;
        }

        // Refine Tool Availability against the final active set. Deferred
        // loading may add tools, while boundary convergence may remove them;
        // comparing membership avoids missing a same-size swap.
        const finalActiveTools = currentRepairToolNames();
        if (
          finalActiveTools.length !== activeTools.length ||
          finalActiveTools.some((name, index) => name !== activeTools[index])
        ) {
          toolAvailabilityForTelemetry = computeToolAvailability(finalActiveTools);
        }

        // Final usage event. Each adapter result covers one provider request.
        // The send-level owner is `completedStepUsage`, which spans every
        // Runtime loop step and retry. Recording only the final result would
        // silently drop prior requests. An unusable sample in ANY request fails
        // the whole record closed (#972).
        try {
          const attemptTotalUsage = providerOutcome.usage;
          tokenUsage = sawUnusableStepUsage ? undefined : (completedStepUsage ?? attemptTotalUsage);
          if (tokenUsage) {
            tokenUsageCostUsd = this.deps.providerTelemetry.normalizedUsageCostUsd(tokenUsage);
            const contextBudgetForUsage = contextBudgetWithRequestProjectionDiagnostics(
              contextBudgetForTelemetry,
              activeToolResultPruneDiagnosticPatch,
              midTurnCompactDiagnosticPatch,
            );
            // Persisted alongside the live event so transcript rebuilds from
            // stored messages keep the TUI ctx segment instead of degrading to
            // `?/<window>` (#4019). Computed once; both writers share it.
            const contextRemainingForUsage = (() => {
              const contextWindow = resolveSelectedModelContextWindow(
                this.deps.backend.connection,
                this.deps.backend.modelId,
              );
              if (lastStepInputTokens !== undefined && contextWindow !== undefined) {
                return Math.max(0, contextWindow - lastStepInputTokens);
              }
              return undefined;
            })();
            // The anchor the NEXT turn judges its first request from — see
            // `LastRequestAnchor`. `input` below is the sum across this send's
            // steps and anchors nothing; the LAST step's real input and output
            // are what the next request re-sends. No usable input count, no
            // anchor: the next turn then has no proactive fold until its first
            // accepted request.
            const anchorInputTokens = finitePositive(lastStepInputTokens);
            const anchorOutputTokens =
              lastStepOutputTokens !== undefined && Number.isFinite(lastStepOutputTokens)
                ? Math.max(0, lastStepOutputTokens)
                : undefined;
            // One shared usage payload for the durable message and the live
            // event: twin per-field literals drifted before (#4019), so a field
            // now has exactly one definition site.
            const usageFields = {
              input: tokenUsage.inputTokens,
              output: tokenUsage.outputTokens,
              cacheHitInput: tokenUsage.cacheHitInputTokens,
              cacheMissInput: tokenUsage.cacheMissInputTokens,
              cacheMissInputSource: tokenUsage.cacheMissInputSource,
              cacheWriteInput: tokenUsage.cacheWriteInputTokens,
              reasoning: tokenUsage.reasoningTokens,
              total: tokenUsage.totalTokens,
              ...(tokenUsage.rawFinishReason !== undefined
                ? { rawFinishReason: tokenUsage.rawFinishReason }
                : {}),
              ...(runtimeSteps > 0 ? { runtimeSteps } : {}),
              ...(tokenUsage.cachedInputTokens > 0
                ? { cacheRead: tokenUsage.cachedInputTokens }
                : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0
                ? { cacheCreation: tokenUsage.cacheWriteInputTokens }
                : {}),
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              ...(contextBudgetForUsage ? { contextBudget: contextBudgetForUsage } : {}),
              ...(contextRemainingForUsage !== undefined
                ? { contextRemaining: contextRemainingForUsage }
                : {}),
              ...(providerRequestTraceId ? { providerRequestTraceId } : {}),
              ...(anchorInputTokens !== undefined
                ? {
                    lastRequestAnchor: {
                      inputTokens: anchorInputTokens,
                      ...(anchorOutputTokens !== undefined
                        ? { outputTokens: anchorOutputTokens }
                        : {}),
                      modelId: this.deps.backend.modelId,
                      ...(this.deps.backend.header.llmConnectionId !== undefined
                        ? { connectionId: this.deps.backend.header.llmConnectionId }
                        : {}),
                    },
                  }
                : {}),
            };
            const tu: TokenUsageMessage = {
              type: 'token_usage',
              id: this.deps.newId(),
              turnId,
              ts: this.deps.now(),
              ...usageFields,
            };
            await this.deps.backend.appendMessage(tu).catch(() => {});
            if (
              !contextCompactionFailedOpenNoteWritten &&
              shouldAppendContextCompactionFailedOpenNote(contextBudgetForUsage)
            ) {
              contextCompactionFailedOpenNoteWritten = true;
              const note: SystemNoteMessage = {
                type: 'system_note',
                id: this.deps.newId(),
                turnId,
                ts: this.deps.now(),
                kind: 'context_compaction_failed_open',
              };
              await this.deps.backend.appendMessage(note).catch(() => {});
            }
            if (
              !contextCompactedNoteWritten &&
              shouldAppendContextCompactedNote(contextBudgetForUsage)
            ) {
              contextCompactedNoteWritten = true;
              const note: SystemNoteMessage = {
                type: 'system_note',
                id: this.deps.newId(),
                turnId,
                ts: this.deps.now(),
                kind: 'context_compacted',
              };
              await this.deps.backend.appendMessage(note).catch(() => {});
            }
            queue.push({
              type: 'token_usage',
              id: this.deps.newId(),
              turnId,
              ts: this.deps.now(),
              ...usageFields,
            } satisfies TokenUsageEvent);
          }
        } catch {
          // best-effort; ai-sdk usage promise may reject on abort
        }

        // Nothing may await between this check and terminal emission: Stop must
        // win even when it arrives during post-stream usage persistence.
        if (this.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (terminalProviderError) throw terminalProviderError;
        const stopReason =
          this.loopStopReason ??
          (maxSteps !== undefined && finishReason === 'tool-calls'
            ? 'step_limit'
            : this.mapFinishReason(finishReason));
        trace.modelStreamCompleted(stopReason);
        const completeEvent = {
          type: 'complete',
          id: this.deps.newId(),
          turnId,
          ts: this.deps.now(),
          stopReason,
        } satisfies CompleteEvent;
        queue.push(completeEvent);
        if (this.memoryExtractRequested && this.deps.backend.memoryExtraction) {
          const snapshot = this.memorySourceSnapshot({
            trigger: 'extract',
            terminalEventId: completeEvent.id,
          });
          if (snapshot) {
            void queue
              .waitUntilConsumedThroughCurrent()
              .then(() => this.deps.backend.memoryExtraction?.extract(snapshot))
              .catch(() => undefined);
          }
        }
      } catch (err) {
        streamStatus = this.aborted ? 'aborted' : 'error';
        streamErrorClass = this.deps.modelAdapter.classifyError(
          currentWatchdogTimeout()?.error ?? err,
        );
        // Flush the in-flight step's partial text/thinking before the terminal
        // abort/error events. Earlier steps already flushed at their
        // `finish-step`; this keeps their and this step's streamed-out output on
        // BOTH exits — user stop and provider error / watchdog timeout — so
        // partialOutputRetained reflects what the user actually saw.
        await flushStep().catch(() => {});
        if (this.aborted) {
          queue.push({
            type: 'abort',
            id: this.deps.newId(),
            turnId,
            ts: this.deps.now(),
            reason: 'user_stop',
          } satisfies AbortEvent);
          queue.push({
            type: 'complete',
            id: this.deps.newId(),
            turnId,
            ts: this.deps.now(),
            stopReason: 'user_stop',
          } satisfies CompleteEvent);
        } else {
          const terminalError = currentWatchdogTimeout()?.error ?? err;
          queue.push(this.makeErrorEvent(turnId, terminalError, terminalProviderErrorReason));
          trace.modelStreamFailed(
            streamErrorClass,
            terminalError,
            priorReplayFailureTrace(priorReplay),
          );
          queue.push({
            type: 'complete',
            id: this.deps.newId(),
            turnId,
            ts: this.deps.now(),
            stopReason: 'error',
          } satisfies CompleteEvent);
        }
      } finally {
        watchdogState.current?.stop();
        if (this.watchdog === watchdogState.current) this.watchdog = null;
        contextBudgetForTelemetry = contextBudgetWithRequestProjectionDiagnostics(
          contextBudgetForTelemetry,
          activeToolResultPruneDiagnosticPatch,
          midTurnCompactDiagnosticPatch,
        );
        // `tokenUsage` still backfills from the completed steps when the send
        // ended without a final `usage`: the terminal outcome and the
        // `token_usage` SessionEvent below both read it. An unusable sample in
        // any step fails it closed rather than posing a partial sum as the
        // whole call (#972).
        //
        // The send-level `recordLlmCall` that used to sit here is gone (#1679).
        // It measured the same provider requests the canonical seam now settles
        // into `ModelCallAttempt`, one record per physical request instead of
        // one aggregate per send, and keeping both would have been two
        // independent meters free to disagree.
        //
        // What does NOT follow it out is the diagnostics that rode on it. The
        // exhausted and aborted paths emit no `token_usage` SessionEvent, so
        // their compaction decisions and the accumulated usage of the steps that
        // did complete had that record as their only durable home. They move to
        // the run trace, which carries no cost and meters nothing.
        if (!tokenUsage && completedStepUsage && !sawUnusableStepUsage) {
          tokenUsage = completedStepUsage;
          tokenUsageCostUsd = this.deps.providerTelemetry.normalizedUsageCostUsd(tokenUsage);
        }
        trace.sendDiagnostics({
          status: streamStatus,
          ...(streamErrorClass ? { errorClass: streamErrorClass } : {}),
          ...(tokenUsage
            ? {
                inputTokens: tokenUsage.inputTokens,
                outputTokens: tokenUsage.outputTokens,
                totalTokens: tokenUsage.totalTokens,
              }
            : {}),
          ...(contextBudgetForTelemetry !== undefined
            ? { contextBudget: contextBudgetForTelemetry }
            : {}),
          ...(toolAvailabilityForTelemetry !== undefined
            ? { toolAvailability: toolAvailabilityForTelemetry }
            : {}),
        });
        queue.close();
      }
    })();

    let drainedNormally = false;
    try {
      // drain() carries the seq-ack semantics (consumer pull = processed ack);
      // every consumer-facing path must go through it.
      yield* this.drain(queue);
      drainedNormally = true;
    } finally {
      if (!drainedNormally) turnAbortController.abort();
      await pumpDone.catch(() => {});
    }
  }

  private async executeCodeModeCell(
    eventSink: DurableSessionEventSink,
    code: string,
    context: MakaToolContext,
  ): Promise<unknown> {
    const snapshot = new Map(this.codeModeTools);
    let nestedOutputBytes = 0;
    let nestedOutputLimitExceeded = false;
    const nestedEventSink: DurableSessionEventSink = {
      push: (event) => {
        if (event.type === 'tool_output_delta') {
          const nextBytes = new TextEncoder().encode(event.chunk).byteLength;
          if (
            nestedOutputLimitExceeded ||
            nestedOutputBytes + nextBytes > DEFAULT_CODE_MODE_EXECUTION_POLICY.maxToolOutputBytes
          ) {
            nestedOutputLimitExceeded = true;
            return;
          }
          nestedOutputBytes += nextBytes;
        }
        eventSink.push(event);
      },
      pushAndWaitUntilConsumed: (event) => eventSink.pushAndWaitUntilConsumed(event),
    };
    // A permit is held across the cell's complete lifecycle, not just its
    // sandbox run: `executeCodeCell` settles only once the cell's host
    // operations have drained, so releasing on settlement covers the drain.
    // The sandbox worker cap cannot serve this purpose — on cancellation
    // `runCodeMode` releases its worker and rejects at once, by design, while
    // host operations started by the cell may still be running with durable
    // side effects. Only the Runtime waits for those, so only the Runtime can
    // bound them; releasing when the worker is released would let repeated
    // cancellation accumulate host work without bound.
    //
    // One cell may wait; the next is turned away rather than queued, which is
    // what the Code Mode adapter did before this moved to the side that owns
    // execution. Nothing awaits between reading `waitingCount` and the enqueue
    // inside `acquire`, so the pair is atomic.
    if (this.deps.codeCellAdmission.waitingCount >= MAX_WAITING_CODE_MODE_CELLS) {
      return {
        ok: false,
        error: { kind: 'limit_exceeded', message: 'Code Mode execution queue is full' },
        toolCalls: [],
      } satisfies CodeModeExecutionResult;
    }
    const permit = await this.deps.codeCellAdmission.acquire(context.abortSignal);
    try {
      return await executeCodeCell({
        code,
        signal: context.abortSignal,
        tools: [...snapshot.values()].map((tool) => ({
          name: tool.name,
        })),
        isFatalToolError: isRuntimeCommitBoundaryError,
        callTool: async (name, input, signal) => {
          const tool = snapshot.get(name);
          if (!tool) throw new Error(`Tool "${name}" is not active or nestable in this cell`);
          const parsedInput = await validateCodeModeToolInput(tool, input);
          const settlement = await this.toolRuntime.settleToolCall({
            tool,
            turnId: context.turnId,
            toolCallId: `${context.toolCallId}:nested:${this.deps.newId()}`,
            input: parsedInput,
            abortSignal: signal,
            eventSink: nestedEventSink,
            origin: 'code_mode',
            parentToolCallId: context.toolCallId,
            ...(context.operationId ? { parentOperationId: context.operationId } : {}),
            maxResultBytes: DEFAULT_CODE_MODE_EXECUTION_POLICY.maxToolOutputBytes,
          });
          if (settlement.providerError !== undefined) {
            throw new Error(settlement.providerError);
          }
          if (nestedOutputLimitExceeded) {
            throw new Error('Code Mode nested output byte limit exceeded');
          }
          return settlement.result;
        },
      });
    } finally {
      permit.release();
    }
  }

  private handlePlanToolResult(result: PlanToolResult, queue: AsyncEventQueue<SessionEvent>): void {
    const turnId = this.turnId;
    if (result.kind === 'plan_submitted') {
      const proposal = result.proposal;
      queue.push({
        type: 'plan_submitted',
        id: this.deps.newId(),
        turnId,
        ts: this.deps.now(),
        planId: proposal.planId,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        title: proposal.title,
        ...(proposal.overview ? { overview: proposal.overview } : {}),
        ...(proposal.risks ? { risks: proposal.risks } : {}),
        steps: proposal.steps.map((step) => ({ ...step, status: 'pending' })),
      });
      this.runTrace?.emit('plan', 'plan_submitted', 'Plan submitted', {
        planId: proposal.planId,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        storeVersion: result.storeVersion,
      });
      this.loopStopReason = 'plan_handoff';
      this.loopStopRequested = true;
      return;
    }

    const traceType = result.kind;
    this.runTrace?.emit('plan', traceType, 'Plan execution state changed', {
      planId: result.execution.planId,
      proposalId: result.execution.proposalId,
      executionId: result.execution.executionId,
      storeVersion: result.storeVersion,
    });
    // Completing or cancelling the execution is a tool boundary, not the end of
    // the conversational Turn. The execution prompt tells the model to persist
    // final progress before its final response, so let it consume this result
    // and produce that response on the next provider step.
  }

  private handleAgentGraphYieldToolResult(result: YieldAgentGraphToolResult): void {
    this.runTrace?.emit('agent_graph', 'graph_supervisor_yielded', 'Graph supervisor yielded', {
      pendingWorkCount: result.pendingWorkCount,
      liveOperatorCount: result.liveOperatorCount,
      reason: result.reason,
    });
    this.loopStopReason = 'graph_yield';
    this.loopStopRequested = true;
  }

  private mapFinishReason(reason: ModelFinishReason): CompleteEvent['stopReason'] {
    return this.deps.modelAdapter.mapFinishReason(reason);
  }

  private makeErrorEvent(turnId: string, err: unknown, reasonOverride?: string): ErrorEvent {
    return this.deps.modelAdapter.makeErrorEvent(turnId, err, reasonOverride);
  }

  /** Materialize canonical RuntimeEvent history into ai-sdk's message format. */
  private async buildPriorMessages(input: BackendSendInput): Promise<PriorReplayResult> {
    if (!input.runtimeContext) {
      return {
        status: 'ready',
        messages: [],
        gate: 'runtime_replay_text_only',
        diagnostics: [],
      };
    }
    const rawPriorRuntimeContext = input.runtimeContext.filter(
      (event) => event.turnId !== input.turnId,
    );
    // Everything below reads EFFECTIVE model history: raw events folded through
    // the durable projection-transition reducer (#4283). Replay, budgeting and
    // compaction share one input, so no RuntimeEvent replay path can resurrect
    // content a committed transition removed.
    const preparedContextBudget = await this.deps.compaction.prepareContextBudgetPolicy(
      rawPriorRuntimeContext,
      input.turnId,
    );
    const priorRuntimeContext = preparedContextBudget.events;
    const providerReasoningReplayEventIds = compatibleProviderReasoningReplayEventIds(
      priorRuntimeContext,
      input.runtimeContextInvocations,
      this.deps.backend.providerStateIdentity,
      this.deps.backend.modelId,
    );
    let contextBudget = preparedContextBudget.policy;
    const budgeted = applyRuntimeEventContextBudget(priorRuntimeContext, contextBudget);
    let runtimeContext = budgeted?.events ?? priorRuntimeContext;
    let contextBudgetDiagnostic = budgeted?.diagnostic;
    let projectedHistoryCompactCheckpoint = budgeted?.historyCompactCheckpoint;
    if (preparedContextBudget.diagnosticPatch) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        preparedContextBudget.diagnosticPatch,
      );
    }

    // No pre-turn estimate gate: the turn's first request is judged by the
    // request-projection hook from the previous request's real usage, and by
    // the provider when it goes out (#4559).
    // The boundary belongs to the RuntimeEvent projection above.
    const replayBoundary = (fromRuntimeReplay: boolean) =>
      fromRuntimeReplay && projectedHistoryCompactCheckpoint
        ? { latestHistoryCompactCheckpoint: projectedHistoryCompactCheckpoint }
        : {};

    const plan = buildRuntimeEventModelReplayPlan(
      runtimeContext,
      // `runtimeContext` may be a budget/history-search slice; the tool-turn
      // thinking skip is a whole-history invariant, so seed it from the full
      // prior ledger so a sliced-in tool-turn thinking still gets skipped.
      { toolActivityTurnIds: collectToolActivityTurnIds(priorRuntimeContext) },
    );
    const hasProviderHistoryCompactCheckpoint =
      projectedHistoryCompactCheckpoint !== undefined &&
      isProviderHistoryCompactCheckpoint(projectedHistoryCompactCheckpoint);
    const materializeReplayFallback = (): Promise<ModelMessage[]> =>
      this.deps.messageProjection.materializeRuntimeReplayTextOnly(
        this.imageBudget,
        plan,
        projectedHistoryCompactCheckpoint,
      );
    if (plan.items.length === 0 && !hasProviderHistoryCompactCheckpoint) {
      return {
        status: 'ready',
        messages: await materializeReplayFallback(),
        gate: 'runtime_replay_text_only',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...replayBoundary(true),
      };
    }

    if (hasBlockingReplayDiagnostics(plan)) {
      return {
        status: 'ready',
        messages: await materializeReplayFallback(),
        gate: input.continuation
          ? 'runtime_replay_text_only'
          : 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...replayBoundary(true),
      };
    }

    if (!plan.hasProviderNativeSemantics) {
      return {
        status: 'ready',
        messages: await this.deps.messageProjection.materializeRuntimeReplayPlan(
          plan,
          this.imageBudget,
          projectedHistoryCompactCheckpoint,
          providerReasoningReplayEventIds,
        ),
        gate: 'runtime_replay_text_only',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...replayBoundary(true),
      };
    }

    if (!this.deps.messageProjection.canReplayProviderNative(plan)) {
      // Degrade per item, not per plan: an unsupported provider-executed pair
      // must not cost unrelated client tool history (#2972). Thinking items
      // stay in the plan; materializeRuntimeReplayPlan degrades unsupported
      // reasoning per item via reasoningReplay.
      const degradedPlan = this.deps.messageProjection.dropUnsupportedReplayItems(plan);
      return {
        status: 'ready',
        messages:
          degradedPlan.items.length > 0 || hasProviderHistoryCompactCheckpoint
            ? await this.deps.messageProjection.materializeRuntimeReplayPlan(
                degradedPlan,
                this.imageBudget,
                projectedHistoryCompactCheckpoint,
                providerReasoningReplayEventIds,
              )
            : await materializeReplayFallback(),
        gate: input.continuation
          ? 'runtime_replay_text_only'
          : 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...replayBoundary(true),
      };
    }

    return {
      status: 'ready',
      messages: await this.deps.messageProjection.materializeRuntimeReplayPlan(
        plan,
        this.imageBudget,
        projectedHistoryCompactCheckpoint,
        providerReasoningReplayEventIds,
      ),
      gate: 'runtime_replay_provider_native',
      diagnostics: plan.diagnostics,
      runtimeEventCount: runtimeContext.length,
      ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
      ...replayBoundary(true),
    };
  }

  private async resolveSystemPrompt(): Promise<string | undefined> {
    const turnId = this.turnId;
    if (typeof this.deps.backend.systemPrompt === 'function') {
      return await this.deps.backend.systemPrompt({
        sessionId: this.deps.backend.sessionId,
        turnId,
        cwd: this.deps.backend.header.cwd,
        emitSkillCatalogTrace: (message, data) =>
          this.runTrace?.emit('skill', 'skill_catalog_built', message, data),
      });
    }
    return this.deps.backend.systemPrompt;
  }

  private async *drain(queue: AsyncEventQueue<SessionEvent>): AsyncIterable<SessionEvent> {
    try {
      for await (const ev of queue) {
        yield ev;
        // Generator backpressure IS the consumer's ack: this line runs only
        // when the consumer's loop body finished for `ev` and pulled the next
        // event, so `consumedCount` counts fully PROCESSED events. AgentRun
        // persists each mapped event before continuing, so an acked event is
        // either durable or deliberately skipped (partials, non-terminal
        // errors) — exactly the set a durable read can ever return.
        queue.ackConsumed();
      }
    } finally {
      // The consumer abandoned or finished the stream; wake any seq-ack waiter
      // so it observes `consumerDetached` instead of blocking forever.
      queue.noteConsumerDetached();
    }
  }

  /**
   * Drain the caller's pending steering at a step boundary. Each message is
   * echoed as a `steering_message` event (so the ledger + transcript render the
   * interjection in place) and accumulated as an envelope-wrapped user message
   * for injection into subsequent provider requests.
   *
   * Persist-before-include invariant: the initial user message is durable
   * before the backend is invoked, and a steered message must hold the same
   * line — the provider must never start executing a directive the ledger does
   * not carry. The seq-ack boundary provides that without a second write path:
   * the consumer's pull is the ack, and AgentRun persists each mapped event
   * before continuing (see drain()), so once everything enqueued up to the
   * steering event is consumed, the event is durable. If the consumer detaches
   * (the persist path failed or the turn is being torn down) before that, the
   * message is nacked and NOT included in any request; an abort after the push
   * waits for that same convergence — durable ⇒ ack (history owns it), detach
   * ⇒ nack — and only then throws so the dying request is never sent.
   */
  private async drainSteeringInto(
    input: BackendSendInput,
    queue: AsyncEventQueue<SessionEvent>,
  ): Promise<void> {
    const turnId = this.turnId;
    const abortSignal = this.abortController.signal;
    const pull = input.pullSteering;
    if (!pull) return;
    const leases = pull();
    if (leases.length === 0) return;
    // Binary settlement: every pulled lease settles exactly once, decided
    // ONLY by the persistence fact — durably consumed ⇒ ack + injection set;
    // provably never persisted (never pushed, or the consumer detached
    // without consuming it) ⇒ nack. An abort does NOT settle a pushed lease:
    // it only stops new pushes and the dying request; the wait continues
    // until the teardown converges it (the flow drains after terminal events
    // or detaches on failure), because nacking a durably appended event
    // would put the same directive in the account twice — once via history
    // replay, once via the reclaimed queue.
    const undelivered = [...leases];
    try {
      for (const lease of leases) {
        if (this.aborted || abortSignal?.aborted) {
          // Never pushed: settles as undelivered.
          throw Object.assign(new Error('aborted before steering was pushed'), {
            name: 'AbortError',
          });
        }
        if (queue.consumerDetached) {
          throw new Error('steering message was not durably consumed: event consumer detached');
        }
        // Materialize provider content before publishing the durable event.
        // After consumption there must be no fallible gap before ack/injection.
        const eventId = this.deps.newId();
        const providerContent = await this.deps.messageProjection.appendImageParts(
          this.imageBudget,
          buildSteeringEnvelope(formatTextWithInlineRefs(lease.content.text, lease.content)),
          lease.content.attachments,
          `steering:${eventId}`,
        );
        if (this.aborted || abortSignal?.aborted) {
          throw Object.assign(new Error('aborted before steering was pushed'), {
            name: 'AbortError',
          });
        }
        if (queue.consumerDetached) {
          throw new Error('steering message was not durably consumed: event consumer detached');
        }
        await queue.pushAndWaitUntilConsumed({
          type: 'steering_message',
          id: eventId,
          turnId,
          ts: this.deps.now(),
          messageId: lease.messageId,
          content: lease.content,
          ...(lease.submittedContentDigest
            ? { submittedContentDigest: lease.submittedContentDigest }
            : {}),
        } satisfies SessionEvent);
        // The mapped RuntimeEvent inherits this session event's id, so the
        // injected message and its future ledger replay share one identity.
        this.injectedSteeringMessages.push(steeringModelMessage(eventId, providerContent));
        input.ackSteering?.([lease.id]);
        undelivered.shift();
        if (this.aborted || abortSignal?.aborted) {
          // Settled (the ledger owns the message; the next turn replays it),
          // but the send is dying: stop before any request is built with it.
          throw Object.assign(new Error('aborted after steering was durable'), {
            name: 'AbortError',
          });
        }
      }
    } catch (error) {
      if (undelivered.length > 0) {
        input.nackSteering?.(undelivered.map((lease) => lease.id));
      }
      throw error;
    }
  }
}

function isPlanToolResult(output: unknown): output is PlanToolResult {
  if (!output || typeof output !== 'object') return false;
  return [
    'plan_submitted',
    'plan_progress_updated',
    'plan_execution_completed',
    'plan_execution_cancelled',
  ].includes(String((output as { kind?: unknown }).kind));
}

function isAgentGraphYieldToolResult(output: unknown): output is YieldAgentGraphToolResult {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return false;
  const result = output as Record<string, unknown>;
  return (
    Object.keys(result).length === 4 &&
    result.kind === 'agent_graph_yielded' &&
    typeof result.pendingWorkCount === 'number' &&
    Number.isSafeInteger(result.pendingWorkCount) &&
    result.pendingWorkCount > 0 &&
    typeof result.liveOperatorCount === 'number' &&
    Number.isSafeInteger(result.liveOperatorCount) &&
    result.liveOperatorCount >= 0 &&
    typeof result.reason === 'string' &&
    result.reason.length > 0 &&
    result.reason.length <= 4_000 &&
    result.reason.trim() === result.reason
  );
}

function priorReplayFailureTrace(replay: {
  gate: string;
  diagnostics: readonly { code: string }[];
}): { gate: string; diagnosticCodes: string[] } {
  return {
    gate: replay.gate,
    diagnosticCodes: [...new Set(replay.diagnostics.map((diagnostic) => diagnostic.code))],
  };
}

class ContinuationReplayEmptyError extends Error {
  readonly code = 'continuation_replay_empty';

  constructor(
    readonly replayGate: string,
    readonly diagnosticCodes: readonly string[],
  ) {
    super(`Continuation replay is empty after ${replayGate}`);
    this.name = 'ContinuationReplayEmptyError';
  }
}

function mergeActiveToolResultPruneDiagnosticPatches(
  left: ActiveToolResultPruneDiagnosticPatch,
  right: ActiveToolResultPruneDiagnosticPatch,
): ActiveToolResultPruneDiagnosticPatch {
  return {
    ...sumOptionalCounts('activePrunedToolResults', left, right),
    ...sumOptionalCounts('activeSupersededToolResults', left, right),
    ...sumOptionalCounts('activeDuplicateToolResults', left, right),
    ...sumOptionalCounts('activeArchiveFailures', left, right),
    ...sumOptionalCounts('activeEstimatedTokensSaved', left, right),
  };
}

function mergeNormalizedUsage(
  current: NormalizedAiSdkUsage | undefined,
  next: NormalizedAiSdkUsage,
): NormalizedAiSdkUsage {
  if (!current) return next;
  const cacheMissInputSource =
    current.cacheMissInputSource === 'explicit' || next.cacheMissInputSource === 'explicit'
      ? 'explicit'
      : 'derived';
  const cacheHitInputTokens = current.cacheHitInputTokens + next.cacheHitInputTokens;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheHitInputTokens,
    cacheMissInputTokens: current.cacheMissInputTokens + next.cacheMissInputTokens,
    cacheMissInputSource,
    cacheWriteInputTokens: current.cacheWriteInputTokens + next.cacheWriteInputTokens,
    reasoningTokens: current.reasoningTokens + next.reasoningTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(next.rawFinishReason !== undefined ? { rawFinishReason: next.rawFinishReason } : {}),
    cachedInputTokens: cacheHitInputTokens,
  };
}

function sumOptionalCounts<K extends keyof ActiveToolResultPruneDiagnosticPatch>(
  key: K,
  left: ActiveToolResultPruneDiagnosticPatch,
  right: ActiveToolResultPruneDiagnosticPatch,
): Pick<ActiveToolResultPruneDiagnosticPatch, K> | Record<string, never> {
  const total = (left[key] ?? 0) + (right[key] ?? 0);
  return total > 0 ? ({ [key]: total } as Pick<ActiveToolResultPruneDiagnosticPatch, K>) : {};
}

function contextBudgetWithRequestProjectionDiagnostics(
  base: ContextBudgetDiagnostic | undefined,
  patch: ActiveToolResultPruneDiagnosticPatch,
  compactionPatch: Partial<ContextBudgetDiagnostic> | undefined,
): ContextBudgetDiagnostic | undefined {
  const prunePatch = hasActiveToolResultPruneDiagnosticPatch(patch) ? patch : undefined;
  const mergedPatch = mergeContextBudgetDiagnosticPatches(prunePatch, compactionPatch);
  if (!mergedPatch) return base;
  return mergeContextBudgetDiagnostic(base ?? minimalContextBudgetDiagnostic(), mergedPatch);
}

function projectMemoryConversationPrefix(
  messages: readonly ModelMessage[],
  eventMessagePositions?: Readonly<Record<string, readonly number[]>>,
): {
  messages: ModelMessage[];
  eventMessagePositions?: Readonly<Record<string, readonly number[]>>;
} {
  // Context visibility and durable evidence authority are separate boundaries.
  // Keep the exact source prefix so the auxiliary request preserves referents
  // and provider-cache shape. The Evidence Index and trusted admission layer
  // independently restrict durable citations to user-authored RuntimeEvents.
  return {
    messages: [...messages],
    ...(eventMessagePositions ? { eventMessagePositions } : {}),
  };
}

function memoryExtractionModelHeader(
  header: SessionHeader,
): MemoryExtractionSourceSnapshot['sourceHeader'] {
  return {
    ...(header.llmConnectionId === undefined ? {} : { llmConnectionId: header.llmConnectionId }),
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    ...(header.thinkingLevel !== undefined ? { thinkingLevel: header.thinkingLevel } : {}),
  };
}
