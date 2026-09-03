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

import type {
  HistoryCompactSummarizer,
  HistoryCompactSummaryInput,
} from './ai-sdk-compaction-contract.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import {
  canContinueHistoryCompactCheckpointForModel,
  historyCompactCheckpointToModelMessage,
  isProviderHistoryCompactCheckpoint,
  type HistoryCompactProviderState,
} from './history-compact-checkpoint.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ModelMessage } from './model-protocol.js';
import {
  admitProviderReasoningReplayItems,
  buildRuntimeEventModelReplayPlan,
  compatibleProviderReasoningReplayEventIds,
  type RuntimeEventModelReplayItem,
} from './model-history.js';
import { withProviderStreamTracking } from './provider-request-telemetry.js';
import { effectiveReplayToolResultOutput } from './durable-tool-result-projection.js';
import { classifyError, providerFailureDiagnostic } from './provider-error-classification.js';

export interface BuildOpenAiCodexHistoryCompactorOptions {
  resolveModel: () => unknown;
  connectionId: string;
  providerStateIdentity?: `sha256:${string}`;
  modelId: string;
  providerOptions?: Record<string, unknown>;
}

export function buildOpenAiCodexHistoryCompactor(options: BuildOpenAiCodexHistoryCompactorOptions) {
  const openAiOptions = options.providerOptions?.openai;
  const providerOptions = {
    ...options.providerOptions,
    openai: {
      ...(openAiOptions !== null &&
      typeof openAiOptions === 'object' &&
      !Array.isArray(openAiOptions)
        ? openAiOptions
        : {}),
      compactionTrigger: true,
    },
  };
  return async (input: HistoryCompactSummaryInput): Promise<HistoryCompactProviderState> => {
    try {
      const previous = input.previousCheckpoint;
      const canContinuePrevious =
        previous &&
        isProviderHistoryCompactCheckpoint(previous) &&
        canContinueHistoryCompactCheckpointForModel(
          previous,
          { providerType: 'openai-codex' },
          options.connectionId,
          options.modelId,
        );
      const events = canContinuePrevious
        ? (input.newlyFoldedRuntimeEvents ?? [])
        : input.source.foldedRuntimeEvents;
      const providerReasoningReplayEventIds = compatibleProviderReasoningReplayEventIds(
        events,
        input.source.runHeaders,
        options.providerStateIdentity,
        options.modelId,
        input.runId,
      );
      const projectedMessages = openAiCodexCompactionMessages(
        events,
        providerReasoningReplayEventIds,
      );
      if (canContinuePrevious) {
        projectedMessages.unshift(historyCompactCheckpointToModelMessage(previous));
      }
      // Whether this input fits the compaction endpoint is its own answer;
      // nothing is trimmed on a local estimate beforehand (#4559).
      const messages = projectedMessages;

      const providerRequestTracker = input.providerRequestTracker;
      const ai = await loadAiSdkModule();
      const model = providerRequestTracker
        ? withProviderStreamTracking({
            model: options.resolveModel(),
            wrapLanguageModel: ai.wrapLanguageModel,
            tracker: providerRequestTracker,
            historyCompactRoute: 'provider_native',
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          })
        : options.resolveModel();
      let streamError: unknown;
      const result = ai.streamText({
        model,
        messages,
        providerOptions,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        maxRetries: 0,
        onError: ({ error }: { error: unknown }) => {
          streamError = error;
        },
      });
      const content: unknown[] = [];
      for await (const part of result.fullStream) {
        if (isStreamErrorPart(part)) throw part.error;
        if (isOpenAiCompactionPart(part)) content.push(part);
      }
      if (streamError) throw streamError;
      const state = extractOpenAiCodexCompactionState(
        content,
        options.connectionId,
        options.modelId,
      );
      if (!state) throw new HistoryCompactSummarizerError('invalid_provider_state');
      return state;
    } catch (error) {
      if (error instanceof HistoryCompactSummarizerError) throw error;
      if (classifyError(error) === 'ContextLength') {
        throw new HistoryCompactSummarizerError('input_too_large', { cause: error });
      }
      throw new HistoryCompactSummarizerError('provider_error', { cause: error });
    }
  };
}

/**
 * Prefer the Codex-native checkpoint, but retain a portable liveness path when
 * the native protocol is unavailable for this request. The fallback is narrow:
 * provider capacity/auth/transient failures keep their original outcome rather
 * than doubling traffic through the same unhealthy connection.
 */
