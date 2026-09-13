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

import type { ModelMessage } from './model-protocol.js';
import { lowerModelTools, normalizeAiSdkUsage, type AiSdkUsageLike } from './model-adapter.js';
import { rawFinishReasonString, type NormalizedUsage } from './model-protocol.js';
import type { ModelToolSet } from './model-protocol.js';

export type ToolFreeModelCallContent =
  | { readonly prompt: string; readonly messages?: never }
  | { readonly prompt?: never; readonly messages: readonly ModelMessage[] };

export type ToolFreeModelCallInput = ToolFreeModelCallContent & {
  readonly model: unknown;
  /** Optional original Agent system prefix for cache-compatible auxiliary calls. */
  readonly system?: string;
  readonly providerOptions?: unknown;
  readonly abortSignal?: AbortSignal;
  readonly maxOutputTokens: number;
  readonly maxRetries?: number;
};

export interface ToolFreeModelCallResult {
  readonly text: string;
  readonly usage?: NormalizedUsage;
  readonly finishReason?: string;
}

export interface ProviderPrefixModelCallInput {
  readonly model: unknown;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: ModelToolSet;
  readonly activeTools: readonly string[];
  readonly providerOptions?: unknown;
  readonly abortSignal?: AbortSignal;
  readonly maxOutputTokens?: number;
  /** Anthropic omits Tool schemas when AI SDK receives `none`; omit there and fail closed below. */
  readonly toolChoicePolicy: 'none' | 'omit';
}

export type ProviderPrefixModelCallResult = ToolFreeModelCallResult;

export class ProviderPrefixModelCallUnavailableError extends Error {
  readonly name = 'ProviderPrefixModelCallUnavailableError';
}

/** One non-continuing call that preserves the source Agent's provider-visible prefix. */
export async function generateProviderPrefixModelCall(
  input: ProviderPrefixModelCallInput,
): Promise<ProviderPrefixModelCallResult> {
  if (input.activeTools.some((name) => input.tools[name]?.kind === 'provider')) {
    // Provider-native Tools may execute remotely before a response exists, and
    // compatible endpoints are not guaranteed to honor `toolChoice: 'none'`.
    // Never dispatch an auxiliary request with one active, regardless of the
    // transport-specific Tool-choice policy.
    throw new ProviderPrefixModelCallUnavailableError(
      'Memory extraction is unavailable with active provider-native Tools',
    );
  }
  const ai = (await import('ai')) as unknown as {
    generateText(options: Record<string, unknown>): Promise<{
      text: string;
      toolCalls?: readonly unknown[];
      usage?: AiSdkUsageLike;
      finishReason?: unknown;
    }>;
  };
  const result = await ai.generateText({
    model: input.model,
    ...(input.system === undefined ? {} : { system: input.system }),
    messages: input.messages,
    tools: lowerModelTools(input.tools),
    activeTools: input.activeTools,
    // Preserve the source request's Tool schema for Provider cache reuse. Most
    // adapters can disable calls while retaining schemas; Anthropic cannot, so
    // its request keeps the source default and the result is rejected below if
    // the model nevertheless chooses a Tool.
    ...(input.toolChoicePolicy === 'none' ? { toolChoice: 'none' } : {}),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    maxRetries: 0,
  });
  if ((result.toolCalls?.length ?? 0) > 0) {
    throw new Error('Provider returned a disabled Tool Call');
  }
  const usage = normalizeAiSdkUsage(result.usage, { rawFinishReason: result.finishReason });
  const finishReason = rawFinishReasonString(result.finishReason);
  return {
    text: result.text,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Runs one model call without exposing tools and returns its accounting facts. */
export async function generateToolFreeModelCall(
  input: ToolFreeModelCallInput,
): Promise<ToolFreeModelCallResult> {
  const ai = (await import('ai')) as unknown as {
    generateText(options: Record<string, unknown>): Promise<{
      text: string;
      usage?: AiSdkUsageLike;
      finishReason?: unknown;
    }>;
  };
  const result = await ai.generateText({
    model: input.model,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.prompt === undefined ? { messages: input.messages } : { prompt: input.prompt }),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
    maxOutputTokens: input.maxOutputTokens,
    ...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
  });
  const usage = normalizeAiSdkUsage(result.usage, { rawFinishReason: result.finishReason });
  const finishReason = rawFinishReasonString(result.finishReason);
  return {
    text: result.text,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
