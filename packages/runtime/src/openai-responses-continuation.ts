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
