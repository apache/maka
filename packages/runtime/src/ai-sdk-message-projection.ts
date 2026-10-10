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

import type { AttachmentRef, DirectoryReference, QuoteRef, StorageRef } from '@maka/core/events';
import type { AssistantThinkingPart } from '@maka/core/session';
import {
  MAX_PROVIDER_BINARY_REQUEST_BYTES,
  MAX_PROVIDER_IMAGE_REQUEST_BYTES,
  MAX_PROVIDER_PDF_REQUEST_BYTES,
  PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE,
  sniffAttachmentMimeType,
  type AttachmentByteReader,
} from '@maka/core/attachments';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import type { ProviderAttachmentBudget } from './ai-sdk-compaction.js';
import {
  applyPatchReplayFactText,
  normalizeApplyPatchReplayInput,
  type ApplyPatchProfile,
} from './apply-patch-profile.js';
import { durableProjectionToToolResultOutput } from './durable-tool-result-projection.js';
import {
  historyCompactCheckpointToModelMessage,
  isProviderHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import {
  admitProviderReasoningReplayItems,
  buildRuntimeEventReplayTimeline,
  formatTextWithInlineRefs,
  steeringProviderOptions,
  type RuntimeEventModelReplayItem,
  type RuntimeEventModelReplayPlan,
  type RuntimeEventReplayToolExchange,
  type RuntimeEventReplayToolResultItem,
} from './model-history.js';
import type { ModelAdapter } from './model-adapter.js';
import type {
  ModelMessage,
  ReasoningPart,
  ToolResultContentPart,
  ToolResultOutput,
  UserContent,
} from './model-protocol.js';
import { openAiChatReasoningFieldFromProviderOptions } from './openai-chat-reasoning-transport.js';
import {
  decodePlaintextResponsesReasoningState,
  replayPlaintextResponsesProviderOptions,
} from './responses-reasoning-state.js';
import { toolResultOutput } from './tool-result-output.js';
import {
  deepSeekWebSearchReplayItem,
  deepSeekWebSearchReplayOptions,
} from './deepseek-web-search-codec.js';

export interface AiSdkMessageProjectionInput {
  modelAdapter: ModelAdapter;
  applyPatchProfile: ApplyPatchProfile | null;
  supportsVision?: boolean;
  supportsNativePdfInput?: boolean;
  readAttachmentBytes?: AttachmentByteReader;
  maxProviderImageRequestBytes?: number;
  maxProviderPdfRequestBytes?: number;
  maxProviderBinaryRequestBytes?: number;
}

function isRedactedThinking(providerOptions: AssistantThinkingPart['providerOptions']): boolean {
  const anthropic = providerOptions?.anthropic;
  return (
    !!anthropic &&
    typeof anthropic === 'object' &&
    !Array.isArray(anthropic) &&
    typeof (anthropic as { redactedData?: unknown }).redactedData === 'string'
  );
}

function encryptedResponsesReasoning(
  providerOptions: AssistantThinkingPart['providerOptions'],
): { itemId: string; reasoningEncryptedContent: string } | undefined {
  const openai = providerOptions?.openai;
  if (!openai || typeof openai !== 'object' || Array.isArray(openai)) return undefined;
  const { itemId, reasoningEncryptedContent } = openai as {
    itemId?: unknown;
    reasoningEncryptedContent?: unknown;
  };
  return typeof itemId === 'string' &&
    itemId.length > 0 &&
    typeof reasoningEncryptedContent === 'string' &&
    reasoningEncryptedContent.length > 0
    ? { itemId, reasoningEncryptedContent }
    : undefined;
}

export function hasFinalizedReasoning(part: AssistantThinkingPart): boolean {
  return (
    !!part.signature ||
    isRedactedThinking(part.providerOptions) ||
    decodePlaintextResponsesReasoningState(part.providerOptions).kind === 'valid' ||
    encryptedResponsesReasoning(part.providerOptions) !== undefined
  );
}

function isImageToolResult(
  value: unknown,
): value is { kind: 'image'; mimeType: string; ref: StorageRef } {
  if (!value || typeof value !== 'object') return false;
  const image = value as { kind?: unknown; mimeType?: unknown; ref?: unknown };
  return (
    image.kind === 'image' &&
    typeof image.mimeType === 'string' &&
    image.ref !== null &&
    typeof image.ref === 'object'
  );
}

function toolResultText(text: string): ToolResultContentPart {
  return { type: 'text', text };
}

function nativeApplyPatchFailureOutput(output: ToolResultOutput): ToolResultOutput {
  const value = output.type === 'json' || output.type === 'error-json' ? output.value : undefined;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  const message =
    output.type === 'text' || output.type === 'error-text'
      ? output.value
      : typeof record?.output === 'string'
        ? record.output
        : typeof record?.text === 'string'
          ? record.text
          : typeof record?.error === 'string'
            ? record.error
            : undefined;
  return {
    type: 'json',
    value: { status: 'failed', ...(message ? { output: message } : {}) },
  };
}

function durableApplyPatchReplayFactText(
  input: unknown,
  projection: DurableToolResultProjection,
  isError: boolean,
): string | null {
  if (projection.kind === 'json') {
    const fact = applyPatchReplayFactText(input, projection, isError);
    if (fact) return fact;
  }
  const output = durableProjectionToToolResultOutput(projection);
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'content': {
      const text = output.value
        .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      return text || null;
    }
    case 'execution-denied':
      return output.reason
        ? `ApplyPatch execution denied: ${output.reason}`
        : 'ApplyPatch execution denied.';
  }
}

