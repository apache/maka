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

import { finitePositive, stableJsonLength } from './context-budget-helpers.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import type { ModelMessage } from './model-protocol.js';

const COMPACTION_TOOL_OUTPUT_PLACEHOLDER =
  '[Tool output omitted because it exceeded the compaction input budget.]';

/**
 * Bound a compaction request without breaking tool-call chronology. Old tool
 * outputs are the only lossy candidates: replacing their payload keeps every
 * call/result pair valid and preserves more recent evidence.
 */
export function fitHistoryCompactMessages(
  messages: readonly ModelMessage[],
  options: {
    maxInputEstimatedTokens?: number;
    charsPerToken?: number;
    fixedInputChars?: number;
  },
): ModelMessage[] {
  const maxEstimatedTokens = finitePositive(options.maxInputEstimatedTokens);
  if (maxEstimatedTokens === undefined) return [...messages];
  const charsPerToken = finitePositive(options.charsPerToken) ?? 4;
  const maxEstimatedChars = maxEstimatedTokens * charsPerToken;
  let estimatedChars = (finitePositive(options.fixedInputChars) ?? 0) + stableJsonLength(messages);
  if (estimatedChars <= maxEstimatedChars) return [...messages];

  let bounded = [...messages];
  for (let messageIndex = 0; messageIndex < bounded.length; messageIndex += 1) {
    const message = bounded[messageIndex]!;
    if (message.role !== 'tool') continue;
    for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
      const part = message.content[partIndex]!;
      if (part.type !== 'tool-result') continue;
      const output =
        part.output.type === 'error-text' || part.output.type === 'error-json'
          ? { type: 'error-text' as const, value: COMPACTION_TOOL_OUTPUT_PLACEHOLDER }
          : { type: 'text' as const, value: COMPACTION_TOOL_OUTPUT_PLACEHOLDER };
      const replacement = {
        ...part,
        output,
      };
      const originalChars = stableJsonLength(part);
      const replacementChars = stableJsonLength(replacement);
      if (replacementChars >= originalChars) continue;
      const content = [...message.content];
      content[partIndex] = replacement;
      bounded = [...bounded];
      bounded[messageIndex] = { ...message, content };
      estimatedChars -= originalChars - replacementChars;
      if (estimatedChars <= maxEstimatedChars) return bounded;
    }
  }

  throw new HistoryCompactSummarizerError('input_too_large');
}
