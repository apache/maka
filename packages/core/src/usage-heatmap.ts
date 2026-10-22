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

/** Local midnight instants supplied by the Desktop, independent of Host timezone. */
export interface UsageHeatmapRange {
  dayStarts: number[];
  to: number;
}

export interface UsageHeatmap {
  days: Array<{ start: number; tokens: number; successfulRequests: number }>;
  through: number;
  hasIncompleteUsage: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const validInstant = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;

/** Bound the wire query while allowing days shortened or lengthened by DST. */
export function isUsageHeatmapRange(value: unknown): value is UsageHeatmapRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  if (
    Object.keys(range).length !== 2 ||
    !validInstant(range.to) ||
    !Array.isArray(range.dayStarts) ||
    range.dayStarts.length < 1 ||
    range.dayStarts.length > 366
  )
    return false;
  const starts = range.dayStarts;
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    if (!validInstant(start) || !Number.isSafeInteger(start)) return false;
    if (index > 0) {
      const duration = start - starts[index - 1];
      if (duration < 20 * HOUR_MS || duration > 28 * HOUR_MS) return false;
    }
  }
  const last = starts[starts.length - 1] as number;
  return range.to >= last && range.to < last + 28 * HOUR_MS;
}

/** The last twelve calendar months, including today up to the sampled instant. */
export function resolveUsageHeatmapRange(now: number): UsageHeatmapRange {
  if (!validInstant(now)) throw new RangeError('Invalid heatmap instant');
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // Start at the same calendar date as tomorrow, one year earlier. This gives
  // 365 or 366 local dates, including today, without assuming 24-hour days.
  const day = new Date(today);
  day.setDate(day.getDate() + 1);
  day.setFullYear(day.getFullYear() - 1);
  // Today or tomorrow may have skipped midnight; the first date has its own
  // local boundary and must not inherit that one-off 01:00 start.
  day.setHours(0, 0, 0, 0);
  const dayStarts: number[] = [];
  while (day.getTime() <= today.getTime()) {
    dayStarts.push(day.getTime());
    day.setDate(day.getDate() + 1);
    // Some zones skip midnight. Reset for each new date so a one-off 01:00
    // start does not shift every subsequent day (e.g. America/Santiago).
    day.setHours(0, 0, 0, 0);
  }
  return { dayStarts, to: now };
}
