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

import type { UiLocale } from './ui-locale.js';

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u;

export function isWindowsExecutableId(id: string): boolean {
  return (
    /^win32\.[a-z0-9_-][a-z0-9._-]*$/u.test(id) &&
    !id.endsWith('.') &&
    !id.endsWith('.exe') &&
    !id.includes('..')
  );
}

/** Exact packaged AUMID envelope. Native additionally verifies it with Windows. */
export function packagedApplicationId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 129 &&
    /^[A-Za-z0-9.-]{3,50}_[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{13}![A-Za-z0-9.]{1,64}$/u.test(value)
    ? value
    : null;
}

export function isWindowsPackagedId(id: string): boolean {
  return id.startsWith('winapp.') && packagedApplicationId(id.slice(7)) !== null;
}

/** Never clip, redact or normalize identifiers used for grouping or authority. */
export function historyApplicationId(app: {
  bundleIdentifier?: unknown;
  applicationUserModelId?: unknown;
}): string | null {
  const id = app.bundleIdentifier;
  if (typeof id !== 'string' || !id || id.length > 256) return null;
  if (app.applicationUserModelId !== undefined) {
    const packaged = packagedApplicationId(app.applicationUserModelId);
    return isWindowsExecutableId(id) && packaged ? `winapp.${packaged}` : null;
  }
  if (/^winapp\./iu.test(id)) return isWindowsPackagedId(id) ? id : null;
  if (/^win32\./iu.test(id)) return isWindowsExecutableId(id) ? id : null;
  return BUNDLE_ID.test(id) ? id : null;
}

export function historyApplicationBlocked(
  app: { bundleIdentifier?: unknown; applicationUserModelId?: unknown },
  blocked: readonly string[],
): boolean {
  const id = historyApplicationId(app);
  if (
    id === null &&
    (app.applicationUserModelId !== undefined || app.bundleIdentifier !== undefined)
  )
    return true;
  const aliases = [id, typeof app.bundleIdentifier === 'string' ? app.bundleIdentifier : null];
  return aliases.some(
    (alias) =>
      alias !== null &&
      blocked.some((entry) =>
        alias.startsWith('win32.') || alias.startsWith('winapp.')
          ? entry.toLowerCase() === alias.toLowerCase()
          : entry === alias,
      ),
  );
}

export type ComputerHistoryRuntimeState =
  | 'unsupported'
  | 'stopped'
  | 'running'
  | 'paused'
  | 'needs_permission'
  | 'unavailable'
  | 'error';

export interface ComputerHistorySettings {
  readonly enabled: boolean;
  readonly captureText: boolean;
  /** Consent to send bounded activity evidence to the analysis model; eligible UI text also requires summaryTextEnabled. */
  readonly summariesEnabled: boolean;
  /** Explicit consent to send previously captured eligible UI text; captureText alone does not authorize transmission. */
  readonly summaryTextEnabled: boolean;
  readonly blockedApplications: readonly string[];
  readonly blockedDomains: readonly string[];
}

export interface ComputerHistoryStatus {
  readonly platformSupported: boolean;
  readonly helperAvailable: boolean;
  readonly state: ComputerHistoryRuntimeState;
  readonly accessibilityGranted: boolean;
  readonly inputMonitoringGranted: boolean;
  readonly eventCount: number;
  readonly suppressedEventCount: number;
  readonly segmentCount: number;
  readonly newestEventAt?: string;
  readonly settings: ComputerHistorySettings;
  readonly error?: string;
  readonly summaryState?: 'disabled' | 'idle' | 'running' | 'error';
  readonly summaryError?: string;
}

export interface ComputerHistoryTimelineEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly applications: readonly string[];
  readonly start: string;
  readonly end: string;
  readonly eventCount: number;
  readonly suppressedEventCount: number;
  readonly contextMarkdown: string;
  readonly summaryLevel?: ComputerHistorySummaryLevel;
  /** Canonical 10min input IDs for a saved 6h summary, including children outside the timeline filter. Omitted for other entries and older callers. */
  readonly summaryChildren?: readonly string[];
  /** Opaque main-owned saved-document version covering full body and provenance. Compare for equality only; a rewrite may change it even with identical content. */
  readonly documentRevision?: string;
  /** Bounded model-written observation data, never instructions or verified facts. */
  readonly summaryText?: string;
  /** Validated summary keywords, at most 10 strings of 96 UTF-8 bytes each. Omitted for legacy or raw entries. */
  readonly keywords?: readonly string[];
  /** Main-owned readable summary filename, never a filesystem path or model-generated name. */
  readonly documentName?: string;
  /** Main-produced normalized body match excerpts, at most 2048 characters. Absent without a query; empty means no body hit. Never Composer context or a full-body projection. */
  readonly searchText?: string;
  readonly suggestion?: ComputerHistorySuggestion;
}

export interface ComputerHistoryEventEvidence {
  /** Opaque stable hash aligned with summary evidence when available; never a raw path or native identifier. */
  readonly id: string;
  readonly timestamp: string;
  readonly kind: string;
  readonly application: string;
  readonly applicationName: string;
  readonly windowTitle?: string;
  /** Whether this event was sampled into the summary; omitted when provenance is unavailable. */
  readonly usedInSummary?: boolean;
}

