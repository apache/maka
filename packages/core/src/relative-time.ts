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
 * Locale-aware relative-time formatter shared across Maka surfaces. Pure
 * (optional `now`) so tests can pin a clock. The first minute stays on one
 * just-now label instead of counting seconds, then buckets widen from minute
 * to hour to day; past ~7 days we fall back to an absolute date, which is more
 * useful than a relative label like "300 天前".
 */

import { uiLocaleToIntlLocale, type UiCatalog, type UiLocale } from './ui-locale.js';

/** Maximum age (ms) that still gets a relative bucket. Older → absolute. */
const RELATIVE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** Age below this stays on one just-now label instead of counting seconds. */
const JUST_NOW_MS = 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 12 * MONTH_MS;
/** Stays below the browser timer ceiling while avoiding needless daily wakes. */
const MAX_SIDEBAR_REFRESH_MS = 24 * DAY_MS;
const SIDEBAR_TIME_BUCKETS = [
  { unitMs: MINUTE_MS, maxValue: 60, suffix: 'min' },
  { unitMs: HOUR_MS, maxValue: 24, suffix: 'h' },
  { unitMs: DAY_MS, maxValue: 30, suffix: 'd' },
  { unitMs: MONTH_MS, maxValue: 12, suffix: 'mo' },
  { unitMs: YEAR_MS, maxValue: Number.POSITIVE_INFINITY, suffix: 'y' },
] as const;

const JUST_NOW: UiCatalog<string> = {
  'zh-CN': '刚刚',
  'zh-TW': '剛剛',
  en: 'just now',
};

/** Future timestamps are treated as age zero and therefore display as just now. */
function relativeAgeMs(ts: number, now: number): number {
  return Math.max(0, now - ts);
}

// One cache per formatter. They used to share `cachedLocale` and clear each
// other on a miss, so alternating relative and absolute reads — which is what
// the sidebar does, once per row — rebuilt an `Intl` formatter every call.
let cachedRelativeFormat: { locale: string; format: Intl.RelativeTimeFormat } | null = null;
let cachedAbsoluteFormat: { locale: string; format: Intl.DateTimeFormat } | null = null;

function getRelativeFormat(uiLocale: UiLocale): Intl.RelativeTimeFormat {
  const locale = uiLocaleToIntlLocale(uiLocale);
  if (cachedRelativeFormat?.locale !== locale) {
    cachedRelativeFormat = {
      locale,
      format: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
    };
  }
  return cachedRelativeFormat.format;
}

function getAbsoluteFormat(uiLocale: UiLocale): Intl.DateTimeFormat {
  const locale = uiLocaleToIntlLocale(uiLocale);
  if (cachedAbsoluteFormat?.locale !== locale) {
    cachedAbsoluteFormat = {
      locale,
      format: new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    };
  }
  return cachedAbsoluteFormat.format;
}

/**
 * Date and time for `ts`, spelled out. The single authority for the absolute
 * reading a relative label falls back to and a tooltip shows; `@maka/ui` had
 * its own uncached copy of the same `Intl` options until this became public.
 */
export function formatAbsoluteTimestamp(ts: number, locale: UiLocale): string {
  return getAbsoluteFormat(locale).format(new Date(ts));
}

/**
 * Localized relative label for `ts` within the 7-day horizon, otherwise the
 * absolute date string. `now` is injectable so tests pin a deterministic clock;
 * future timestamps (clock skew) snap to the just-now label.
 */
export function formatRelativeTimestamp(ts: number, now: number, locale: UiLocale): string {
  const diffMs = relativeAgeMs(ts, now);
  if (diffMs < JUST_NOW_MS) {
    return JUST_NOW[locale];
  }
  if (diffMs > RELATIVE_HORIZON_MS) {
    return getAbsoluteFormat(locale).format(new Date(ts));
  }
  const diffSeconds = Math.round(diffMs / 1000);
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return getRelativeFormat(locale).format(-diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return getRelativeFormat(locale).format(-diffHours, 'hour');
  const diffDays = Math.round(diffHours / 24);
  return getRelativeFormat(locale).format(-diffDays, 'day');
}

let cachedCompactSameYearFormat: Intl.DateTimeFormat | null = null;
let cachedCompactOtherYearFormat: Intl.DateTimeFormat | null = null;
let cachedCompactLocale: string | null = null;

function getCompactFormats(uiLocale: UiLocale): {
  sameYear: Intl.DateTimeFormat;
  otherYear: Intl.DateTimeFormat;
} {
  const locale = uiLocaleToIntlLocale(uiLocale);
  if (
    !cachedCompactSameYearFormat ||
    !cachedCompactOtherYearFormat ||
    cachedCompactLocale !== locale
  ) {
    cachedCompactSameYearFormat = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
    });
    cachedCompactOtherYearFormat = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    cachedCompactLocale = locale;
  }
  return { sameYear: cachedCompactSameYearFormat, otherYear: cachedCompactOtherYearFormat };
}

