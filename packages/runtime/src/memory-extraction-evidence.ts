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
import type { ModelMessage } from './model-protocol.js';

export interface MemoryExtractionEventEntry {
  readonly ordinal: number;
  readonly event: RuntimeEvent;
}

export interface MemoryExtractionEvidence {
  readonly sourceRef: string;
  readonly type: 'user_message';
  /** Exact bounded text shown to the model and used for admission. */
  readonly text: string;
  readonly events: readonly RuntimeEvent[];
  /** Full text actually visible in indexed Provider user messages. */
  readonly providerVisibleTexts?: readonly string[];
}

export interface MemoryCoveragePlan {
  readonly entries: readonly MemoryExtractionEventEntry[];
  readonly evidence: readonly MemoryExtractionEvidence[];
}

export const MAX_MEMORY_EVIDENCE_JSON_CHARS = 12_000;
const MAX_EVIDENCE_TEXT_CHARS = 4_000;
const MIN_EVIDENCE_TEXT_CHARS = 64;
const MAX_LOCALIZED_TURNS = 7;
const MAX_LOCALIZED_CONTEXT_CHARS = 12_000;
const MAX_LOCALIZED_EVENT_CHARS = 2_000;

/**
 * Plan one complete trigger range. Tool and Runtime-control Events deliberately
 * produce no evidence, but remain in the range so the Session Cursor crosses
 * them instead of repeatedly reconsidering them. If every User evidence record
 * cannot fit the bounded Evidence Index, fail closed instead of silently
 * consuming only part of the range.
 */
export function planMemoryCoverage(input: {
  readonly pendingEntries: readonly MemoryExtractionEventEntry[];
  readonly priorityEvidence?: readonly MemoryExtractionEvidence[];
  readonly maxEvidenceJsonChars?: number;
  readonly sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>;
  readonly sourceMessages?: readonly ModelMessage[];
}): MemoryCoveragePlan | undefined {
  if (input.pendingEntries.length === 0) return undefined;
  const priority = bindProviderVisibleEvidence(
    input.priorityEvidence ?? [],
    input.sourceMessages,
    input.sourceEventMessagePositions,
  );
  const budget = input.maxEvidenceJsonChars ?? MAX_MEMORY_EVIDENCE_JSON_CHARS;
  const fittedPriority = fitMemoryExtractionEvidence(
    priority,
    budget,
    input.sourceEventMessagePositions,
  );
  if (!fittedPriority) return undefined;
  const coverage = bindProviderVisibleEvidence(
    projectMemoryExtractionEvidence(input.pendingEntries.map(({ event }) => event)),
    input.sourceMessages,
    input.sourceEventMessagePositions,
  );
  const fitted = fitCoverageAroundPriority(
    fittedPriority,
    coverage,
    budget,
    input.sourceEventMessagePositions,
  );
  if (!fitted) return undefined;
  const fittedRefs = new Set(fitted.map(({ sourceRef }) => sourceRef));
  if (coverage.some(({ sourceRef }) => !fittedRefs.has(sourceRef))) return undefined;
  return { entries: [...input.pendingEntries], evidence: fitted };
}

/** Projects only stable user-authored text into Memory evidence. */
export function projectMemoryExtractionEvidence(
  events: readonly RuntimeEvent[],
  options: {
    readonly snippetTerms?: readonly string[];
  } = {},
): readonly MemoryExtractionEvidence[] {
  const stable = events.filter((event) => !event.partial);
  const projected: MemoryExtractionEvidence[] = [];
  for (const event of stable) {
    const content = event.content;
    if (!content) continue;
    if (content.kind === 'text' && event.role === 'user' && event.author === 'user') {
      const fullText = normalizeEvidenceText(content.text);
      if (!fullText) continue;
      projected.push({
        sourceRef: `event:${event.id}`,
        type: 'user_message',
        text: boundedEvidenceText(fullText, options.snippetTerms),
        events: [event],
      });
    }
  }
  return projected;
}

/**
 * Keep every evidence record represented while shrinking supplemental text to
 * the actual serialized JSON budget. Returning undefined means even the record
 * identities cannot fit and the Cursor must not advance.
 */
