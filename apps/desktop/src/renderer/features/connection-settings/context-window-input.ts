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

/** Decimal token counts, not binary sizes; the persisted value stays an integer. */
export function parseContextWindowInput(input: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?([km]?)$/i.exec(input.trim());
  if (!match) return null;
  const places = match[3]?.toLowerCase() === 'm' ? 6 : match[3]?.toLowerCase() === 'k' ? 3 : 0;
  const fraction = match[2] ?? '';
  // Shift decimal digits before converting: 1.001 * 1000 is not exactly 1001
  // in floating point, and rounding would silently accept fractional tokens.
  if (/[1-9]/.test(fraction.slice(places))) return null;
  const value = Number(match[1] + fraction.padEnd(places, '0').slice(0, places));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Parse a compaction target as tokens, a percentage of the effective window, or `off`. */
export function parseCompactionThresholdInput(
  input: string,
  effectiveContextWindow: number | undefined,
): number | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'off' || normalized === '0') return 0;
  if (normalized.endsWith('%')) {
    if (effectiveContextWindow === undefined) return null;
    const percentage = Number(normalized.slice(0, -1));
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) return null;
    const value = Math.round((effectiveContextWindow * percentage) / 100);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return parseContextWindowInput(input);
}
