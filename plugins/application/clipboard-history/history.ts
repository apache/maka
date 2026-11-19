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

/** How many entries the history may keep, the second the default. */
export const LIMITS = [20, 50, 100, 200] as const;
export type Limit = (typeof LIMITS)[number];
export const DEFAULT_LIMIT: Limit = 50;

export type HistoryEntry = {
  change: number;
  copiedAt: number;
  preview?: string | null;
  dimensions?: string | null;
  format: string;
  data: string;
  paths: string[];
  thumbnail?: string | null;
};

const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

function sameEntry(a: HistoryEntry, b: HistoryEntry): boolean {
  return (
    a.format === b.format &&
    a.data === b.data &&
    a.paths.length === b.paths.length &&
    a.paths.every((path, index) => path === b.paths[index])
  );
}

/** The memory cap also bounds a series of large image copies. */
export function remember(
  history: readonly HistoryEntry[],
  entry: HistoryEntry,
  limit: Limit,
): readonly HistoryEntry[] {
  const result: HistoryEntry[] = [];
  let used = 0;
  for (const item of [entry, ...history.filter((older) => !sameEntry(older, entry))]) {
    used +=
      item.data.length * (item.format === 'public.utf8-plain-text' ? 2 : 1) +
      (item.thumbnail?.length ?? 0) +
      (item.preview?.length ?? 0) +
      item.paths.reduce((sum, path) => sum + 2 * path.length, 0);
    if (used > MAX_HISTORY_BYTES || result.length === limit) break;
    result.push(item);
  }
  return result;
}
