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

import { runtimeEventHasModelVisibleContent, type RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import { resolveSelectedModelContextWindow } from './context-budget-policy.js';
import { stableJsonLength } from './context-budget-helpers.js';
import { groupEventsByTurn } from './model-history.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import { fitHistoryCompactMessages } from './history-compact-input-fit.js';
import type { ModelMessage } from './model-protocol.js';

const SESSION_RECAP_TOOL_OUTCOME_MAX_CHARS = 600;

export const SESSION_RECAP_INSTRUCTION =
  '<system-reminder>The user is returning to this session after being away. Write ONE sentence (roughly 25-40 words) recapping where things stand so they can resume instantly. Write the sentence in the language of the user\'s most recent substantive message; for mixed-language sessions use the dominant language of the user\'s messages. Lead with agency, phrased naturally in that language: if the session was mainly questions or review with no landed change, open by referencing what the user asked (the equivalent of "You asked ..."); if the agent landed changes, reference what was done (the equivalent of "We fixed/added/wired ..."); if almost nothing happened, say in that language that the session had just begun. Output only the sentence - no labels, no quotes, no preamble.</system-reminder>';

export function buildSessionRecapMessages(input: {
  readonly events: readonly RuntimeEvent[];
  readonly connection: RuntimeExecutionConnection;
  readonly modelId: string;
}): ModelMessage[] {
  const contextWindow = resolveSelectedModelContextWindow(input.connection, input.modelId);
  let maxEstimatedTokens: number | undefined;
  let messages: ModelMessage[];
  if (contextWindow !== undefined) {
    maxEstimatedTokens = Math.max(0, Math.floor(contextWindow * 0.85) - 4_096);
    messages = recentRecapMessagesWithinBudget(input.events, maxEstimatedTokens);
  } else {
    messages = projectSessionRecapMessages(input.events);
  }
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
function recentRecapMessagesWithinBudget(
  events: readonly RuntimeEvent[],
  maxEstimatedTokens: number,
  charsPerToken = 4,
): ModelMessage[] {
  const groups = groupEventsByTurn(events, charsPerToken);
  const selectedGroups: ModelMessage[][] = [];
  let selectedChars = 2;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const projected = projectSessionRecapMessages(groups[index]!.events);
    if (projected.length === 0) continue;
    const projectedChars = stableJsonLength(projected);
    const candidateChars =
      selectedGroups.length === 0 ? projectedChars : projectedChars + selectedChars - 1;
    if (candidateChars > maxEstimatedTokens * charsPerToken) break;
    selectedGroups.push(projected);
    selectedChars = candidateChars;
  }
  return selectedGroups.reverse().flat();
}

function boundedOversizedTurnMessages(
  events: readonly RuntimeEvent[],
  maxEstimatedTokens: number,
  charsPerToken = 4,
): ModelMessage[] {
  const messages = projectSessionRecapMessages(events);
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

function projectSessionRecapMessages(events: readonly RuntimeEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const event of events) {
    if (event.partial === true || !runtimeEventHasModelVisibleContent(event)) continue;
    const content = event.content;
    if (content?.kind === 'text' && (event.role === 'user' || event.role === 'model')) {
      const text = content.text.trim();
      if (text.length > 0) {
        messages.push({ role: event.role === 'user' ? 'user' : 'assistant', content: text });
      }
      continue;
    }
    if (content?.kind !== 'function_response') continue;
    const status = recapToolOutcomeStatus(content.isError === true, content.modelProjection);
    const detail = recapToolOutcomeDetail(content.modelProjection);
    messages.push({
      role: 'assistant',
      content: `Tool outcome (${content.name}, ${status})${detail ? `: ${detail}` : '.'}`,
    });
  }
  return messages;
}

function recapToolOutcomeStatus(
  isError: boolean,
  projection: DurableToolResultProjection | undefined,
): 'succeeded' | 'failed' | 'denied' {
  if (projection?.kind === 'execution_denied') return 'denied';
  if (
    isError ||
    projection?.kind === 'failure' ||
    ((projection?.kind === 'text' || projection?.kind === 'json') && projection.isError === true)
  ) {
    return 'failed';
  }
  return 'succeeded';
}

function recapToolOutcomeDetail(projection: DurableToolResultProjection | undefined): string {
  if (!projection) return '';
  let detail: string;
  switch (projection.kind) {
    case 'text':
      detail = projection.text;
      break;
    case 'json':
      detail = JSON.stringify(projection.value);
      break;
    case 'content':
      detail = projection.parts
        .map((part) =>
          part.kind === 'text'
            ? part.text
            : `[stored artifact: ${part.ref.kind === 'session_context' ? part.ref.refId : part.ref.relativePath}]`,
        )
        .join('\n');
      break;
    case 'execution_denied':
      detail = projection.reason ?? '';
      break;
    case 'failure':
      detail = projection.message;
      break;
  }
  return boundedText(detail.trim(), SESSION_RECAP_TOOL_OUTCOME_MAX_CHARS);
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
