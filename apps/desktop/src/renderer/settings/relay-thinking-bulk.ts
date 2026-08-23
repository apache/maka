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

import type { RelayModelProfile, ThinkingLevel } from '@maka/core/model-thinking';

/**
 * Bulk thinking-level editing for the capability section's relay-profile
 * draft.
 *
 * A relay commonly fronts a whole family of models that accept the same
 * `reasoning_effort` values, and the per-model rows made declaring that an
 * N-models × M-levels click exercise. This module is the shared, testable
 * half of the one control that does it in one gesture; the hook owns the
 * state and the component owns the menu.
 *
 * The bulk control is **per level**, not per level *set*: ticking `high`
 * adds `high` everywhere and unticking removes it everywhere, leaving every
 * other level on every model exactly as the user left it. A replace-the-set
 * design would have been one fewer concept, but it silently discards
 * whatever a row already declared — the destructive reading of a control
 * whose whole point is to save clicks.
 */

/**
 * Pin or clear one model's declared levels, shared by the single-row setter
 * and the bulk path so both agree on what an emptied declaration *is*.
 *
 * An entry with no keys left is not an entry: `{}` would keep a row reading
 * as declared (and `hasRelayProfileChanges` reading as dirty) after the user
 * cleared its last field, so it collapses to `undefined` and the caller drops
 * the key.
 */
export function relayProfileWithThinkingLevels(
  current: RelayModelProfile | undefined,
  levels: readonly ThinkingLevel[] | undefined,
): RelayModelProfile | undefined {
  if (levels === undefined || levels.length === 0) {
    if (!current) return current;
    const { thinkingLevels: _dropped, ...rest } = current;
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return { ...(current ?? {}), thinkingLevels: [...levels] };
}

/**
 * How much of the current selection declares one level. `declaredCount` is
 * what the menu shows; `checked` is the box, and it is `true` only at full
 * coverage — a partially covered level reads as unticked with its count
 * beside it, so one more click means "give it to everyone" rather than
 * "take it from the rows that have it".
 */
export interface BulkThinkingLevelState {
  readonly level: ThinkingLevel;
  readonly declaredCount: number;
  readonly total: number;
  readonly checked: boolean;
}

function draftIndex(
  draft: Readonly<Record<string, RelayModelProfile>>,
): ReadonlyMap<string, RelayModelProfile> {
  // Object.entries, not `draft[modelId]`: model ids come from the relay and
  // may collide with prototype keys, where a plain index read answers with
  // `Object.prototype.constructor` instead of "absent".
  return new Map(Object.entries(draft));
}

export function bulkThinkingLevelStates(
  modelIds: readonly string[],
  draft: Readonly<Record<string, RelayModelProfile>>,
  levels: readonly ThinkingLevel[],
): readonly BulkThinkingLevelState[] {
  const index = draftIndex(draft);
  // A duplicated id is one model, not two: it must not inflate the
  // denominator past what the rows below actually show.
  const targets = [...new Set(modelIds)];
  return levels.map((level) => {
    const declaredCount = targets.filter((modelId) =>
      index.get(modelId)?.thinkingLevels?.includes(level),
    ).length;
    return {
      level,
      declaredCount,
      total: targets.length,
      checked: targets.length > 0 && declaredCount === targets.length,
    };
  });
}

/**
 * Add or remove one level across every model in the current selection,
 * returning the next draft.
 *
 * Models outside `modelIds` keep their entries untouched. The draft may hold
 * declarations for models the user has since disabled — reads prune against
 * the enabled set rather than the draft doing it — and a bulk edit is not
 * the place to decide those are gone.
 */
export function applyBulkThinkingLevel(
  modelIds: readonly string[],
  draft: Readonly<Record<string, RelayModelProfile>>,
  level: ThinkingLevel,
  checked: boolean,
): Record<string, RelayModelProfile> {
  const targets = new Set(modelIds);
  const entries: [string, RelayModelProfile][] = [];
  const placed = new Set<string>();
  const next = (current: RelayModelProfile | undefined): RelayModelProfile | undefined => {
    const declared = current?.thinkingLevels ?? [];
    if (checked) {
      return declared.includes(level)
        ? current
        : relayProfileWithThinkingLevels(current, [...declared, level]);
    }
    return relayProfileWithThinkingLevels(
      current,
      declared.filter((existing) => existing !== level),
    );
  };
  // Existing entries first, in place: a bulk edit must not reshuffle the
  // draft under the rows the user is looking at.
  for (const [modelId, profile] of Object.entries(draft)) {
    placed.add(modelId);
    const updated = targets.has(modelId) ? next(profile) : profile;
    if (updated !== undefined) entries.push([modelId, updated]);
  }
  for (const modelId of modelIds) {
    if (placed.has(modelId)) continue;
    placed.add(modelId);
    const updated = next(undefined);
    if (updated !== undefined) entries.push([modelId, updated]);
  }
  // fromEntries, not assignment onto an object literal, for the same reason
  // the core normalizer uses it: a relay-supplied `__proto__` key would
  // otherwise write through the prototype instead of storing an entry.
  return Object.fromEntries(entries);
}
