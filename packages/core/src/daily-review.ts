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

/**
 * Daily Review domain values and pure projection helpers.
 *
 * A review summarizes local Session and usage facts over local-time day
 * boundaries. Runtime ownership, persistence, scheduling, and model execution
 * stay outside this module so every Client observes the same domain contract.
 */

import type { UsageBucket, UsageQuery, UsageSummaryV2 } from './usage-stats/types.js';
import type { SessionSummary } from './session.js';

/** Inclusive `from` and exclusive `to` millisecond bounds for one day. */
export interface DayRangeMs {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * One row in the "today's active sessions" list. Subset of
 * `SessionSummary` so the renderer doesn't have to know about flags /
 * labels it won't show.
 */
export interface DailyReviewSessionRow {
  readonly id: string;
  readonly name: string;
  readonly lastMessageAt: number;
  readonly lastMessagePreview?: string;
}

export interface DailyReviewTopEntry {
  readonly key: string;
  readonly label: string;
  readonly requests: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface DailyReviewTotals {
  readonly sessionCount: number;
  readonly requestCount: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly errorCount: number;
}

export interface DailyReviewSummary {
  readonly day: DayRangeMs;
  readonly totals: DailyReviewTotals;
  readonly sessions: ReadonlyArray<DailyReviewSessionRow>;
  readonly topTools: ReadonlyArray<DailyReviewTopEntry>;
  readonly topModels: ReadonlyArray<DailyReviewTopEntry>;
}

/**
 * Returns the local-TZ day boundary that contains `nowMs`. We use the
 * user's local timezone because the user thinks in their own day, not
 * UTC — a session at 23:30 is "today" for them, not yesterday.
 */
export function localDayBoundsForInstant(nowMs: number): DayRangeMs {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const fromMs = d.getTime();
  const next = new Date(fromMs);
  next.setDate(next.getDate() + 1);
  return { fromMs, toMs: next.getTime() };
}

/**
 * Returns the local-TZ day boundary for a date offset by `offsetDays`
 * from `nowMs` (0 = today, -1 = yesterday, +1 = tomorrow). Always
 * snaps to the resulting day's local midnight; safe across DST.
 */
export function localDayBoundsAt(nowMs: number, offsetDays: number): DayRangeMs {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  const fromMs = d.getTime();
  const next = new Date(fromMs);
  next.setDate(next.getDate() + 1);
  return { fromMs, toMs: next.getTime() };
}

/**
 * Filters `sessions` to those with a `lastMessageAt` inside the day
 * window, then truncates to the most-recent `limit`. Returns a
 * lightweight row shape (drop the labels / flags / status fields).
 */
export function pickDailyReviewSessions(
  sessions: ReadonlyArray<SessionSummary>,
  day: DayRangeMs,
  limit: number,
): DailyReviewSessionRow[] {
  const matching: DailyReviewSessionRow[] = [];
  for (const session of sessions) {
    const ts = session.lastMessageAt;
    if (ts === undefined) continue;
    if (ts < day.fromMs || ts >= day.toMs) continue;
    matching.push({
      id: session.id,
      name: session.name,
      lastMessageAt: ts,
      lastMessagePreview: session.lastMessagePreview,
    });
  }
  // Most recent first; the panel ordering should match what the
  // sidebar shows in the "today" group.
  matching.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return matching.slice(0, Math.max(0, limit));
}

/**
 * Reduces a `UsageBucket[]` (already grouped by tool or model in the
 * telemetry repo) into the renderer-friendly `DailyReviewTopEntry[]`
 * sorted by request count, then capped at `limit`.
 */
export function pickDailyReviewTopEntries(
  buckets: ReadonlyArray<UsageBucket>,
  limit: number,
): DailyReviewTopEntry[] {
  const rows = buckets.map(
    (b): DailyReviewTopEntry => ({
      key: b.key,
      label: b.label,
      requests: b.requests,
      totalTokens: b.totalTokens,
      costUsd: b.costUsd,
    }),
  );
  rows.sort((a, b) => b.requests - a.requests);
  return rows.slice(0, Math.max(0, limit));
}

/** Pure assembler — the IPC handler in main calls this. */
export function buildDailyReviewSummary(input: {
  day: DayRangeMs;
  usageSummary: UsageSummaryV2;
  sessions: ReadonlyArray<DailyReviewSessionRow>;
  topTools: ReadonlyArray<DailyReviewTopEntry>;
  topModels: ReadonlyArray<DailyReviewTopEntry>;
}): DailyReviewSummary {
  return {
    day: input.day,
    totals: {
      sessionCount: input.sessions.length,
      requestCount: input.usageSummary.totalRequests,
      totalTokens: input.usageSummary.totalTokens.total,
      costUsd: input.usageSummary.totalCostUsd,
      errorCount: input.usageSummary.errorRequests,
    },
    sessions: input.sessions,
    topTools: input.topTools,
    topModels: input.topModels,
  };
}

/** Builds the canonical telemetry query for one day window. */
export function dailyUsageQuery(day: DayRangeMs): UsageQuery {
  return { range: { from: day.fromMs, to: day.toMs } };
}

/** Default cap for activity sessions and generated report evidence. */
export const DAILY_REVIEW_LIST_LIMIT = 8;

/** Config and durable archive contract shared by Host and Client adapters. */

export type DailyReviewRange = 1 | 7 | 30;

export const DAILY_REVIEW_RANGES: readonly DailyReviewRange[] = [1, 7, 30] as const;

export type DailyReviewSectionKey = 'summary' | 'gaps' | 'usage' | 'code';

export const DAILY_REVIEW_SECTION_KEYS: readonly DailyReviewSectionKey[] = [
  'summary',
  'gaps',
  'usage',
  'code',
] as const;

export interface DailyReviewConfig {
  readonly enabled: boolean;
  /** Local-TZ HH:mm string, e.g. "08:00". */
  readonly executeTime: string;
  /**
   * Composite model key (e.g. `connectionSlug::modelId`). Empty string
   * means "use the chat default model". The pipeline treats empty as
   * "no explicit model selected".
   */
  readonly modelKey: string;
}

export type DailyReviewArchiveStatus = 'ok' | 'no_model' | 'no_data' | 'failed' | 'skipped';

export const DAILY_REVIEW_ARCHIVE_STATUSES: readonly DailyReviewArchiveStatus[] = [
  'ok',
  'no_model',
  'no_data',
  'failed',
  'skipped',
] as const;

export type DailyReviewTrigger = 'cron' | 'manual';

export interface DailyReviewArchiveSectionContent {
  readonly summary?: string;
  readonly gaps?: string;
  readonly usage?: string;
  readonly code?: string;
}

export interface DailyReviewArchive {
  /** Stable id: `YYYY-MM-DD-{range}d`. Re-runs for the same range overwrite. */
  readonly id: string;
  readonly day: DayRangeMs;
  readonly range: DailyReviewRange;
  readonly status: DailyReviewArchiveStatus;
  readonly generatedAt: number;
  readonly trigger: DailyReviewTrigger;
  readonly modelKey: string;
  readonly sections: DailyReviewArchiveSectionContent;
  readonly totals: DailyReviewTotals;
  readonly errorMessage?: string;
}

/** Lightweight row for the history list — drops the section bodies. */
export interface DailyReviewArchiveSummary {
  readonly id: string;
  readonly day: DayRangeMs;
  readonly range: DailyReviewRange;
  readonly status: DailyReviewArchiveStatus;
  readonly generatedAt: number;
  readonly trigger: DailyReviewTrigger;
  readonly modelKey: string;
  readonly totals: DailyReviewTotals;
  readonly errorMessage?: string;
}

export const DEFAULT_DAILY_REVIEW_CONFIG: DailyReviewConfig = {
  enabled: false,
  executeTime: '08:00',
  modelKey: '',
};

const EXECUTE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns true if the string parses as a local HH:mm time. */
export function isDailyReviewExecuteTime(value: unknown): value is string {
  return typeof value === 'string' && EXECUTE_TIME_RE.test(value);
}

/** Coerces an arbitrary partial config to a fully-valid `DailyReviewConfig`. */
export function normalizeDailyReviewConfig(
  input:
    | (Partial<DailyReviewConfig> & {
        readonly sections?: unknown;
        readonly deepEnabled?: unknown;
        readonly includeClaudeCode?: unknown;
        readonly externalNotify?: unknown;
      })
    | null
    | undefined,
): DailyReviewConfig {
  const base = DEFAULT_DAILY_REVIEW_CONFIG;
  if (!input) return base;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    executeTime: isDailyReviewExecuteTime(input.executeTime) ? input.executeTime : base.executeTime,
    modelKey: typeof input.modelKey === 'string' ? input.modelKey : base.modelKey,
  };
}

/** Builds the canonical archive id for a given range. */
export function dailyReviewArchiveId(day: DayRangeMs, range: DailyReviewRange): string {
  const d = new Date(day.fromMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${range}d`;
}

export interface ParsedDailyReviewArchiveId {
  readonly localDate: string;
  readonly range: DailyReviewRange;
}

/** Parses the durable local-date label without reinterpreting it in the current timezone. */
export function parseDailyReviewArchiveId(value: unknown): ParsedDailyReviewArchiveId | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})-(1|7|30)d$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    localDate: `${match[1]}-${match[2]}-${match[3]}`,
    range: Number(match[4]) as DailyReviewRange,
  };
}

/** Maps the retired daily/deep read format onto the one range contract. */
export function normalizeDailyReviewArchive(input: unknown): DailyReviewArchive {
  if (!isRecord(input)) throw invalidDailyReviewArchive('record');
  let range: DailyReviewRange;
  let expectedIdSuffix: string;
  if ('range' in input) {
    if (!DAILY_REVIEW_RANGES.includes(input.range as DailyReviewRange)) {
      throw invalidDailyReviewArchive('range');
    }
    range = input.range as DailyReviewRange;
    expectedIdSuffix = `${range}d`;
  } else if (input.mode === 'daily' || input.mode === 'deep') {
    range = input.mode === 'deep' ? 7 : 1;
    expectedIdSuffix = input.mode;
  } else {
    throw invalidDailyReviewArchive('range');
  }

  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw invalidDailyReviewArchive('id');
  }
  if (
    !isRecord(input.day) ||
    !isFiniteNumber(input.day.fromMs) ||
    !isFiniteNumber(input.day.toMs) ||
    input.day.toMs <= input.day.fromMs
  ) {
    throw invalidDailyReviewArchive('day');
  }
  const day = { fromMs: input.day.fromMs, toMs: input.day.toMs };
  const canonicalId = parseDailyReviewArchiveId(input.id);
  if (
    'range' in input
      ? !canonicalId || canonicalId.range !== range
      : !hasValidLegacyDailyReviewArchiveId(input.id, expectedIdSuffix)
  ) {
    throw invalidDailyReviewArchive('id');
  }
  if (!DAILY_REVIEW_ARCHIVE_STATUSES.includes(input.status as DailyReviewArchiveStatus)) {
    throw invalidDailyReviewArchive('status');
  }
  const status = input.status as DailyReviewArchiveStatus;
  if (!isFiniteNumber(input.generatedAt)) throw invalidDailyReviewArchive('generatedAt');
  if (input.trigger !== 'cron' && input.trigger !== 'manual') {
    throw invalidDailyReviewArchive('trigger');
  }
  if (typeof input.modelKey !== 'string') throw invalidDailyReviewArchive('modelKey');
  const sections = normalizeDailyReviewArchiveSections(input.sections);
  if (status === 'ok' && !Object.values(sections).some((content) => content.trim().length > 0)) {
    throw invalidDailyReviewArchive('sections');
  }
  const totals = normalizeDailyReviewArchiveTotals(input.totals);
  if (input.errorMessage !== undefined && typeof input.errorMessage !== 'string') {
    throw invalidDailyReviewArchive('errorMessage');
  }

  return {
    id: input.id,
    day,
    range,
    status,
    generatedAt: input.generatedAt,
    trigger: input.trigger,
    modelKey: input.modelKey,
    sections,
    totals,
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
  };
}

function normalizeDailyReviewArchiveSections(input: unknown): DailyReviewArchiveSectionContent {
  if (!isRecord(input)) throw invalidDailyReviewArchive('sections');
  const sections: Record<string, string> = {};
  for (const key of DAILY_REVIEW_SECTION_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw invalidDailyReviewArchive(`sections.${key}`);
    sections[key] = value;
  }
  return sections;
}

function normalizeDailyReviewArchiveTotals(input: unknown): DailyReviewTotals {
  if (!isRecord(input)) throw invalidDailyReviewArchive('totals');
  for (const key of ['sessionCount', 'requestCount', 'totalTokens', 'errorCount'] as const) {
    if (!isNonNegativeInteger(input[key])) throw invalidDailyReviewArchive(`totals.${key}`);
  }
  if (!isFiniteNumber(input.costUsd) || input.costUsd < 0) {
    throw invalidDailyReviewArchive('totals.costUsd');
  }
  return {
    sessionCount: input.sessionCount as number,
    requestCount: input.requestCount as number,
    totalTokens: input.totalTokens as number,
    costUsd: input.costUsd,
    errorCount: input.errorCount as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function hasValidLegacyDailyReviewArchiveId(id: string, suffix: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(daily|deep)$/.exec(id);
  if (!match || match[4] !== suffix) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function invalidDailyReviewArchive(field: string): Error {
  return new Error(`Invalid Daily Review archive ${field}`);
}

/** Strips the section bodies down to a lightweight history-list row. */
export function dailyReviewArchiveToSummary(
  archive: DailyReviewArchive,
): DailyReviewArchiveSummary {
  return {
    id: archive.id,
    day: archive.day,
    range: archive.range,
    status: archive.status,
    generatedAt: archive.generatedAt,
    trigger: archive.trigger,
    modelKey: archive.modelKey,
    totals: archive.totals,
    ...(archive.errorMessage === undefined ? {} : { errorMessage: archive.errorMessage }),
  };
}