/**
 * Projects canonical Runtime history and current user input into provider
 * messages. It owns no execution state; its only mutable data is the weak
 * event index attached to the messages it creates.
 */
export class AiSdkMessageProjection {
  private readonly memoryReplayMessageEvents = new WeakMap<ModelMessage, readonly string[]>();

  constructor(private readonly input: AiSdkMessageProjectionInput) {}

  canReplayProviderNative(plan: RuntimeEventModelReplayPlan): boolean {
    const support = this.input.modelAdapter.runtimeEventReplaySupport();
    const replayableDeepSeekPairs = this.replayableDeepSeekPairIds(plan);
    for (const item of plan.items) {
      if (item.kind === 'tool_call' && !support.toolCalls) return false;
      if (item.kind === 'tool_result' && !support.toolResults) return false;
      if (
        (item.kind === 'tool_call' || item.kind === 'tool_result') &&
        item.providerExecuted === true &&
        !support.providerExecutedTools &&
        !replayableDeepSeekPairs.has(item.eventId)
      ) {
        return false;
      }
      if (item.kind === 'thinking' && item.signature && !support.signedThinking) return false;
    }
    return true;
  }

  /**
   * Per-item counterpart to {@link canReplayProviderNative}: drop only the
   * items the adapter cannot represent so one unsupported provider-executed
   * pair does not cost unrelated client tool history (#2972). Call and result
   * items fall together — a call without its result is a dangling wire item,
   * and provider-executed pairs are flagged on both items by the plan.
   */
  dropUnsupportedReplayItems(plan: RuntimeEventModelReplayPlan): RuntimeEventModelReplayPlan {
    const support = this.input.modelAdapter.runtimeEventReplaySupport();
    const replayableDeepSeekPairs = this.replayableDeepSeekPairIds(plan);
    return {
      ...plan,
      items: plan.items.filter((item) => {
        if (item.kind === 'tool_call' || item.kind === 'tool_result') {
          if (!support.toolCalls || !support.toolResults) return false;
          if (
            item.providerExecuted === true &&
            !support.providerExecutedTools &&
            !replayableDeepSeekPairs.has(item.eventId)
          )
            return false;
        }
        return true;
      }),
    };
  }

  private replayableDeepSeekPairIds(plan: RuntimeEventModelReplayPlan): ReadonlySet<string> {
    const ids = new Set<string>();
    if (!this.input.modelAdapter.supportsDeepSeekWebSearchReplay()) return ids;
    for (const entry of buildRuntimeEventReplayTimeline(plan.items)) {
      if (entry.kind !== 'assistant_step') continue;
      for (const { call, result } of entry.calls) {
        if (result?.providerExecuted !== true || !deepSeekWebSearchReplayItem(call)) continue;
        ids.add(call.eventId);
        ids.add(result.eventId);
      }
    }
    return ids;
  }

