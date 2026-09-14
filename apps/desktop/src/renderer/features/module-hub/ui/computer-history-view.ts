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

import type { ComputerHistoryTimelineEntry } from '@maka/core/computer-history';
import { intersectHistoryDays, localHistoryDay, shiftHistoryDay } from './computer-history-copy.js';

export type HistoryGranularity = '10min' | '6h' | 'day';

export interface HistoryViewGroup {
  id: string;
  start: string;
  end: string;
  day: string;
  summary?: ComputerHistoryTimelineEntry;
  entries: readonly ComputerHistoryTimelineEntry[];
  kind: HistoryGranularity;
}

const SIX_HOURS = 6 * 60 * 60 * 1_000;

function newestFirst(a: { start: string; id: string }, b: { start: string; id: string }): number {
  return Date.parse(b.start) - Date.parse(a.start) || a.id.localeCompare(b.id);
}

function windowStart(entry: ComputerHistoryTimelineEntry): number {
  return Math.floor(Date.parse(entry.start) / SIX_HOURS) * SIX_HOURS;
}

function covers(parent: ComputerHistoryTimelineEntry, child: ComputerHistoryTimelineEntry): boolean {
  const start = Date.parse(child.start);
  const end = Date.parse(child.end);
  return Date.parse(parent.start) <= start &&
    (start === end ? start < Date.parse(parent.end) : end <= Date.parse(parent.end));
}

/**
 * Builds display collections without mutating or synthesizing summary documents.
 * allEntries owns provenance and identity; filteredEntries supplies matching IDs.
 * Canonical saved summaries have one parent per UTC six-hour window.
 * Day collections may repeat a document on each intersected local date.
 */
export function groupHistoryEntries(
  allEntries: readonly ComputerHistoryTimelineEntry[],
  filteredEntries: readonly ComputerHistoryTimelineEntry[],
  granularity: HistoryGranularity,
): HistoryViewGroup[] {
  const entries = [...new Map(allEntries.filter((entry) =>
    (entry.summaryLevel === '10min' || entry.summaryLevel === '6h') &&
    Number.isFinite(Date.parse(entry.start)) && Number.isFinite(Date.parse(entry.end)) &&
    Date.parse(entry.end) >= Date.parse(entry.start),
  ).map((entry) => [entry.id, entry])).values()].sort(newestFirst);
  const matching = new Set(filteredEntries.map((entry) => entry.id));
  const leaves = entries.filter((entry) => entry.summaryLevel === '10min' && matching.has(entry.id));
  const parents = entries.filter((entry) => entry.summaryLevel === '6h');

  const childrenOf = (parent: ComputerHistoryTimelineEntry) => {
    const childIds = parent.summaryChildren === undefined ? undefined : new Set(parent.summaryChildren);
    return leaves.filter((leaf) => childIds ? childIds.has(leaf.id) : covers(parent, leaf));
  };

  if (granularity !== '6h') {
    const byDay = new Map<string, ComputerHistoryTimelineEntry[]>();
    const visible = granularity === '10min' ? leaves : entries.filter((entry) => matching.has(entry.id));
    for (const entry of visible) {
      // A matching parent stands in only for dates without matching children of its own.
      const childDays = entry.summaryLevel === '6h'
        ? new Set(childrenOf(entry).flatMap(intersectHistoryDays)) : undefined;
      const days = granularity === '10min' ? [localHistoryDay(entry.start)] : intersectHistoryDays(entry);
      for (const day of days) {
        if (childDays?.has(day)) continue;
        const group = byDay.get(day) ?? [];
        group.push(entry);
        byDay.set(day, group);
      }
    }
    return [...byDay].map(([day, members]) => ({
      id: `${granularity}:${day}`,
      start: new Date(`${day}T00:00:00`).toISOString(),
      end: new Date(`${shiftHistoryDay(day, 1)}T00:00:00`).toISOString(),
      day,
      entries: members,
      kind: granularity,
    })).sort(newestFirst);
  }

  const groups: HistoryViewGroup[] = [];
  const parentWindows = new Set(parents.map(windowStart));
  const claimed = new Set<string>();
  const sixHourGroup = (
    start: number, id: string, members: readonly ComputerHistoryTimelineEntry[],
    summary?: ComputerHistoryTimelineEntry,
  ): HistoryViewGroup => ({
    id,
    start: new Date(start).toISOString(),
    end: new Date(start + SIX_HOURS).toISOString(),
    day: localHistoryDay(new Date(start)),
    entries: members,
    kind: granularity,
    ...(summary ? { summary } : {}),
  });

  for (const parent of parents) {
    const members = childrenOf(parent);
    for (const child of members) claimed.add(child.id);
    if (!matching.has(parent.id) && !members.length) continue;
    const start = windowStart(parent);
    groups.push(sixHourGroup(start, `6h:${start}`, members, parent));
  }

  const pending = new Map<number, ComputerHistoryTimelineEntry[]>();
  for (const leaf of leaves) {
    if (claimed.has(leaf.id)) continue;
    const start = windowStart(leaf);
    const group = pending.get(start) ?? [];
    group.push(leaf);
    pending.set(start, group);
  }
  for (const [start, members] of pending) {
    // Unreferenced leaves remain separate from the saved parent's claimed inputs.
    const suffix = parentWindows.has(start) ? ':pending' : '';
    groups.push(sixHourGroup(start, `6h:${start}${suffix}`, members));
  }
  return groups.sort(newestFirst);
}
