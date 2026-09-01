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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import { resolveSelectedModelContextWindow } from './context-budget-policy.js';
import { stableJsonLength } from './context-budget-helpers.js';
import { groupEventsByTurn } from './model-history.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import { fitHistoryCompactMessages } from './history-compact-input-fit.js';
import { replayPlanItemsToModelMessages } from './history-compact-summarizer.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import type { ModelMessage } from './model-protocol.js';

export const SESSION_RECAP_INSTRUCTION =
  '<system-reminder>The user is returning to this session after being away. Write ONE sentence (roughly 25-40 words) recapping where things stand so they can resume instantly. Write the sentence in the language of the user\'s most recent substantive message; for mixed-language sessions use the dominant language of the user\'s messages. Lead with agency, phrased naturally in that language: if the session was mainly questions or review with no landed change, open by referencing what the user asked (the equivalent of "You asked ..."); if the agent landed changes, reference what was done (the equivalent of "We fixed/added/wired ..."); if almost nothing happened, say in that language that the session had just begun. Output only the sentence - no labels, no quotes, no preamble.</system-reminder>';

export function buildSessionRecapMessages(input: {
  readonly events: readonly RuntimeEvent[];
  readonly connection: RuntimeExecutionConnection;
  readonly modelId: string;
}): ModelMessage[] {
  const contextWindow = resolveSelectedModelContextWindow(input.connection, input.modelId);
  let events = input.events;
  let maxEstimatedTokens: number | undefined;
  if (contextWindow !== undefined) {
    maxEstimatedTokens = Math.max(0, Math.floor(contextWindow * 0.85) - 4_096);
    events = recentTurnsWithinBudget(events, maxEstimatedTokens);
  }
  let messages = replayPlanItemsToModelMessages(buildRuntimeEventModelReplayPlan(events).items);
  if (
    messages.length === 0 &&
    input.events.length > 0 &&
    maxEstimatedTokens !== undefined &&
    maxEstimatedTokens > 0
  ) {
    const latestTurn = groupEventsByTurn(input.events, 4).at(-1)?.events ?? [];
    messages = boundedOversizedTurnMessages(latestTurn, maxEstimatedTokens);
  }
  messages.push({ role: 'user', content: SESSION_RECAP_INSTRUCTION });
  return messages;
}

/** Request-only recap projection; never mutates or replaces canonical history. */
function recentTurnsWithinBudget(
  events: readonly RuntimeEvent[],
  maxEstimatedTokens: number,
  charsPerToken = 4,
): RuntimeEvent[] {
  const groups = groupEventsByTurn(events, charsPerToken);
  const selected: RuntimeEvent[][] = [];
  let selectedTokens = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (selectedTokens + group.estimatedTokens > maxEstimatedTokens) break;
    selected.unshift(group.events);
    selectedTokens += group.estimatedTokens;
  }
  return selected.flat();
}

function boundedOversizedTurnMessages(
  events: readonly RuntimeEvent[],
  maxEstimatedTokens: number,
  charsPerToken = 4,
): ModelMessage[] {
  const messages = replayPlanItemsToModelMessages(buildRuntimeEventModelReplayPlan(events).items);
  try {
    return fitHistoryCompactMessages(messages, {
      maxInputEstimatedTokens: maxEstimatedTokens,
      charsPerToken,
    });
  } catch (error) {
    if (!(error instanceof HistoryCompactSummarizerError) || error.reason !== 'input_too_large') {
      throw error;
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    if (!text) continue;
    return [boundedTextMessage(message.role, text, maxEstimatedTokens * charsPerToken)];
  }
  return [];
}

function boundedTextMessage(
  role: 'user' | 'assistant',
  text: string,
  maxEstimatedChars: number,
): ModelMessage {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate: ModelMessage = { role, content: boundedText(text, middle) };
    if (stableJsonLength([candidate]) <= maxEstimatedChars) low = middle;
    else high = middle - 1;
  }
  return { role, content: boundedText(text, low) };
}

function boundedText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '\n[… earlier recap evidence omitted …]\n';
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (remaining - head))}`;
}

export function cleanSessionRecapText(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(recap|summary|回顾)\s*[:：]\s*/i, '').trim();

  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
  ];
  for (const [open, close] of quotePairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }

  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}
