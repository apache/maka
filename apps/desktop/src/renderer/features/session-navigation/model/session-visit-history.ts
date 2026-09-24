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

export type HistoryDirection = -1 | 1;

/** Window-local navigation only; the catalog remains the selection authority. */
export function createSessionVisitHistory() {
  let entries: Array<string | undefined> = [];
  let cursor = -1;
  let traversing = false;
  return {
    visit(sessionId: string | undefined): void {
      if (traversing || !sessionId || entries[cursor] === sessionId) return;
      entries = [...entries.slice(0, cursor + 1), sessionId].slice(-100);
      cursor = entries.length - 1;
    },
    move(direction: HistoryDirection, available: (id: string) => boolean, open: (id: string) => boolean): boolean {
      let next = cursor + direction;
      while (next >= 0 && next < entries.length &&
        (!entries[next] || entries[next] === entries[cursor] || !available(entries[next]!))) next += direction;
      const id = entries[next];
      if (!id) return false;
      traversing = true;
      try {
        if (!open(id)) return false;
        cursor = next;
        return true;
      } finally {
        traversing = false;
      }
    },
    forget(ids: ReadonlySet<string>): void {
      if (ids.size === 0) return;
      // Keep empty positions (within the 100-entry bound) so removing the
      // current visit does not silently move the cursor to its predecessor.
      entries = entries.map((id) => id && ids.has(id) ? undefined : id);
    },
  };
}