export function fitMemoryExtractionEvidence(
  evidence: readonly MemoryExtractionEvidence[],
  maxJsonChars = MAX_MEMORY_EVIDENCE_JSON_CHARS,
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
): readonly MemoryExtractionEvidence[] | undefined {
  if (!Number.isSafeInteger(maxJsonChars) || maxJsonChars < 1) return undefined;
  if (memoryExtractionEvidenceJsonSize(evidence, sourceEventMessagePositions) <= maxJsonChars) {
    return evidence;
  }
  let low = MIN_EVIDENCE_TEXT_CHARS;
  let high = MAX_EVIDENCE_TEXT_CHARS;
  let best: readonly MemoryExtractionEvidence[] | undefined;
  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const candidate = evidence.map((entry) => ({
      ...entry,
      text: sliceCodePoints(entry.text, cap),
    }));
    if (memoryExtractionEvidenceJsonSize(candidate, sourceEventMessagePositions) <= maxJsonChars) {
      best = candidate;
      low = cap + 1;
    } else {
      high = cap - 1;
    }
  }
  return best;
}

export function memoryExtractionEvidenceJsonSize(
  evidence: readonly MemoryExtractionEvidence[],
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
): number {
  return JSON.stringify(renderMemoryExtractionEvidence(evidence, sourceEventMessagePositions))
    .length;
}

export function renderMemoryExtractionEvidence(
  evidence: readonly MemoryExtractionEvidence[],
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
) {
  return evidence.map(({ sourceRef, type, text, events, providerVisibleTexts }) => {
    const messagePositions = uniqueSorted(
      events.flatMap((event) => sourceEventMessagePositions?.[event.id] ?? []),
    );
    const everyEventIndexed = providerVisibleTexts !== undefined;
    return {
      sourceRef,
      type,
      observedAt: minuteTimestamp(Math.max(0, ...events.map((event) => event.ts))),
      ...(everyEventIndexed ? { messagePositions } : { text }),
    };
  });
}

export function bindProviderVisibleEvidence(
  evidence: readonly MemoryExtractionEvidence[],
  sourceMessages: readonly ModelMessage[] | undefined,
  sourceEventMessagePositions: Readonly<Record<string, readonly number[]>> | undefined,
): readonly MemoryExtractionEvidence[] {
  if (!sourceMessages || !sourceEventMessagePositions) return evidence;
  return evidence.map((entry) => {
    const positions = uniqueSorted(
      entry.events.flatMap((event) => sourceEventMessagePositions[event.id] ?? []),
    );
    if (
      positions.length === 0 ||
      entry.events.some((event) => (sourceEventMessagePositions[event.id]?.length ?? 0) === 0)
    ) {
      return entry;
    }
    const visibleByPosition = positions.map((position) => {
      const message = sourceMessages[position];
      if (!message || message.role !== 'user') return [];
      if (typeof message.content === 'string') {
        const text = normalizeEvidenceText(message.content);
        return text ? [text] : [];
      }
      return message.content.flatMap((part) => {
        if (part.type !== 'text') return [];
        const text = normalizeEvidenceText(part.text);
        return text ? [text] : [];
      });
    });
    if (visibleByPosition.some((texts) => texts.length === 0)) {
      return entry;
    }
    return { ...entry, providerVisibleTexts: visibleByPosition.flat() };
  });
}

/** Preserve requested evidence once fitted; all coverage records must fit. */
function fitCoverageAroundPriority(
  priority: readonly MemoryExtractionEvidence[],
  coverage: readonly MemoryExtractionEvidence[],
  maxJsonChars: number,
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
): readonly MemoryExtractionEvidence[] | undefined {
  const priorityRefs = new Set(priority.map(({ sourceRef }) => sourceRef));
  const remaining = coverage.filter(({ sourceRef }) => !priorityRefs.has(sourceRef));
  const merged = [...priority, ...remaining];
  if (memoryExtractionEvidenceJsonSize(merged, sourceEventMessagePositions) <= maxJsonChars) {
    return merged;
  }
  if (remaining.length === 0) return undefined;

  const fit = (entries: readonly MemoryExtractionEvidence[]) => {
    let low = MIN_EVIDENCE_TEXT_CHARS;
    let high = MAX_EVIDENCE_TEXT_CHARS;
    let best: readonly MemoryExtractionEvidence[] | undefined;
    while (low <= high) {
      const cap = Math.floor((low + high) / 2);
      const candidate = [
        ...priority,
        ...entries.map((entry) => ({ ...entry, text: sliceCodePoints(entry.text, cap) })),
      ];
      if (
        memoryExtractionEvidenceJsonSize(candidate, sourceEventMessagePositions) <= maxJsonChars
      ) {
        best = candidate;
        low = cap + 1;
      } else {
        high = cap - 1;
      }
    }
    return best;
  };

  return fit(remaining);
}

