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

const COMPACT_TOKEN_UNITS = [
  { value: 1_000, suffix: 'K' },
  { value: 1_000_000, suffix: 'M' },
  { value: 1_000_000_000, suffix: 'B' },
  { value: 1_000_000_000_000, suffix: 'T' },
] as const;

export function formatCompactTokenCount(value: number): string {
  if (value < 1_000) return String(value);

  let unitIndex = COMPACT_TOKEN_UNITS.length - 1;
  while (unitIndex > 0 && value < COMPACT_TOKEN_UNITS[unitIndex].value) unitIndex -= 1;

  let compactValue = Math.round((value / COMPACT_TOKEN_UNITS[unitIndex].value) * 10) / 10;
  if (compactValue >= 1_000 && unitIndex < COMPACT_TOKEN_UNITS.length - 1) {
    unitIndex += 1;
    compactValue = 1;
  }

  return `${compactValue}${COMPACT_TOKEN_UNITS[unitIndex].suffix}`;
}
