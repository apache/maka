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
 * PR-RELATIVE-TIME-0: a single, locale-aware relative-time formatter
 * shared by every Maka surface. The existing `formatRelativeTimestamp`
 * sat inside `packages/ui/src/components.tsx` as a private helper,
 * which meant it could not be unit-tested and could not be reused by
 * sidebar / settings panels.
 *
 * The formatter is pure (takes an optional `now` so tests do not have
 * to monkey-patch `Date.now`). Buckets are intentionally narrow at the
 * short end (second / minute / hour) so users see "刚刚" become
 * "1 分钟前" promptly, then widen to days. Anything older than ~7 days
 * falls back to an absolute date so we do not produce misleadingly
 * round numbers like "5 个月前".
 *
 * The threshold is a deliberate divergence from the previous
 * implementation, which used `.format(-Math.round(diffHours / 24), 'day')`
 * for ALL timestamps older than a day and produced things like
 * "300 天前" for messages a year old. That was strictly less useful than
 * the locale date string.
 */

import { uiLocaleToIntlLocale, type UiLocale } from './ui-locale.js';

/** Maximum age (ms) that still gets a relative bucket. Older → absolute. */
const RELATIVE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

let cachedRelativeFormat: Intl.RelativeTimeFormat | null = null;
let cachedAbsoluteFormat: Intl.DateTimeFormat | null = null;
let cachedLocale: string | null = null;

function getRelativeFormat(uiLocale: UiLocale): Intl.RelativeTimeFormat {
  const locale = uiLocaleToIntlLocale(uiLocale);
  if (!cachedRelativeFormat || cachedLocale !== locale) {
    cachedRelativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    cachedAbsoluteFormat = null;
    cachedLocale = locale;
  }
  return cachedRelativeFormat;
}

function getAbsoluteFormat(uiLocale: UiLocale): Intl.DateTimeFormat {
  const locale = uiLocaleToIntlLocale(uiLocale);
  if (!cachedAbsoluteFormat || cachedLocale !== locale) {
    cachedAbsoluteFormat = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    cachedRelativeFormat = null;
    cachedLocale = locale;
  }
  return cachedAbsoluteFormat;
}

/**
 * Returns a localized relative label for `ts` (e.g. "1 分钟前", "1 hour ago")
 * when within `RELATIVE_HORIZON_MS`, otherwise the absolute date string.
 *
 * `now` is injectable so tests can pin a deterministic clock. Future
 * timestamps (`ts > now`) are clamped to the smallest "刚刚" bucket — we
 * don't want sidebar rows showing "in 2 minutes" when a tab's clock
 * drifts.
 */
export function formatRelativeTimestamp(
  ts: number,
  now: number = Date.now(),
  locale: UiLocale = 'zh',
): string {
  const diffMs = now - ts;
  if (diffMs < 0) {
    // Clock skew or future-dated record. Snap to "刚刚".
    return getRelativeFormat(locale).format(-1, 'second');
  }
  if (diffMs > RELATIVE_HORIZON_MS) {
    return getAbsoluteFormat(locale).format(new Date(ts));
  }
  const diffSeconds = Math.round(diffMs / 1000);
  if (diffSeconds < 60) {
    // Clamp to >=1 so we never produce "0 seconds ago".
    return getRelativeFormat(locale).format(-Math.max(1, diffSeconds), 'second');
  }
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
 * Compact variant for space-starved rows (sidebar session list): same
 * relative buckets inside the 7-day horizon, then a DATE-ONLY label —
 * "6月20日" within the current year, "2025年6月20日" across years.
 * `formatRelativeTimestamp`'s medium-date + time fallback
 * ("2026年6月20日 16:33") is right for wide surfaces but crushed the
 * session title next to it to ~2 characters. Minute precision belongs
 * in tooltips/detail surfaces, not scan-level list rows.
 */
export function formatCompactTimestamp(
  ts: number,
  now: number = Date.now(),
  locale: UiLocale = 'zh',
): string {
  const diffMs = now - ts;
  if (diffMs >= 0 && diffMs <= RELATIVE_HORIZON_MS) {
    return formatRelativeTimestamp(ts, now, locale);
  }
  if (diffMs < 0) return formatRelativeTimestamp(ts, now, locale);
  const { sameYear, otherYear } = getCompactFormats(locale);
  const date = new Date(ts);
  const nowDate = new Date(now);
  return date.getFullYear() === nowDate.getFullYear()
    ? sameYear.format(date)
    : otherYear.format(date);
}

/**
 * Reset cached formatters for deterministic tests. Runtime calls select the
 * cache with an explicit locale, so switching locale does not need a reset.
 */
export function resetRelativeTimeFormatters(): void {
  cachedRelativeFormat = null;
  cachedAbsoluteFormat = null;
  cachedLocale = null;
  cachedCompactSameYearFormat = null;
  cachedCompactOtherYearFormat = null;
  cachedCompactLocale = null;
}

/**
 * Picks the next refresh delay (ms) for a relative timestamp. Used by
 * the React `<RelativeTime>` ticker so we re-render at the right
 * cadence: every second for sub-minute, every minute for sub-hour,
 * every 10 minutes after that. Past the horizon we never re-render.
 */
export function nextRelativeRefreshDelay(ts: number, now: number = Date.now()): number | null {
  const diffMs = now - ts;
  if (diffMs > RELATIVE_HORIZON_MS) return null;
  if (diffMs < 60_000) return 1_000;
  if (diffMs < 60 * 60_000) return 60_000;
  return 10 * 60_000;
}
