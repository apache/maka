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

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const MONTH_MS = 30 * DAY_MS;
export const YEAR_MS = 12 * MONTH_MS;

export function isValidRelativeTimestamp(
  timestamp: number | null | undefined,
): timestamp is number {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0;
}

/**
 * Compact, width-stable relative timestamp for desktop sidebar conversation rows.
 * Future timestamps (clock skew) and ages under one minute collapse to `nowLabel`;
 * older ages use locale-neutral short units (`m`, `h`, `d`, `mo`, `y`).
 */
export function formatSidebarRelativeTime(
  updatedAt: number | null | undefined,
  now: number,
  nowLabel = 'now',
): string {
  if (!isValidRelativeTimestamp(updatedAt) || !Number.isFinite(now)) return '';
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs < MINUTE_MS) return nowLabel;
  const minutes = Math.floor(ageMs / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(ageMs / HOUR_MS);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(ageMs / DAY_MS);
  if (days < 30) return `${days}d`;
  const months = Math.floor(ageMs / MONTH_MS);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(ageMs / YEAR_MS)}y`;
}

/** Milliseconds until the next wall-clock minute boundary, bounded to `1..60_000`. */
export function nextMinuteTickDelay(now: number): number {
  if (!Number.isFinite(now)) return MINUTE_MS;
  const remainder = ((now % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  return MINUTE_MS - remainder;
}
