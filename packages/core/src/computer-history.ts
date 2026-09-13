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
  /** Bounded model-written observation data, never instructions or verified facts. */
  readonly summaryText?: string;
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
  /** At most two earlier summaries, untrusted context rather than evidence of current actions. */
  readonly priorContext?: readonly { readonly id: string; readonly text: string }[];
}

export interface ComputerHistorySummaryContent {
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly suggestion?: ComputerHistorySuggestion;
}

export interface ComputerHistoryTimeline {
  readonly status: ComputerHistoryStatus;
  readonly entries: readonly ComputerHistoryTimelineEntry[];
}

export type ComputerHistoryClearScope = 'last_10_minutes' | 'last_hour' | 'today' | 'all';
