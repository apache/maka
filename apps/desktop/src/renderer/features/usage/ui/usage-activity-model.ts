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

import type { UsageHeatmap } from '@maka/core/settings';

export type UsageActivityDay = UsageHeatmap['days'][number];

export type UsageActivityWeek = {
  /** Only dates included in the rolling year, including its partial first week. */
  days: UsageActivityDay[];
  start: number;
};

export function mondayIndex(timestamp: number): number {
  return (new Date(timestamp).getDay() + 6) % 7;
}

/** Calendar positions use local dates, never elapsed 24-hour periods (DST). */
export function buildUsageActivityWeeks(days: UsageActivityDay[]): UsageActivityWeek[] {
  const weeks: UsageActivityWeek[] = [];
  for (const day of days) {
    let week = weeks[weeks.length - 1];
    if (!week || mondayIndex(day.start) === 0) {
      week = { days: [], start: day.start };
      weeks.push(week);
    }
    week.days.push(day);
  }
  return weeks;
}

/** Positive-day quartiles keep occasional very large requests from washing out the year. */
export function usageActivityThresholds(days: UsageActivityDay[]): number[] {
  const positive = days.map((day) => day.tokens).filter((value) => value > 0).sort((a, b) => a - b);
  return positive.length === 0 ? [] : [0.25, 0.5, 0.75].map((quantile) => positive[Math.floor(positive.length * quantile)]!);
}

export function usageActivityLevel(value: number, thresholds: readonly number[]): number {
  return value <= 0 ? 0 : 1 + thresholds.filter((threshold) => value >= threshold).length;
}

export function usageActivityFocusIndex(
  key: string,
  index: number,
  count: number,
): number | null {
  const next = key === 'ArrowLeft' ? index - 7
    : key === 'ArrowRight' ? index + 7
      : key === 'ArrowUp' ? index - 1
        : key === 'ArrowDown' ? index + 1
          : key === 'Home' ? 0
            : key === 'End' ? count - 1
              : null;
  return next === null ? null : Math.max(0, Math.min(count - 1, next));
}