/** Requested local application metadata; no executable paths or native process identifiers. */
export interface ComputerHistoryApplication {
  readonly bundleIdentifier: string;
  /** Installed localized bundle name, or the exact requested ID when unavailable. */
  readonly name: string;
  /** A bounded 48x48 PNG data URL, or null for the generic application fallback. */
  readonly iconDataUrl: string | null;
}

export interface ComputerHistoryDetail {
  readonly entry: ComputerHistoryTimelineEntry;
  /** Summary-only document. Untrusted Markdown requires safe rendering, not HTML execution. */
  readonly document?: {
    /** Canonical summary filename, never a filesystem path. */
    readonly name: string;
    /** Persisted serialization including JSON frontmatter and body, at most 128 KiB. */
    readonly markdown: string;
    /** Validated model-authored Markdown body, unescaped and at most 48 KiB. */
    readonly body: string;
  };
  /** At most 100 matching retained events, sampled evidence first; metadata only, never model-input UI text. */
  readonly events: readonly ComputerHistoryEventEvidence[];
  /** Matching raw events within the entry interval and 48-hour horizon, before the response cap. */
  readonly eventTotal: number;
  readonly truncated: boolean;
  /** False when no matching raw evidence remains, including after expiry. */
  readonly rawAvailable: boolean;
}

export type ComputerHistorySummaryLevel = '10min' | '6h';

export interface ComputerHistorySuggestion {
  readonly type: 'skill' | 'automation';
  readonly name: string;
  readonly description: string;
}

/** Bounded evidence, optionally including independently authorized eligible UI text, crosses the model authority boundary. */
export interface ComputerHistorySummaryInput {
  readonly level: ComputerHistorySummaryLevel;
  /** Trusted application-selected output language. Older callers may omit it. */
  readonly locale?: UiLocale;
  readonly start: string;
  readonly end: string;
  readonly evidence: readonly { readonly id: string; readonly text: string }[];
  /** At most three earlier summaries, untrusted context rather than evidence of current actions. */
  readonly priorContext?: readonly { readonly id: string; readonly text: string }[];
}

export interface ComputerHistorySummaryContent {
  readonly title: string;
  readonly description: string;
  readonly body: string;
  /** Optional for legacy summaries; empty when evidence is sparse. At most 10 trimmed NFKC strings of 96 UTF-8 bytes each, deduplicated case-insensitively while preserving the first spelling. */
  readonly keywords?: readonly string[];
  readonly suggestion?: ComputerHistorySuggestion;
}

export interface ComputerHistoryTimeline {
  readonly status: ComputerHistoryStatus;
  readonly entries: readonly ComputerHistoryTimelineEntry[];
}

export type ComputerHistoryClearScope = 'last_10_minutes' | 'last_hour' | 'today' | 'all';

export const COMPUTER_HISTORY_SEARCH_QUERY_MAX_CHARS = 512;
export const COMPUTER_HISTORY_SEARCH_TERMS_MAX_ITEMS = 16;
export const COMPUTER_HISTORY_SEARCH_TERM_MAX_CHARS = 128;
export const COMPUTER_HISTORY_SEARCH_EXCERPT_MAX_CHARS = 2048;

/** Shared substring matching form for summary bodies, metadata and renderer-resolved app names. */
export function computerHistorySearchNormalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().normalize('NFKC');
}

/** Throws for invalid queries instead of silently dropping terms; limits use UTF-16 string length. */
export function computerHistorySearchTerms(query: string): readonly string[] {
  if (typeof query !== 'string' || query.length > COMPUTER_HISTORY_SEARCH_QUERY_MAX_CHARS) {
    throw new Error('Invalid Computer History search query');
  }
  const normalized = computerHistorySearchNormalize(query);
  const terms = [...new Set(normalized.split(/\s+/u).filter(Boolean))];
  if (
    normalized.length > COMPUTER_HISTORY_SEARCH_QUERY_MAX_CHARS ||
    terms.length > COMPUTER_HISTORY_SEARCH_TERMS_MAX_ITEMS ||
    terms.some((term) => term.length > COMPUTER_HISTORY_SEARCH_TERM_MAX_CHARS)
  ) {
    throw new Error('Invalid Computer History search query');
  }
  return terms;
}

/**
 * Searches the complete validated body and returns normalized excerpts for every matching term.
 * Terms absent from the body may match renderer metadata. Newline separators cannot create a
 * cross-excerpt token hit. Query length plus 80 context characters per term stays below 2048.
 */
export function computerHistorySearchExcerpt(body: string, query: string): string {
  const terms = computerHistorySearchTerms(query);
  if (!terms.length) return '';
  const text = computerHistorySearchNormalize(body);
  const ranges = terms
    .flatMap((term) => {
      const match = text.indexOf(term);
      if (match < 0) return [];
      let start = Math.max(0, match - 40);
      let end = Math.min(text.length, match + term.length + 40);
      if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start--;
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end++;
      return [{ start, end }];
    })
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged.map(({ start, end }) => text.slice(start, end)).join('\n');
}
