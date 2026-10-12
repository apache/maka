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

import type { UiCatalog } from './ui-locale.js';

export const RELATIVE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
export const JUST_NOW_MS = 60_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const MONTH_MS = 30 * DAY_MS;
export const YEAR_MS = 12 * MONTH_MS;
const MAX_SIDEBAR_REFRESH_MS = 24 * DAY_MS;

export const JUST_NOW: UiCatalog<string> = {
  'zh-CN': '刚刚',
  'zh-TW': '剛剛',
  en: 'just now',
};

const SIDEBAR_TIME_BUCKETS = [
  { unitMs: MINUTE_MS, maxValue: 60, suffix: 'min' },
  { unitMs: HOUR_MS, maxValue: 24, suffix: 'h' },
  { unitMs: DAY_MS, maxValue: 30, suffix: 'd' },
  { unitMs: MONTH_MS, maxValue: 12, suffix: 'mo' },
  { unitMs: YEAR_MS, maxValue: Number.POSITIVE_INFINITY, suffix: 'y' },
] as const;

export function relativeAgeMs(timestamp: number, now: number): number {
  return Math.max(0, now - timestamp);
}

export type SidebarTimeBucket = {
  value: number;
  unitMs: number;
  suffix: (typeof SIDEBAR_TIME_BUCKETS)[number]['suffix'];
};

export function sidebarTimeBucket(ageMs: number): SidebarTimeBucket {
  for (const bucket of SIDEBAR_TIME_BUCKETS) {
    const value = Math.round(ageMs / bucket.unitMs);
    if (value < bucket.maxValue) return { value, unitMs: bucket.unitMs, suffix: bucket.suffix };
  }
  throw new Error('Sidebar time buckets must end with an unbounded bucket');
}

function nextRoundedBoundaryDelay(ageMs: number, unitMs: number, value: number): number {
  return Math.max(1, Math.ceil((value + 0.5) * unitMs - ageMs));
}

export function nextRelativeRefreshDelay(timestamp: number, now: number): number | null {
  const ageMs = relativeAgeMs(timestamp, now);
  if (ageMs > RELATIVE_HORIZON_MS) return null;
  if (ageMs < JUST_NOW_MS) return JUST_NOW_MS - ageMs;
  if (ageMs < HOUR_MS) return MINUTE_MS;
  return 10 * MINUTE_MS;
}

export function nextSidebarRefreshDelay(timestamp: number, now: number): number | null {
  const ageMs = relativeAgeMs(timestamp, now);
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs < JUST_NOW_MS) return JUST_NOW_MS - ageMs;
  const bucket = sidebarTimeBucket(ageMs);
  return Math.min(
    nextRoundedBoundaryDelay(ageMs, bucket.unitMs, bucket.value),
    MAX_SIDEBAR_REFRESH_MS,
  );
}
