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
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import { isArchivedToolResultPlaceholder } from './tool-result-archive.js';
import {
  estimateRuntimeEventsTokens,
  finitePositive,
  stableStringify,
  tokenizeSearchQuery,
  turnKey,
} from './context-budget-helpers.js';

export interface RuntimeEventHistorySearchPolicy {
  enabled: boolean;
  query?: string;
  maxResults?: number;
  around?: number;
  maxEstimatedTokens?: number;
}

export interface RuntimeEventHistorySearchHit {
  eventId: string;
  turnId: string;
  ts: number;
  score: number;
  matchedTerms: string[];
}

export interface RuntimeEventHistoryAroundResult {
  events: RuntimeEvent[];
  hits: RuntimeEventHistorySearchHit[];
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

export function searchRuntimeEventHistory(
  events: readonly RuntimeEvent[],
  query: string,
  policy: RuntimeEventHistorySearchPolicy | undefined,
): RuntimeEventHistorySearchHit[] {
  if (policy?.enabled !== true) return [];
  const terms = tokenizeSearchQuery(query);
  if (terms.length === 0) return [];
  const maxResults = finitePositive(policy.maxResults) ?? 5;
  return events
    .map((event) => scoreRuntimeEventSearchHit(event, terms))
    .filter((hit): hit is RuntimeEventHistorySearchHit => hit !== undefined)
    .sort((a, b) => b.score - a.score || b.ts - a.ts || b.eventId.localeCompare(a.eventId))
    .slice(0, maxResults);
}

export function retrieveRuntimeEventHistoryAround(
  events: readonly RuntimeEvent[],
  query: string,
  policy: RuntimeEventHistorySearchPolicy | undefined,
  options: { charsPerToken?: number } = {},
): RuntimeEventHistoryAroundResult {
  if (policy?.enabled !== true) {
    return { events: [], hits: [], diagnosticPatch: {} };
  }
  const charsPerToken = options.charsPerToken ?? 4;
  const around = Math.max(0, Math.floor(policy.around ?? 1));
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 4_096;
  const hits = searchRuntimeEventHistory(events, policy.query ?? query, policy);
  const selectedIndexes = new Set<number>();
  const indexesByEventId = new Map(events.map((event, index) => [event.id, index]));
  for (const hit of hits) {
    const index = indexesByEventId.get(hit.eventId);
    if (index === undefined) continue;
    for (
      let cursor = Math.max(0, index - around);
      cursor <= Math.min(events.length - 1, index + around);
      cursor += 1
    ) {
      selectedIndexes.add(cursor);
    }
  }

  const selectedEvents: RuntimeEvent[] = [];
  let selectedTokens = 0;
  let skipped = 0;
  for (const index of [...selectedIndexes].sort((a, b) => a - b)) {
    const event = events[index]!;
    const estimate = estimateRuntimeEventsTokens([event], charsPerToken);
    if (selectedTokens + estimate > maxEstimatedTokens) {
      skipped += 1;
      continue;
    }
    selectedEvents.push(event);
    selectedTokens += estimate;
  }

  return {
    events: selectedEvents,
    hits,
    diagnosticPatch: {
      historySearchMatches: hits.length,
      historyAroundRetrievedEvents: selectedEvents.length,
      historyAroundEstimatedTokens: selectedTokens,
      ...(skipped > 0 ? { historyAroundSkippedEvents: skipped } : {}),
    },
  };
}

function scoreRuntimeEventSearchHit(
  event: RuntimeEvent,
  terms: readonly string[],
): RuntimeEventHistorySearchHit | undefined {
  const haystack = runtimeEventSearchText(event).toLowerCase();
  if (!haystack) return undefined;
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    matchedTerms.push(term);
    score += term.length;
  }
  if (score <= 0) return undefined;
  return {
    eventId: event.id,
    turnId: turnKey(event),
    ts: event.ts,
    score,
    matchedTerms,
  };
}

export function runtimeEventSearchText(event: RuntimeEvent): string {
  const content = event.content;
  if (!content) return '';
  switch (content.kind) {
    case 'text':
    case 'thinking':
      return content.text;
    case 'function_call':
      return `${content.name} ${stableStringify(content.args)}`;
    case 'function_response':
      if (isArchivedToolResultPlaceholder(content.result)) {
        return [
          content.name,
          content.result.toolName,
          content.result.toolCallId,
          content.result.artifactId,
          content.result.bodySha256,
          content.result.reason,
        ].join(' ');
      }
      return `${content.name} ${stableStringify(content.result)}`;
    case 'error':
      return `${content.message} ${content.reason ?? ''} ${content.code ?? ''}`;
  }
}