export function withOpenAiCodexHistoryCompactionFallback(
  preferred: HistoryCompactSummarizer,
  fallback: HistoryCompactSummarizer,
): HistoryCompactSummarizer {
  return async (input) => {
    try {
      return await preferred(input);
    } catch (error) {
      if (!shouldFallbackFromOpenAiCodexHistoryCompaction(error, input.abortSignal)) throw error;
      return await fallback(input);
    }
  };
}

export function shouldFallbackFromOpenAiCodexHistoryCompaction(
  error: unknown,
  abortSignal?: AbortSignal,
): boolean {
  if (abortSignal?.aborted || hasAbortCause(error)) return false;
  if (!(error instanceof HistoryCompactSummarizerError)) return false;
  if (error.reason === 'input_too_large' || error.reason === 'invalid_provider_state') return true;
  if (error.reason !== 'provider_error') return false;
  const diagnostic = providerFailureDiagnostic(error);
  return diagnostic.errorClass === 'RequestRejected' && !diagnostic.retryable;
}

function hasAbortCause(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error && current.name === 'AbortError') return true;
    current =
      typeof current === 'object' && current !== null && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/**
 * Materialize provider history by assistant step, not ledger append order.
 * Runtime persists tool calls/results before a step's reasoning/text closer;
 * grouping lets the compactor keep settled tool evidence before grounded text.
 */
function openAiCodexCompactionMessages(
  events: readonly RuntimeEvent[],
  providerReasoningReplayEventIds: ReadonlySet<string>,
): ModelMessage[] {
  type ToolCall = Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }>;
  type ToolResult = Extract<RuntimeEventModelReplayItem, { kind: 'tool_result' }>;
  type Thinking = Extract<RuntimeEventModelReplayItem, { kind: 'thinking' }>;
  type Text = Extract<RuntimeEventModelReplayItem, { kind: 'text' }>;
  type Step = {
    calls: ToolCall[];
    reasoning: Thinking[];
    text?: Text;
  };
  type TimelineEntry =
    | { kind: 'step'; stepId: string }
    | { kind: 'legacy_call'; call: ToolCall }
    | { kind: 'text'; item: Text }
    | { kind: 'thinking'; item: Thinking };

  const items = admitProviderReasoningReplayItems(
    buildRuntimeEventModelReplayPlan(events).items,
    providerReasoningReplayEventIds,
  );
  const results = new Map<string, ToolResult>();
  for (const item of items) {
    if (item.kind === 'tool_result') results.set(item.toolCallId, item);
  }

  const steps = new Map<string, Step>();
  const timeline: TimelineEntry[] = [];
  const step = (stepId: string): Step => {
    let value = steps.get(stepId);
    if (!value) {
      value = { calls: [], reasoning: [] };
      steps.set(stepId, value);
      timeline.push({ kind: 'step', stepId });
    }
    return value;
  };
  for (const item of items) {
    if (item.kind === 'tool_result') continue;
    if (item.kind === 'tool_call') {
      if (item.stepId) step(item.stepId).calls.push(item);
      else timeline.push({ kind: 'legacy_call', call: item });
      continue;
    }
    if (item.kind === 'thinking') {
      if (item.stepId) step(item.stepId).reasoning.push(item);
      else timeline.push({ kind: 'thinking', item });
      continue;
    }
    if (item.role === 'assistant' && item.stepId) step(item.stepId).text = item;
    else timeline.push({ kind: 'text', item });
  }

  const messages: ModelMessage[] = [];
  const pushToolResult = (result: ToolResult) => {
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: effectiveReplayToolResultOutput(result),
        },
      ],
    });
  };
  const toolCallPart = (call: ToolCall, providerExecuted = call.providerExecuted) => ({
    type: 'tool-call' as const,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
    ...(providerExecuted !== undefined ? { providerExecuted } : {}),
  });
  const pushStep = (value: Step) => {
    const earlyContent: Array<Record<string, unknown>> = [];
    for (const reasoning of value.reasoning) {
      earlyContent.push({
        type: 'reasoning',
        text: reasoning.text,
        ...(reasoning.providerOptions ? { providerOptions: reasoning.providerOptions } : {}),
      });
    }
    const providerCalls = value.calls.filter(
      (call) =>
        call.providerExecuted === true && results.get(call.toolCallId)?.providerExecuted === true,
    );
    // OpenAI's Responses converter omits hosted calls and results when
    // `store:false`. For a compaction request they are historical evidence,
    // so lower each settled pair to an ordinary function call/result instead.
    // This preserves the provider step order without creating a dangling
    // function_call_output or silently dropping the available tool evidence.
    for (const call of providerCalls) {
      earlyContent.push(toolCallPart(call, false));
    }
    if (providerCalls.length > 0 && earlyContent.length > 0) {
      messages.push({ role: 'assistant', content: earlyContent } as ModelMessage);
    }
    for (const call of providerCalls) {
      const result = results.get(call.toolCallId)!;
      results.delete(call.toolCallId);
      pushToolResult(result);
    }
    const lateContent: Array<Record<string, unknown>> =
      providerCalls.length === 0 ? earlyContent : [];
    if (value.text?.content) {
      lateContent.push({
        type: 'text',
        text: value.text.content,
        ...(value.text.providerOptions ? { providerOptions: value.text.providerOptions } : {}),
      });
    }
    for (const call of value.calls) {
      if (call.providerExecuted !== true) lateContent.push(toolCallPart(call));
    }
    if (lateContent.length > 0) {
      messages.push({ role: 'assistant', content: lateContent } as ModelMessage);
    }
    for (const call of value.calls) {
      if (call.providerExecuted === true) continue;
      const result = results.get(call.toolCallId);
      if (!result || result.providerExecuted === true) continue;
      results.delete(call.toolCallId);
      pushToolResult(result);
    }
  };

  for (const entry of timeline) {
    if (entry.kind === 'step') {
      pushStep(steps.get(entry.stepId)!);
    } else if (entry.kind === 'legacy_call') {
      pushStep({ calls: [entry.call], reasoning: [] });
    } else if (entry.kind === 'thinking') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: entry.item.text,
            ...(entry.item.providerOptions ? { providerOptions: entry.item.providerOptions } : {}),
          },
        ],
      });
    } else {
      const part = {
        type: 'text' as const,
        text: entry.item.content,
        ...(entry.item.providerOptions ? { providerOptions: entry.item.providerOptions } : {}),
      };
      messages.push({ role: entry.item.role, content: [part] } as ModelMessage);
    }
  }
  return messages;
}

