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

import { isDeepStrictEqual } from 'node:util';

import type { ModelMessage } from './model-protocol.js';

export interface OpenAiResponsesSemanticBaseline {
  requestMessages: readonly ModelMessage[];
  responseMessages: readonly ModelMessage[];
  responseId: string;
}

export interface OpenAiResponsesContinuationPlan {
  messages: ModelMessage[];
  previousResponseId?: string;
}

/**
 * Recover the provider step from Maka's durable replay after its client tool
 * calls have settled. The replay is authoritative: unlike `sdk.response.messages`
 * it has the exact provider-option placement that the next Runtime request will
 * carry.
 *
 * Fail closed when request shaping means the durable projection no longer has
 * the sent request as an exact prefix, or when the expected tool-result tail is
 * absent. Either case simply disables continuation for the next request.
 */
export function persistedOpenAiResponsesStepMessages(
  requestMessages: readonly ModelMessage[],
  replayedMessages: readonly ModelMessage[],
  settledToolCallIds: readonly string[],
): ModelMessage[] | undefined {
  if (replayedMessages.length <= requestMessages.length + settledToolCallIds.length) {
    return undefined;
  }
  for (let index = 0; index < requestMessages.length; index += 1) {
    if (!isDeepStrictEqual(replayedMessages[index], requestMessages[index])) return undefined;
  }

  const appended = replayedMessages.slice(requestMessages.length);
  const responseLength = appended.length - settledToolCallIds.length;
  for (let index = 0; index < settledToolCallIds.length; index += 1) {
    const message = appended[responseLength + index];
    if (!isToolResultMessageFor(message, settledToolCallIds[index]!)) return undefined;
  }
  const responseMessages = appended.slice(0, responseLength);
  return responseMessages.length > 0 ? responseMessages : undefined;
}

export function planOpenAiResponsesContinuation(
  messages: readonly ModelMessage[],
  baseline: OpenAiResponsesSemanticBaseline | undefined,
): OpenAiResponsesContinuationPlan {
  const full = [...messages];
  if (!baseline?.responseId) return { messages: full };

  const prefix = [...baseline.requestMessages, ...baseline.responseMessages];
  if (messages.length <= prefix.length) return { messages: full };
  for (let index = 0; index < prefix.length; index += 1) {
    if (!isDeepStrictEqual(messages[index], prefix[index])) return { messages: full };
  }
  return {
    messages: messages.slice(prefix.length),
    previousResponseId: baseline.responseId,
  };
}

export function mergeOpenAiResponsesProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
  sessionId: string,
  previousResponseId?: string,
): Record<string, unknown> {
  const openaiValue = providerOptions?.openai;
  const openai =
    openaiValue && typeof openaiValue === 'object' && !Array.isArray(openaiValue)
      ? (openaiValue as Record<string, unknown>)
      : {};
  return {
    ...providerOptions,
    openai: {
      ...openai,
      ...(openai.promptCacheKey === undefined ? { promptCacheKey: `maka:${sessionId}` } : {}),
      ...(previousResponseId === undefined ? {} : { previousResponseId }),
    },
  };
}

function isToolResultMessageFor(message: ModelMessage | undefined, toolCallId: string): boolean {
  return (
    message?.role === 'tool' &&
    message.content.some((part) => part.type === 'tool-result' && part.toolCallId === toolCallId)
  );
}
