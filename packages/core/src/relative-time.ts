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

const JUST_NOW: UiCatalog<string> = {
  zh: '刚刚',
  en: 'just now',
};

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
 * Localized relative label for `ts` within the 7-day horizon, otherwise the
 * absolute date string. `now` is injectable so tests pin a deterministic clock;
 * future timestamps (clock skew) snap to the just-now label.
 */
export function formatRelativeTimestamp(
  ts: number,
  now: number = Date.now(),
  locale: UiLocale = 'zh',
): string {
  const diffMs = now - ts;
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
 * Compact variant for space-starved rows (sidebar session list): same relative
 * buckets inside the horizon, then a date-only label ("6月20日" within the
 * current year, "2025年6月20日" across years) instead of the wide
 * medium-date-plus-time fallback.
 */
export function formatCompactTimestamp(
  ts: number,
  now: number = Date.now(),
  locale: UiLocale = 'zh',
): string {
  const diffMs = now - ts;
  if (diffMs <= RELATIVE_HORIZON_MS) return formatRelativeTimestamp(ts, now, locale);
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
 * Next tick delay (ms) for the `<RelativeTime>` ticker: once when the just-now
 * window ends, every minute for the first hour, then every 10 minutes; null
 * past the horizon (never re-render).
 */
export function nextRelativeRefreshDelay(ts: number, now: number = Date.now()): number | null {
  const diffMs = now - ts;
  if (diffMs > RELATIVE_HORIZON_MS) return null;
  if (diffMs < JUST_NOW_MS) return JUST_NOW_MS - diffMs;
  if (diffMs < 60 * 60_000) return 60_000;
  return 10 * 60_000;
}
