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

export const MAX_USAGE = 200;
const MAX_ROWS = 30;
const MAX_RECOMMENDED = 4;
const FREQUENT_USES = 5;

export type Used = { uses: number; lastUsed: number };
export type Usage = Readonly<Record<string, Used>>;

const weight = (used: Used | undefined) =>
  used === undefined ? 0 : Math.min(used.uses, 50) + Math.min(used.lastUsed / 1e13, 1);

export function parseUsage(stored: string | null): Usage {
  if (stored === null) return {};
  const parsed: unknown = JSON.parse(stored);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Quick launcher usage is not an object');
  return parsed as Usage;
}

export function recordUse(usage: Usage, key: string, at: number): Usage {
  const next = { ...usage, [key]: { uses: (usage[key]?.uses ?? 0) + 1, lastUsed: at } };
  const keys = Object.keys(next);
  if (keys.length > MAX_USAGE) {
    const oldest = keys.reduce((left, right) =>
      next[left]!.lastUsed <= next[right]!.lastUsed ? left : right,
    );
    delete next[oldest];
  }
  return next;
}

/** Best match first; among equal matches, what has been used most. */
export function ranked<T extends { key: string; match: number }>(
  candidates: readonly T[],
  usage: Usage,
): T[] {
  return [...candidates]
    .sort(
      (left, right) =>
        left.match - right.match || weight(usage[right.key]) - weight(usage[left.key]),
    )
    .slice(0, MAX_ROWS);
}

export function recommended<T extends { key: string; remembered: boolean }>(
  candidates: readonly T[],
  usage: Usage,
): T[] {
  return candidates
    .filter((candidate) => candidate.remembered && usage[candidate.key] !== undefined)
    .sort((left, right) => weight(usage[right.key]) - weight(usage[left.key]))
    .slice(0, MAX_RECOMMENDED);
}

export const isFrequent = (used: Used) => used.uses >= FREQUENT_USES;
