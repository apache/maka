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

import { rawFinishReasonString, type ModelMessage, type ToolCallPart } from './model-protocol.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import {
  findCheckpointSummaryDefect,
  SUMMARY_FORMAT_TEMPLATE,
} from './history-compact-summary-validation.js';
import { effectiveReplayToolResultOutput } from './durable-tool-result-projection.js';
import {
  DEFAULT_HISTORY_COMPACT_MAX_OUTPUT_TOKENS,
  type HistoryCompactSummaryInput,
} from './ai-sdk-compaction-contract.js';
import {
  HistoryCompactSummarizerError,
  isMalformedHistoryCompactSummaryReason,
} from './history-compact-error.js';
import { isTextHistoryCompactCheckpoint } from './history-compact-checkpoint.js';
import { normalizeAiSdkUsage, type AiSdkUsageLike } from './model-adapter.js';
import { classifyError } from './provider-error-classification.js';
import { withProviderGenerateTracking } from './provider-request-telemetry.js';

export { HistoryCompactSummarizerError } from './history-compact-error.js';

export interface AiSdkGenerateTextOptions {
  model: unknown;
  instructions: string;
  messages: ModelMessage[];
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export type AiSdkGenerateTextLike = (options: AiSdkGenerateTextOptions) => Promise<{
  text: string;
  finishReason?: unknown;
  usage?: AiSdkUsageLike;
}>;

export interface BuildLlmHistorySummarizerOptions {
  /** Resolve the AI SDK model used for summarization. Reuses the session model. */
  resolveModel: () => unknown;
  /** Session provider settings, including the selected reasoning level. */
  providerOptions?: Record<string, unknown>;
  /** Injectable `generateText` for tests; defaults to the real AI SDK export. */
  generateText?: AiSdkGenerateTextLike;
}

// Conversation-summarization prompt (sectioned, modelled on pi/opencode):
// asks for a checkpoint another LLM can continue from. Tool calls and their
// results are part of the conversation sent to the summarizer, because the
// folded events are projected with the same policy the model would see them.
// The format block is the validation module's template, so the mandated
// format and the validation can never drift apart.
const SUMMARIZATION_SYSTEM_PROMPT = [
  'You are a context summarization assistant.',
  'Read the conversation between a user and an AI assistant, then produce a structured summary another LLM will use to continue the same task.',
  'Do NOT continue the conversation. Do NOT answer questions in it. ONLY output the structured summary.',
  '',
  'Use this exact format:',
  '',
  ...SUMMARY_FORMAT_TEMPLATE,
  '',
  'Keep each section concise. Preserve exact file paths, function names, commands, and error messages.',
].join('\n');

const SUMMARY_REQUEST_INSTRUCTION =
  'Now write the structured summary of the conversation above. Output only the summary.';

function shortenSummarizationSystemPrompt(): string {
  return [
    SUMMARIZATION_SYSTEM_PROMPT,
    '',
    'Your previous attempt was cut off at the output limit. Produce the same summary in well under half the length: keep every section, drop detail rather than sections.',
  ].join('\n');
}

function repairSummarizationSystemPrompt(reason: string): string {
  return [
    SUMMARIZATION_SYSTEM_PROMPT,
    '',
    `A prior attempt was rejected as ${reason}.`,
    'Produce one complete replacement summary from the source conversation.',
    'Every required section must appear in order with substantive content. Do not discuss the repair.',
  ].join('\n');
}

export function buildLlmHistorySummarizer(options: BuildLlmHistorySummarizerOptions) {
  return async (input: HistoryCompactSummaryInput): Promise<string | undefined> => {
    const previousCheckpoint =
      input.previousCheckpoint && isTextHistoryCompactCheckpoint(input.previousCheckpoint)
        ? input.previousCheckpoint
        : undefined;
    const newlyFoldedRuntimeEvents =
      input.previousCheckpoint && !previousCheckpoint
        ? input.source.foldedRuntimeEvents
        : (input.newlyFoldedRuntimeEvents ?? input.source.foldedRuntimeEvents);
    if (newlyFoldedRuntimeEvents.length === 0) return previousCheckpoint?.summary;
    try {
      const plan = buildRuntimeEventModelReplayPlan(newlyFoldedRuntimeEvents);
      const projectedMessages = replayPlanItemsToModelMessages(plan.items);
      if (previousCheckpoint) {
        projectedMessages.unshift({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Previous continuation summary:\n${previousCheckpoint.summary}\n\nUpdate it using the newer conversation events that follow.`,
            },
          ],
        });
      }
      // The folded span usually ends on an assistant message. A chat-template
      // model handed a conversation that already ends with its own turn emits
      // an end-of-sequence token and nothing else (Ollama qwen2.5: finish
      // `stop`, one output token, empty text), so the request must end with
      // an instruction the model can answer. Hosted providers do not need the
      // nudge and are not disturbed by it (#4559).
      projectedMessages.push({
        role: 'user',
        content: [{ type: 'text', text: SUMMARY_REQUEST_INSTRUCTION }],
      });
      // Nothing is trimmed on a local estimate: whether this input fits the
      // summarizer's window is its provider's answer (`input_too_large`, which
      // the planner retreats on), and the output is capped outright (#4559).
      const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_HISTORY_COMPACT_MAX_OUTPUT_TOKENS;
      // Handed over whole by the backend, which owns every input a tracker
      // needs — including the run, which no summarizer wiring can know (#1679).
      const providerRequestTracker = input.providerRequestTracker;
      const ai =
        options.generateText && !providerRequestTracker ? undefined : await loadAiSdkTextModule();
      const generateText = options.generateText ?? ai!.generateText;
      const model = providerRequestTracker
        ? withProviderGenerateTracking({
            model: options.resolveModel(),
            wrapLanguageModel: ai!.wrapLanguageModel,
            tracker: providerRequestTracker,
            historyCompactRoute: 'text_summary',
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          })
        : options.resolveModel();
      let step = 0;
      const generateSummary = async (instructions: string, messages: ModelMessage[]) => {
        providerRequestTracker?.setStep(step);
        step += 1;
        const result = await generateText({
          model,
          instructions,
          messages,
          maxOutputTokens,
          ...(options.providerOptions !== undefined
            ? { providerOptions: options.providerOptions }
            : {}),
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });
        const usage = normalizeAiSdkUsage(result.usage);
        const truncated = rawFinishReasonString(result.finishReason) === 'length';
        // The size floor compares the summary with what it replaces. On a
        // roll-forward the request carries the previous summary plus the new
        // increment, so its input tokens are not the covered span and the
        // floor would judge the wrong number; it applies to the initial fold
        // only (#4559).
        const spanUsage =
          previousCheckpoint === undefined && usage !== undefined && usage.inputTokens > 0
            ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
            : undefined;
        const defect = truncated
          ? undefined
          : findCheckpointSummaryDefect(
              result.text,
              spanUsage ? { summarizerUsage: spanUsage } : undefined,
            );
        return { text: result.text, defect, truncated };
      };

      let initial = await generateSummary(SUMMARIZATION_SYSTEM_PROMPT, projectedMessages);
      if (initial.truncated) {
        // The provider cut the summary at the output cap. One shorter attempt;
        // a second cut is the provider saying this span will not summarize
        // inside the cap, and the fold fails open.
        initial = await generateSummary(shortenSummarizationSystemPrompt(), projectedMessages);
        if (initial.truncated) throw new HistoryCompactSummarizerError('output_length');
      }
      if (!initial.defect) return initial.text;
      if (!isMalformedHistoryCompactSummaryReason(initial.defect)) {
        throw new HistoryCompactSummarizerError(initial.defect);
      }

      // A malformed provider completion is often repairable, but retries must
      // be bounded: one stricter attempt, then the caller's failure circuit
      // records the stable defect for this compaction input.
      const repairInstructions = repairSummarizationSystemPrompt(initial.defect);
      let repaired: Awaited<ReturnType<typeof generateSummary>>;
      try {
        repaired = await generateSummary(repairInstructions, projectedMessages);
        if (repaired.truncated) throw new HistoryCompactSummarizerError('output_length');
      } catch (error) {
        if (isAbortError(error)) throw error;
        // The repair prompt is longer than the first one. If that is what pushed
        // the fold past the summarizer provider's window, the rejection is the
        // planner's retreat signal, not a repair failure to file under the
        // initial defect (#4559).
        if (classifyError(error) === 'ContextLength') {
          throw new HistoryCompactSummarizerError('input_too_large', { cause: error });
        }
        throw new HistoryCompactSummarizerError(initial.defect, {
          cause:
            error instanceof HistoryCompactSummarizerError
              ? error
              : new HistoryCompactSummarizerError('provider_error', { cause: error }),
        });
      }
      if (repaired.text.trim().length === 0) {
        throw new HistoryCompactSummarizerError(initial.defect, {
          cause: new Error('History compact repair returned an empty summary'),
        });
      }
      if (repaired.defect) {
        throw new HistoryCompactSummarizerError(initial.defect, {
          cause: new HistoryCompactSummarizerError(repaired.defect),
        });
      }
      return repaired.text;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof HistoryCompactSummarizerError) throw error;
      // The summarizer's provider is the one judge of whether this fold fits
      // its own window: a context-length rejection is the signal the planner
      // retreats on, so it must keep its name here (#4559).
      if (classifyError(error) === 'ContextLength') {
        throw new HistoryCompactSummarizerError('input_too_large', { cause: error });
      }
      throw new HistoryCompactSummarizerError('provider_error', { cause: error });
    }
  };
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

interface AiSdkTextModule {
  generateText: AiSdkGenerateTextLike;
  wrapLanguageModel(input: Record<string, unknown>): unknown;
}

async function loadAiSdkTextModule(): Promise<AiSdkTextModule> {
  const ai = await import('ai').catch((err) => {
    throw new Error(
      `Failed to load 'ai' package for history summarization. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
    );
  });
  return ai as unknown as AiSdkTextModule;
}

type ReplayPlanItems = ReturnType<typeof buildRuntimeEventModelReplayPlan>['items'];

interface OpenToolStep {
  stepId: string | undefined;
  calls: ToolCallPart[];
  callIds: Set<string>;
  settledCallIds: Set<string>;
  bufferedResults: ModelMessage[];
}

export function replayPlanItemsToModelMessages(items: ReplayPlanItems): ModelMessage[] {
  const out: ModelMessage[] = [];
  // One assistant step's tool calls share one assistant message and every
  // result is deferred to the step boundary: strict OpenAI-compatible
  // providers reject an assistant message that arrives while a previous
  // assistant message's tool calls are still unanswered, and Runtime history
  // can legitimately interleave a step's calls and results
  // (call A, call B, result A, call C, result B, result C). Step membership
  // follows the stamped stepId when both sides carry one; legacy items
  // without a stepId join while the open step still has unsettled calls,
  // which is exactly the interleaving case. This mirrors the primary replay
  // materializer's step merge; the primary path is untouched.
  let openStep: OpenToolStep | undefined;
  const flushOpenStep = () => {
    if (!openStep) return;
    out.push(...openStep.bufferedResults);
    openStep = undefined;
  };
  for (const item of items) {
    if (item.kind === 'text') {
      flushOpenStep();
      // Split on role so each push matches exactly one ModelMessage arm — no cast.
      const textPart = { type: 'text' as const, text: item.content };
      if (item.role === 'user') {
        out.push({ role: 'user', content: [textPart] });
      } else {
        out.push({ role: 'assistant', content: [textPart] });
      }
    } else if (item.kind === 'tool_call') {
      const part: ToolCallPart = {
        type: 'tool-call',
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        input: item.input,
      };
      const joinsOpenStep =
        openStep !== undefined &&
        (openStep.stepId !== undefined && item.stepId !== undefined
          ? openStep.stepId === item.stepId
          : openStep.settledCallIds.size < openStep.callIds.size);
      if (openStep && joinsOpenStep) {
        openStep.calls.push(part);
        openStep.callIds.add(item.toolCallId);
      } else {
        flushOpenStep();
        const calls = [part];
        openStep = {
          stepId: item.stepId,
          calls,
          callIds: new Set([item.toolCallId]),
          settledCallIds: new Set(),
          bufferedResults: [],
        };
        out.push({ role: 'assistant', content: calls });
      }
    } else if (item.kind === 'tool_result') {
      const message: ModelMessage = {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            output: effectiveReplayToolResultOutput(item),
          },
        ],
      };
      if (openStep?.callIds.has(item.toolCallId)) {
        openStep.settledCallIds.add(item.toolCallId);
        openStep.bufferedResults.push(message);
      } else {
        // A result for a call outside the open step means that step's block
        // is complete; settle it before emitting the foreign result.
        flushOpenStep();
        out.push(message);
      }
    }
    // thinking entries are intentionally skipped for summarization; they do
    // not interrupt an open tool step.
  }
  flushOpenStep();
  return out;
}