export function extractOpenAiCodexCompactionState(
  content: readonly unknown[] | undefined,
  connectionId: string,
  modelId: string,
): HistoryCompactProviderState | undefined {
  const parts = (content ?? []).filter(isOpenAiCompactionPart);
  if (parts.length !== 1) return undefined;
  const metadata = parts[0]!.providerMetadata.openai;
  if (!nonEmpty(metadata.itemId) || !nonEmpty(metadata.encryptedContent)) return undefined;
  return {
    kind: 'openai_codex_remote_v2',
    connectionId,
    modelId,
    itemId: metadata.itemId,
    encryptedContent: metadata.encryptedContent,
  };
}

function isOpenAiCompactionPart(value: unknown): value is {
  type: 'custom';
  kind: 'openai.compaction';
  providerMetadata: { openai: { itemId?: unknown; encryptedContent?: unknown } };
} {
  if (!value || typeof value !== 'object') return false;
  const part = value as Record<string, unknown>;
  if (part.type !== 'custom' || part.kind !== 'openai.compaction') return false;
  const providerMetadata = part.providerMetadata;
  if (!providerMetadata || typeof providerMetadata !== 'object') return false;
  const openai = (providerMetadata as Record<string, unknown>).openai;
  return Boolean(openai && typeof openai === 'object');
}

function isStreamErrorPart(value: unknown): value is { type: 'error'; error: unknown } {
  return Boolean(
    value && typeof value === 'object' && (value as Record<string, unknown>).type === 'error',
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface AiSdkModule {
  streamText(options: Record<string, unknown>): { fullStream: AsyncIterable<unknown> };
  wrapLanguageModel(input: Record<string, unknown>): unknown;
}

async function loadAiSdkModule(): Promise<AiSdkModule> {
  const ai = await import('ai').catch((err) => {
    throw new Error(
      `Failed to load 'ai' package for history compaction. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
    );
  });
  return ai as unknown as AiSdkModule;
}