  /**
   * Materialize a replay plan into provider messages, grouping each assistant
   * step's reasoning + text + tool calls into ONE assistant message (Anthropic
   * requires the signed thinking block to lead the tool-use assistant message).
   *
   * The ledger lands a step's parts as: tool_call(s), tool_result(s), thinking,
   * text (the per-step AssistantMessage flushes at `finish-step`, after the
   * step's tool events). Model text carries the step id and closes the step.
   * Client tools replay as `[reasoning, text, tool-call…]` followed by tool
   * messages; provider-executed tools replay as
   * `[reasoning, tool-call, tool-result, text]`, preserving provider chronology
   * for item references and grounded text. Steps with no text closer — a
   * thinking + tool step (its empty text closer is skipped from the plan as
   * `empty_text_skipped`) or a pure-tool step — flush grouped by stepId,
   * claiming any parked reasoning for that step. Legacy per-turn items (no step
   * id) keep the older shape: tool calls form a tool-only assistant,
   * text/thinking become standalone messages.
   */
  async materializeRuntimeReplayPlan(
    plan: RuntimeEventModelReplayPlan,
    budget: ProviderAttachmentBudget,
    historyCompactCheckpoint: HistoryCompactCheckpoint | undefined,
    providerReasoningReplayEventIds: ReadonlySet<string>,
  ): Promise<ModelMessage[]> {
    type ThinkingItem = Extract<RuntimeEventModelReplayItem, { kind: 'thinking' }>;
    type TextItem = Extract<RuntimeEventModelReplayItem, { kind: 'text' }>;
    type ReplayReasoning = {
      part?: ReasoningPart;
      providerOptions?: NonNullable<ModelMessage['providerOptions']>;
    };
    const out: ModelMessage[] = [];
    const push = (message: ModelMessage, eventIds: readonly string[]) => {
      out.push(message);
      this.memoryReplayMessageEvents.set(message, [...new Set(eventIds)]);
    };
    const replaySupport = this.input.modelAdapter.runtimeEventReplaySupport();
    const reasoningReplay = (item: ThinkingItem): ReplayReasoning | undefined => {
      if (item.signature) {
        return replaySupport.signedThinking
          ? {
              part: {
                type: 'reasoning' as const,
                text: item.text,
                providerOptions: { anthropic: { signature: item.signature } },
              },
            }
          : undefined;
      }
      if (isRedactedThinking(item.providerOptions)) {
        return replaySupport.signedThinking
          ? {
              part: {
                type: 'reasoning' as const,
                text: item.text,
                providerOptions: item.providerOptions,
              },
            }
          : undefined;
      }
      if (
        typeof replaySupport.responsesReasoning === 'object' &&
        replaySupport.responsesReasoning.kind === 'plaintext-item'
      ) {
        const decoded = decodePlaintextResponsesReasoningState(item.providerOptions);
        if (decoded.kind !== 'valid') return undefined;
        if (decoded.state.profile !== replaySupport.responsesReasoning.profile) {
          return undefined;
        }
        const providerOptions = replayPlaintextResponsesProviderOptions({
          providerOptionsKey: replaySupport.responsesReasoning.providerOptionsKey,
          state: decoded.state,
          text: item.text,
        });
        if (!providerOptions) return undefined;
        return {
          part: { type: 'reasoning' as const, text: item.text, providerOptions },
        };
      }
      if (replaySupport.responsesReasoning === 'plaintext-content') {
        if (item.text.length === 0) return undefined;
        return { part: { type: 'reasoning' as const, text: item.text } };
      }
      if (replaySupport.responsesReasoning === 'encrypted-content') {
        const encrypted = encryptedResponsesReasoning(item.providerOptions);
        if (encrypted) {
          return {
            part: {
              type: 'reasoning' as const,
              text: item.text,
              providerOptions: {
                openai: encrypted,
              },
            },
          };
        }
      }
      if (!replaySupport.unsignedThinking) return undefined;
      const reasoningField = openAiChatReasoningFieldFromProviderOptions(item.providerOptions);
      if (!reasoningField) return undefined;
      return {
        providerOptions: {
          openaiCompatible: { [reasoningField]: item.text },
        } as NonNullable<ModelMessage['providerOptions']>,
      };
    };
    // Tool results are emitted only when their tool_call claims them here. A
    // result whose call never appears in the plan (sliced-away call, corrupt
    // ledger) is INTENTIONALLY dropped at the end: a standalone tool message
    // with no preceding tool_use in an assistant message is an Anthropic 400.
    // The old item-by-item materializer emitted such orphans; do not "fix" this
    // back — the plan flags them as `unmatched_tool_result` (a non-blocking
    // diagnostic precisely so this drop path is reachable; see
    // hasBlockingReplayDiagnostics).
    const materializeReplayToolResult = async (
      result: RuntimeEventReplayToolResultItem,
      toolName: string,
    ): Promise<ToolResultOutput> => {
      const output = result.modelProjection
        ? await this.materializeDurableToolResultProjection(
            budget,
            result.modelProjection,
            `runtime-event:${result.eventId}:tool-result`,
          )
        : await this.materializeToolResultOutput(
            budget,
            result.output,
            result.isError,
            `runtime-event:${result.eventId}:tool-result`,
          );
      if (toolName !== 'apply_patch') return output;
      return result.isError ? nativeApplyPatchFailureOutput(output) : output;
    };
    const pushClientToolResults = async (exchanges: readonly RuntimeEventReplayToolExchange[]) => {
      for (const { call, result } of exchanges) {
        if (!result || result.providerExecuted === true) continue;
        push(
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: result.toolCallId,
                toolName: result.toolName,
                output: await materializeReplayToolResult(result, call.toolName),
              },
            ],
          },
          [result.eventId],
        );
      }
    };
    // Emit one assistant message for a step, preserving the distinct client-
    // and provider-executed tool chronologies described above.
    const emitStep = async (
      reasoning: readonly ThinkingItem[] | undefined,
      text: TextItem | undefined,
      exchanges: readonly RuntimeEventReplayToolExchange[],
      replayFacts: ReadonlyArray<{ readonly text: string; readonly eventIds: readonly string[] }>,
    ) => {
      const calls = exchanges.map(({ call }) => call);
      const content: unknown[] = [];
      const replayReasoning = (reasoning ?? [])
        .map((item) => ({ eventId: item.eventId, replay: reasoningReplay(item) }))
        .filter(
          (entry): entry is { eventId: string; replay: ReplayReasoning } =>
            entry.replay !== undefined,
        );
      const eventIds = [
        ...replayReasoning.map((entry) => entry.eventId),
        ...(text ? [text.eventId] : []),
        ...calls.map((call) => call.eventId),
        ...replayFacts.flatMap((fact) => fact.eventIds),
      ];
      for (const { replay } of replayReasoning) {
        if (replay.part) content.push(replay.part);
      }
      // Provider-owned tools execute before the grounded assistant text in the
      // same provider step. Preserve that chronology for Responses item
      // references and Anthropic server_tool_use/result replay. Client tools
      // stay after text because their execution begins only after this step.
      for (const { call, result } of exchanges) {
        if (call.providerExecuted !== true) continue;
        const deepSeekItem =
          result?.providerExecuted === true &&
          this.input.modelAdapter.supportsDeepSeekWebSearchReplay()
            ? deepSeekWebSearchReplayItem(call)
            : undefined;
        const replayOptions = deepSeekItem
          ? deepSeekWebSearchReplayOptions(deepSeekItem)
          : call.providerOptions;
        content.push({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          ...(replayOptions !== undefined ? { providerOptions: replayOptions } : {}),
          providerExecuted: true,
        });
        if (!result || result.providerExecuted !== true) continue;
        eventIds.push(result.eventId);
        content.push({
          type: 'tool-result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: await materializeReplayToolResult(result, call.toolName),
          ...(deepSeekItem ? { providerOptions: replayOptions } : {}),
        });
      }
      if (text && text.content.length > 0) {
        content.push({
          type: 'text',
          text: text.content,
          ...(text.providerOptions !== undefined ? { providerOptions: text.providerOptions } : {}),
        });
      }
      for (const replayFact of replayFacts) {
        content.push({ type: 'text', text: replayFact.text });
      }
      for (const call of calls) {
        if (call.providerExecuted === true) continue;
        content.push({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          ...(call.providerOptions !== undefined ? { providerOptions: call.providerOptions } : {}),
          ...(call.providerExecuted !== undefined
            ? { providerExecuted: call.providerExecuted }
            : {}),
        });
      }
      const replayProviderOptions = replayReasoning.find(
        (entry) => entry.replay.providerOptions !== undefined,
      )?.replay.providerOptions;
      if (content.length > 0 || replayProviderOptions) {
        push(
          {
            role: 'assistant',
            content,
            ...(replayProviderOptions ? { providerOptions: replayProviderOptions } : {}),
          } as ModelMessage,
          eventIds,
        );
      }
      await pushClientToolResults(exchanges);
    };
    const admittedItems = admitProviderReasoningReplayItems(
      plan.items,
      providerReasoningReplayEventIds,
    );
    const replayUserMessages = await this.materializeReplayUserMessagesNewestFirst(
      budget,
      admittedItems,
    );
    for (const entry of buildRuntimeEventReplayTimeline(admittedItems)) {
      if (entry.kind === 'thinking') {
        const replayReasoning = reasoningReplay(entry.item);
        if (replayReasoning) {
          push(
            {
              role: 'assistant',
              content: replayReasoning.part ? [replayReasoning.part] : [],
              ...(replayReasoning.providerOptions
                ? { providerOptions: replayReasoning.providerOptions }
                : {}),
            } as ModelMessage,
            [entry.item.eventId],
          );
        }
        continue;
      }
      if (entry.kind === 'text') {
        push(
          replayUserMessages.get(entry.item.eventId) ??
            (await this.materializeRuntimeReplayItem(budget, entry.item)),
          [entry.item.eventId],
        );
        continue;
      }

      const exchanges: RuntimeEventReplayToolExchange[] = [];
      const replayFacts: Array<{ readonly text: string; readonly eventIds: readonly string[] }> =
        [];
      for (const { call, result } of entry.calls) {
        if (call.toolName !== 'apply_patch') {
          exchanges.push({ call, ...(result ? { result } : {}) });
          continue;
        }
        const replayInput = normalizeApplyPatchReplayInput(
          this.input.applyPatchProfile,
          call.toolCallId,
          call.input,
        );
        if (replayInput !== null) {
          exchanges.push({
            call: {
              ...call,
              input: replayInput,
              ...(replayInput !== call.input ? { providerOptions: undefined } : {}),
            },
            ...(result ? { result } : {}),
          });
          continue;
        }
        if (!result) continue;
        const replayFact = result.modelProjection
          ? durableApplyPatchReplayFactText(call.input, result.modelProjection, result.isError)
          : applyPatchReplayFactText(call.input, result.output, result.isError);
        if (!replayFact) continue;
        replayFacts.push({ text: replayFact, eventIds: [call.eventId, result.eventId] });
      }
      await emitStep(entry.reasoning, entry.text, exchanges, replayFacts);
    }
    return this.prependProviderHistoryCompactMessage(out, historyCompactCheckpoint);
  }

  async materializeRuntimeReplayTextOnly(
    budget: ProviderAttachmentBudget,
    plan: RuntimeEventModelReplayPlan,
    historyCompactCheckpoint?: HistoryCompactCheckpoint,
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];
    const replayUserMessages = await this.materializeReplayUserMessagesNewestFirst(
      budget,
      plan.items,
    );
    for (const item of plan.items) {
      if (item.kind === 'text')
        this.pushMemoryIndexedMessage(
          messages,
          replayUserMessages.get(item.eventId) ??
            (await this.materializeRuntimeReplayItem(budget, item)),
          [item.eventId],
        );
    }
    return this.prependProviderHistoryCompactMessage(messages, historyCompactCheckpoint);
  }

  private async materializeReplayUserMessagesNewestFirst(
    budget: ProviderAttachmentBudget,
    items: readonly RuntimeEventModelReplayItem[],
  ): Promise<ReadonlyMap<string, ModelMessage>> {
    const messages = new Map<string, ModelMessage>();
    // Decide which historical user attachments fit before rendering the
    // chronological prompt. Tool results use any allowance left afterward.
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (
        item?.kind === 'text' &&
        item.role === 'user' &&
        item.attachments?.some(
          (attachment) => attachment.kind === 'image' || attachment.kind === 'pdf',
        )
      ) {
        messages.set(item.eventId, await this.materializeRuntimeReplayItem(budget, item));
      }
    }
    return messages;
  }

  private prependProviderHistoryCompactMessage(
    messages: ModelMessage[],
    checkpoint: HistoryCompactCheckpoint | undefined,
  ): ModelMessage[] {
    if (!checkpoint || !isProviderHistoryCompactCheckpoint(checkpoint)) return messages;
    const providerMessage = historyCompactCheckpointToModelMessage(checkpoint);
    this.memoryReplayMessageEvents.set(providerMessage, [
      `history-compact:${checkpoint.checkpointId}`,
    ]);
    return [providerMessage, ...messages];
  }

  private pushMemoryIndexedMessage(
    messages: ModelMessage[],
    message: ModelMessage,
    eventIds: readonly string[],
  ): void {
    messages.push(message);
    this.memoryReplayMessageEvents.set(message, [...new Set(eventIds)]);
  }

  memoryEventMessagePositions(
    messages: readonly ModelMessage[],
  ): Readonly<Record<string, readonly number[]>> | undefined {
    const positions: Record<string, number[]> = {};
    for (const [position, message] of messages.entries()) {
      for (const eventId of this.memoryReplayMessageEvents.get(message) ?? []) {
        (positions[eventId] ??= []).push(position);
      }
    }
    return Object.keys(positions).length > 0 ? positions : undefined;
  }

  private async materializeRuntimeReplayItem(
    budget: ProviderAttachmentBudget,
    item: Extract<RuntimeEventModelReplayItem, { kind: 'text' }>,
  ): Promise<ModelMessage> {
    if (item.role === 'user') {
      // Both ordinary and steered replay materialize image attachments through
      // the same path the original request used — a steering replay that kept
      // only the envelope text would hand a recovery turn references without
      // the native images the first request received.
      const content = await this.appendAttachmentParts(
        budget,
        item.content,
        item.attachments,
        item.steering ? `steering:${item.steering.eventId}` : `runtime-event:${item.eventId}`,
      );
      if (item.steering) {
        // Already envelope-wrapped by the plan; carry the structured identity
        // so injection dedupe recognizes the replayed message.
        return {
          role: 'user',
          content,
          providerOptions: steeringProviderOptions(item.steering.eventId),
        };
      }
      return {
        role: 'user',
        content,
      } as ModelMessage;
    }
    return {
      role: item.role,
      content: item.content,
      ...(item.providerOptions !== undefined ? { providerOptions: item.providerOptions } : {}),
    };
  }

  /** A decision key deduplicates re-materialization; no key charges each occurrence. */
  private chargeAttachmentBudget(
    budget: ProviderAttachmentBudget,
    kind: 'image' | 'pdf',
    bytes: number,
    decisionKey?: string,
  ): 'keep' | 'image_limit' | 'pdf_limit' | 'combined_limit' {
    if (decisionKey !== undefined) {
      const cached = budget.decisions.get(decisionKey);
      if (cached !== undefined) return cached;
    }
    const subtypeLimit =
      kind === 'image'
        ? (this.input.maxProviderImageRequestBytes ?? MAX_PROVIDER_IMAGE_REQUEST_BYTES)
        : (this.input.maxProviderPdfRequestBytes ?? MAX_PROVIDER_PDF_REQUEST_BYTES);
    const decision =
      budget.used[kind] + bytes > subtypeLimit
        ? kind === 'image'
          ? 'image_limit'
          : 'pdf_limit'
        : budget.used.total + bytes >
            (this.input.maxProviderBinaryRequestBytes ?? MAX_PROVIDER_BINARY_REQUEST_BYTES)
          ? 'combined_limit'
          : 'keep';
    if (decision === 'keep') {
      budget.used[kind] += bytes;
      budget.used.total += bytes;
    }
    if (decisionKey !== undefined) budget.decisions.set(decisionKey, decision);
    return decision;
  }

  /**
   * Render provider-visible content for a user message: keep the given
   * (already-formatted) text, then append explicitly authorized image and PDF
   * file parts. Shared by the current turn, replay, steering, and compaction.
   */
  async appendAttachmentParts(
    budget: ProviderAttachmentBudget,
    textContent: string,
    attachments?: AttachmentRef[],
    decisionKeyPrefix?: string,
  ): Promise<UserContent> {
    const binaryAttachments =
      attachments?.filter(
        (attachment): attachment is AttachmentRef & { kind: 'image' | 'pdf' } =>
          attachment.kind === 'image' || attachment.kind === 'pdf',
      ) ?? [];
    const eligibleAttachments = binaryAttachments
      .map((attachment, index) => ({ attachment, index }))
      .filter(
        ({ attachment }) =>
          (attachment.kind === 'image' && this.input.supportsVision === true) ||
          (attachment.kind === 'pdf' && this.input.supportsNativePdfInput === true),
      );
    if (eligibleAttachments.length === 0 || !this.input.readAttachmentBytes) return textContent;
    const parts: Array<
      | { type: 'text'; text: string }
      | {
          type: 'file';
          data: { type: 'data'; data: Uint8Array };
          mediaType: string;
          filename?: string;
        }
    > = [{ type: 'text', text: textContent }];
    const omitted = { image_limit: 0, pdf_limit: 0, combined_limit: 0 };
    for (const { attachment, index } of eligibleAttachments) {
      const decisionKey =
        decisionKeyPrefix === undefined
          ? undefined
          : `${decisionKeyPrefix}:${attachment.kind}:${index}`;
      const invalidMediaType =
        decisionKey === undefined ? undefined : budget.invalidMediaTypes.get(decisionKey);
      if (invalidMediaType !== undefined) {
        parts.push({
          type: 'text',
          text: `${attachment.kind === 'pdf' ? 'PDF' : 'Image'} attachment "${attachment.name}" was omitted because its loaded bytes are ${invalidMediaType}, not the declared ${attachment.kind} type.`,
        });
        continue;
      }
      const cachedDecision =
        decisionKey === undefined ? undefined : budget.decisions.get(decisionKey);
      if (cachedDecision !== undefined && cachedDecision !== 'keep') {
        omitted[cachedDecision] += 1;
        continue;
      }
      let read: Awaited<ReturnType<AttachmentByteReader>>;
      try {
        read = await this.input.readAttachmentBytes(attachment.ref);
      } catch {
        read = { ok: false, reason: 'read_failed' };
      }
      if (!read.ok) {
        parts.push({
          type: 'text',
          text: `${attachment.kind === 'pdf' ? 'PDF' : 'Image'} attachment "${attachment.name}" could not be loaded: ${read.reason}.`,
        });
        continue;
      }
      const mediaType =
        sniffAttachmentMimeType(read.bytes) ??
        read.mimeType ??
        (attachment.kind === 'image' ? attachment.mimeType : undefined);
      if (
        mediaType === undefined ||
        (attachment.kind === 'pdf' && mediaType !== 'application/pdf') ||
        (attachment.kind === 'image' && !mediaType.startsWith('image/'))
      ) {
        const observedMediaType = mediaType ?? 'unknown';
        if (decisionKey !== undefined) budget.invalidMediaTypes.set(decisionKey, observedMediaType);
        parts.push({
          type: 'text',
          text: `${attachment.kind === 'pdf' ? 'PDF' : 'Image'} attachment "${attachment.name}" was omitted because its loaded bytes are ${observedMediaType}, not the declared ${attachment.kind} type.`,
        });
        continue;
      }
      const decision = this.chargeAttachmentBudget(
        budget,
        attachment.kind,
        read.bytes.length,
        decisionKey,
      );
      if (decision !== 'keep') {
        omitted[decision] += 1;
        continue;
      }
      parts.push({
        type: 'file',
        data: { type: 'data', data: read.bytes },
        mediaType,
        ...(attachment.kind === 'pdf' ? { filename: attachment.name } : {}),
      });
    }
    if (omitted.image_limit > 0) {
      parts.push({
        type: 'text',
        text: `[${omitted.image_limit} image attachment(s) omitted: the per-request image budget was exceeded. Earlier images were sent; ask the user to send fewer or smaller images.]`,
      });
    }
    if (omitted.pdf_limit > 0)
      parts.push({
        type: 'text',
        text: `[${omitted.pdf_limit} PDF attachment(s) omitted: the per-request PDF budget was exceeded. Earlier PDFs were sent; ask the user to send fewer or smaller PDFs.]`,
      });
    if (omitted.combined_limit > 0)
      parts.push({
        type: 'text',
        text: `[${omitted.combined_limit} binary attachment(s) omitted: the combined image/PDF request budget was exceeded. Earlier attachments were sent; ask the user to send fewer or smaller attachments.]`,
      });
    return parts;
  }

  private async materializeToolResultOutput(
    budget: ProviderAttachmentBudget,
    output: unknown,
    isError: boolean,
    decisionKey: string,
  ): Promise<ToolResultOutput> {
    if (isError || !isImageToolResult(output)) return toolResultOutput(output, isError);
    return {
      type: 'content',
      value: [await this.materializeImage(budget, output.ref, output.mimeType, decisionKey)],
    };
  }

  private async materializeImage(
    budget: ProviderAttachmentBudget,
    ref: StorageRef,
    mediaType: string,
    decisionKey: string,
  ): Promise<ToolResultContentPart> {
    if (this.input.supportsVision !== true) {
      return toolResultText('Image was read, but the selected model does not support image input.');
    }
    if (!this.input.readAttachmentBytes) {
      return toolResultText('Image was read, but its stored bytes are unavailable.');
    }
    const cachedDecision = budget.decisions.get(decisionKey);
    if (cachedDecision !== undefined && cachedDecision !== 'keep') {
      return toolResultText(this.imageBudgetFailureMessage(cachedDecision));
    }
    let read: Awaited<ReturnType<AttachmentByteReader>>;
    try {
      read = await this.input.readAttachmentBytes(ref);
    } catch {
      return toolResultText('Image could not be loaded from artifact storage: read_failed.');
    }
    if (!read.ok) {
      return toolResultText(`Image could not be loaded from artifact storage: ${read.reason}.`);
    }
    if ((sniffAttachmentMimeType(read.bytes) ?? read.mimeType) === 'application/pdf') {
      return toolResultText('Image could not be loaded: its stored bytes are a PDF.');
    }
    const decision = this.chargeAttachmentBudget(budget, 'image', read.bytes.length, decisionKey);
    if (decision !== 'keep') {
      return toolResultText(this.imageBudgetFailureMessage(decision));
    }
    return {
      type: 'file',
      data: { type: 'data', data: Buffer.from(read.bytes).toString('base64') },
      mediaType,
    };
  }

  private imageBudgetFailureMessage(
    decision: 'image_limit' | 'pdf_limit' | 'combined_limit',
  ): string {
    return decision === 'combined_limit'
      ? `Image was read, but the combined image/PDF request budget (${(this.input.maxProviderBinaryRequestBytes ?? MAX_PROVIDER_BINARY_REQUEST_BYTES) / 1024 / 1024}MB across all binary attachments this turn) was exceeded; earlier attachments were sent and this one was omitted. Read fewer or smaller attachments.`
      : PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE;
  }

  private async materializeDurableToolResultProjection(
    budget: ProviderAttachmentBudget,
    projection: DurableToolResultProjection,
    decisionKey: string,
  ): Promise<ToolResultOutput> {
    if (projection.kind !== 'content') return durableProjectionToToolResultOutput(projection);
    const value: Extract<ToolResultOutput, { type: 'content' }>['value'] = [];
    for (const [index, part] of projection.parts.entries()) {
      value.push(
        part.kind === 'text'
          ? toolResultText(part.text)
          : await this.materializeImage(
              budget,
              part.ref,
              part.mediaType,
              `${decisionKey}:artifact:${index}`,
            ),
      );
    }
    return { type: 'content', value };
  }

  async buildCurrentUserContent(
    budget: ProviderAttachmentBudget,
    text: string,
    attachments?: AttachmentRef[],
    directoryReferences?: DirectoryReference[],
    quotes?: QuoteRef[],
    runtimeEventId?: string,
  ): Promise<UserContent> {
    return await this.appendAttachmentParts(
      budget,
      formatTextWithInlineRefs(text, {
        ...(attachments !== undefined ? { attachments } : {}),
        ...(directoryReferences !== undefined ? { directoryReferences } : {}),
        ...(quotes !== undefined ? { quotes } : {}),
      }),
      attachments,
      runtimeEventId === undefined ? undefined : `runtime-event:${runtimeEventId}`,
    );
  }
}