/** Rank matching Turns by term coverage and recency, then add a one-Turn neighborhood. */
export function searchSameSessionMemoryHistory(
  entries: readonly MemoryExtractionEventEntry[],
  throughOrdinal: number,
  search: { readonly terms: readonly string[]; readonly roles?: readonly string[] },
  afterOrdinal = 0,
): readonly MemoryExtractionEventEntry[] {
  const eligible = entries.filter(
    ({ ordinal, event }) =>
      ordinal > afterOrdinal &&
      ordinal <= throughOrdinal &&
      !event.partial &&
      event.content?.kind === 'text' &&
      ((event.role === 'user' && event.author === 'user') ||
        (event.role === 'model' && event.author === 'agent')),
  );
  const turns: Array<{ key: string; entries: MemoryExtractionEventEntry[] }> = [];
  for (const entry of eligible) {
    const key = `${entry.event.runId}\0${entry.event.turnId}`;
    const last = turns.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else turns.push({ key, entries: [entry] });
  }

  const terms = search.terms.map((term) => normalizeEvidenceText(term).toLowerCase());
  const allowedRoles = search.roles ? new Set(search.roles) : undefined;
  const hits = turns
    .map((turn, index) => ({
      index,
      score: terms.filter((term) =>
        turn.entries.some(({ event }) => {
          if (allowedRoles && !allowedRoles.has(historyRole(event))) return false;
          return normalizeEvidenceText(event.content?.kind === 'text' ? event.content.text : '')
            .toLowerCase()
            .includes(term);
        }),
      ).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index);

  const selected = new Set<number>();
  for (const hit of hits) {
    for (const index of [hit.index, hit.index - 1, hit.index + 1]) {
      if (index < 0 || index >= turns.length || selected.has(index)) continue;
      if (selected.size >= MAX_LOCALIZED_TURNS) break;
      selected.add(index);
    }
    if (selected.size >= MAX_LOCALIZED_TURNS) break;
  }
  return [...selected]
    .sort((left, right) => left - right)
    .flatMap((index) => turns[index]!.entries);
}

/** Bounded User/Assistant text used only to interpret elliptical user evidence. */
export function renderMemoryLocalizationContext(
  entries: readonly MemoryExtractionEventEntry[],
): string {
  let remaining = MAX_LOCALIZED_CONTEXT_CHARS;
  const rendered: string[] = [];
  for (const { event } of entries) {
    if (remaining <= 0 || event.partial || event.content?.kind !== 'text') continue;
    const role = historyRole(event);
    const text = sliceCodePoints(
      normalizeEvidenceText(event.content.text),
      MAX_LOCALIZED_EVENT_CHARS,
    );
    if (!text) continue;
    const line = `[${role} event:${event.id}] ${text}`;
    const bounded = sliceCodePoints(line, remaining);
    rendered.push(bounded);
    remaining -= Array.from(bounded).length;
  }
  return rendered.join('\n');
}

export function isMemoryToolName(name: string): boolean {
  return name === 'memory_remember' || name === 'memory_extract';
}

function boundedEvidenceText(value: string, terms: readonly string[] | undefined): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_EVIDENCE_TEXT_CHARS) return value;
  const normalizedTerms = terms
    ?.map((term) => normalizeEvidenceText(term).toLowerCase())
    .filter(Boolean);
  const lower = value.toLowerCase();
  const hit = normalizedTerms
    ?.map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (hit === undefined) return codePoints.slice(0, MAX_EVIDENCE_TEXT_CHARS).join('');
  const before = Math.floor(MAX_EVIDENCE_TEXT_CHARS / 3);
  const start = Math.max(0, Array.from(value.slice(0, hit)).length - before);
  return codePoints.slice(start, start + MAX_EVIDENCE_TEXT_CHARS).join('');
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function minuteTimestamp(value: number): number {
  return Math.floor(value / 60_000) * 60_000;
}

function historyRole(event: RuntimeEvent): 'user' | 'assistant' {
  return event.role === 'model' ? 'assistant' : 'user';
}

function sliceCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
