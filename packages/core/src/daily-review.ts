/**
 * PR-DAILY-REVIEW-MVP-0 — local-only daily summary contract.
 *
 * Aggregates one day's activity (sessions touched, requests, tokens,
 * cost, top tools, top models) into a single value object that the
 * main process can return over IPC and the renderer can drop straight
 * into a panel. Pure types + helpers only; the actual data comes from
 * the existing telemetry repo + session store (no new persistence).
 *
 * borrow
 * - External reference describes a similar daily aggregation surface
 *   ("today" digest), but our scope is intentionally smaller: read-only
 *   summary, no scheduling, no cloud sync, no missions/cron, no
 *   LLM-generated narrative yet.
 *
 * diverge
 * - No background daemon — the summary is computed on demand when the
 *   user opens the panel, not pushed via cron.
 * - No automatic memory promotion of "what I worked on" — that would
 *   need explicit user opt-in under the daily-review privacy
 *   defaults.
 *
 * risk
 * - Only reads telemetry + session metadata; both already live on
 *   disk. No new file/network IO surface.
 *
 * gate
 * - Pure unit tests cover the day-boundary helpers (UTC vs local TZ
 *   was deliberately resolved in favour of LOCAL TZ — the user thinks
 *   in their own day, not UTC).
 * - Aggregator is pure: take inputs, return DailyReviewSummary.
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

/**
 * PR-DAILY-REVIEW-FULL-0 — config + archive contract.
 *
 * One range contract shared by core, main, preload, and renderer. Archives
 * remain local JSON files; manual and scheduled runs use the same pipeline.
 */

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

type LegacyDailyReviewArchive = Omit<DailyReviewArchive, 'range'> & {
  readonly mode: 'daily' | 'deep';
};

/** Maps the retired daily/deep read format onto the one range contract. */
export function normalizeDailyReviewArchive(
  archive: DailyReviewArchive | LegacyDailyReviewArchive,
): DailyReviewArchive {
  if ('range' in archive) {
    if (!DAILY_REVIEW_RANGES.includes(archive.range)) {
      throw new Error(`Invalid Daily Review range: ${String(archive.range)}`);
    }
    return archive;
  }
  return {
    id: archive.id,
    day: archive.day,
    range: archive.mode === 'deep' ? 7 : 1,
    status: archive.status,
    generatedAt: archive.generatedAt,
    trigger: archive.trigger,
    modelKey: archive.modelKey,
    sections: archive.sections,
    totals: archive.totals,
    errorMessage: archive.errorMessage,
  };
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
    errorMessage: archive.errorMessage,
  };
}
