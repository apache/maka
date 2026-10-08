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
 * Locale-aware relative-time formatter shared across Maka surfaces. The
 * public formatting functions are pure for a supplied clock; formatter caches
 * are an internal performance detail and never affect the result.
 */

import { uiLocaleToIntlLocale, type UiLocale } from './ui-locale.js';
import {
  JUST_NOW,
  JUST_NOW_MS,
  RELATIVE_HORIZON_MS,
  relativeAgeMs,
  nextRelativeRefreshDelay as nextRelativeRefreshDelayPolicy,
  nextSidebarRefreshDelay as nextSidebarRefreshDelayPolicy,
  sidebarTimeBucket,
} from './relative-time-policy.js';

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
  if (diffMs < JUST_NOW_MS) return JUST_NOW[locale];
  if (diffMs > RELATIVE_HORIZON_MS) return formatAbsoluteTimestamp(ts, locale);
  const bucket = relativeBucket(diffMs);
  return getRelativeFormat(locale).format(-bucket.value, bucket.unit);
}

function relativeBucket(diffMs: number): {
  readonly value: number;
  readonly unit: Intl.RelativeTimeFormatUnit;
} {
  const minutes = Math.round(Math.round(diffMs / 1000) / 60);
  if (minutes < 60) return { value: minutes, unit: 'minute' };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { value: hours, unit: 'hour' };
  return { value: Math.round(hours / 24), unit: 'day' };
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
  if (diffMs <= RELATIVE_HORIZON_MS) {
    return formatRelativeTimestamp(ts, now, locale);
  }
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
  return nextRelativeRefreshDelayPolicy(ts, now);
}

export function nextSidebarRefreshDelay(ts: number, now: number = Date.now()): number | null {
  return nextSidebarRefreshDelayPolicy(ts, now);
}
