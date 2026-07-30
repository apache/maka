import type { LlmCallRecord } from '@maka/core/usage-stats/types';
import type { NormalizedUsage } from '../model-protocol.js';

type LlmCallUsageFields = Pick<
  LlmCallRecord,
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheHitInputTokens'
  | 'cacheMissInputTokens'
  | 'cacheMissInputSource'
  | 'cachedInputTokens'
  | 'cacheWriteInputTokens'
  | 'reasoningTokens'
  | 'totalTokens'
  | 'rawFinishReason'
  | 'rawUsage'
>;

export function llmCallUsageFields(usage: NormalizedUsage): LlmCallUsageFields {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheHitInputTokens: usage.cacheHitInputTokens,
    cacheMissInputTokens: usage.cacheMissInputTokens,
    cacheMissInputSource: usage.cacheMissInputSource,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    ...(usage.rawFinishReason !== undefined ? { rawFinishReason: usage.rawFinishReason } : {}),
    ...(usage.raw !== undefined ? { rawUsage: usage.raw } : {}),
  };
}
