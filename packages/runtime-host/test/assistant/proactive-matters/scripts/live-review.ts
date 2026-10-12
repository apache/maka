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

import { generateText, type LanguageModel } from 'ai';

/** Same generate contract as PluginLlmService; no fixture approval fallback. */
export function createLiveReviewer(
  model: LanguageModel,
  modelId: string,
  hooks: {
    beforeRequest?: () => void;
    onResult?: (entry: any) => void;
  } = {},
) {
  return async (input: {
    system: string;
    prompt: string;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }) => {
    hooks.beforeRequest?.();
    const startedAt = Date.now();
    const result = await generateText({
      model,
      system: input.system,
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.signal,
      maxRetries: 0,
    });
    hooks.onResult?.({
      startedAt,
      endedAt: Date.now(),
      modelId,
      text: result.text,
      usage: result.usage,
    });
    return { text: result.text, modelId };
  };
}