/**
 * Compact variant for wider list rows: relative inside the seven-day horizon,
 * then a localized date-only label.
 */
export function formatCompactTimestamp(ts: number, now: number, locale: UiLocale): string {
  const diffMs = relativeAgeMs(ts, now);
  if (diffMs <= RELATIVE_HORIZON_MS) return formatRelativeTimestamp(ts, now, locale);
  const { sameYear, otherYear } = getCompactFormats(locale);
  const date = new Date(ts);
  const nowDate = new Date(now);
  return date.getFullYear() === nowDate.getFullYear()
    ? sameYear.format(date)
    : otherYear.format(date);
}

/**
 * Scan-friendly relative label for space-starved rows (sidebar session list).
 * Unit tokens stay deliberately locale-neutral so the trailing column remains
 * stable across UI languages: "46min", "13h", "17d", "1mo", "1y".
 */
export function formatSidebarTimestamp(ts: number, now: number, locale: UiLocale): string {
  const diffMs = relativeAgeMs(ts, now);
  if (diffMs < JUST_NOW_MS) return JUST_NOW[locale];
  const bucket = sidebarTimeBucket(diffMs);
  return `${bucket.value}${bucket.suffix}`;
}

/**
 * Reset cached formatters for deterministic tests. Runtime calls select the
 * cache with an explicit locale, so switching locale does not need a reset.
 */
export function resetRelativeTimeFormatters(): void {
  cachedRelativeFormat = null;
  cachedAbsoluteFormat = null;
  cachedCompactSameYearFormat = null;
  cachedCompactOtherYearFormat = null;
  cachedCompactLocale = null;
}

/**
 * Next tick delay (ms) for the `<RelativeTime>` ticker: once when the just-now
 * window ends, every minute for the first hour, then every 10 minutes; null
 * past the horizon (never re-render).
 */
export function nextRelativeRefreshDelay(ts: number, now: number = Date.now()): number | null {
  const ageMs = relativeAgeMs(ts, now);
  if (ageMs > RELATIVE_HORIZON_MS) return null;
  if (ageMs < JUST_NOW_MS) return JUST_NOW_MS - ageMs;
  if (ageMs < 60 * 60_000) return 60_000;
  return 10 * 60_000;
}

function nextRoundedBoundaryDelay(ageMs: number, unitMs: number, value: number): number {
  return Math.max(1, Math.ceil((value + 0.5) * unitMs - ageMs));
}

function sidebarTimeBucket(ageMs: number): {
  value: number;
  unitMs: number;
  suffix: (typeof SIDEBAR_TIME_BUCKETS)[number]['suffix'];
} {
  for (const bucket of SIDEBAR_TIME_BUCKETS) {
    const value = Math.round(ageMs / bucket.unitMs);
    if (value < bucket.maxValue) return { value, unitMs: bucket.unitMs, suffix: bucket.suffix };
  }
  throw new Error('Sidebar time buckets must end with an unbounded bucket');
}

/** Refreshes at the next visible sidebar bucket, capped below the timer ceiling. */
export function nextSidebarRefreshDelay(ts: number, now: number = Date.now()): number | null {
  const ageMs = relativeAgeMs(ts, now);
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs < JUST_NOW_MS) return JUST_NOW_MS - ageMs;
  const bucket = sidebarTimeBucket(ageMs);
  return Math.min(
    nextRoundedBoundaryDelay(ageMs, bucket.unitMs, bucket.value),
    MAX_SIDEBAR_REFRESH_MS,
  );
}
