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
