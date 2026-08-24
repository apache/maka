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

interface SessionTurnHeights {
  layoutKey: string;
  heights: Map<string, number>;
}

export interface TurnHeightIndex {
  lookup(sessionId: string, layoutKey: string): ReadonlyMap<string, number> | undefined;
  record(sessionId: string, layoutKey: string, turnId: string, height: number): boolean;
}

export function turnLayoutGap(root: HTMLElement, fallback: number): number {
  const column = root.querySelector<HTMLElement>('.maka-chat-message-list');
  const rows = column?.firstElementChild;
  const styles = rows && root.ownerDocument.defaultView?.getComputedStyle(rows);
  const parsed = Number.parseFloat(styles?.rowGap ?? styles?.gap ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function turnLayoutKey(root: HTMLElement, gap: number): string {
  const column = root.querySelector<HTMLElement>('.maka-chat-message-list');
  return `${Math.round((column ?? root).clientWidth)}:${gap}:${root.dataset.density ?? ''}`;
}

export function createTurnHeightIndex(sessionCapacity = 12, turnCapacity = 1_024): TurnHeightIndex {
  const sessions = new Map<string, SessionTurnHeights>();

  const entryFor = (sessionId: string, layoutKey: string): SessionTurnHeights => {
    const current = sessions.get(sessionId);
    if (current?.layoutKey === layoutKey) {
      sessions.delete(sessionId);
      sessions.set(sessionId, current);
      return current;
    }
    const next = { layoutKey, heights: new Map<string, number>() };
    sessions.delete(sessionId);
    sessions.set(sessionId, next);
    while (sessions.size > sessionCapacity) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return next;
  };

  return {
    lookup(sessionId, layoutKey) {
      const entry = sessions.get(sessionId);
      if (entry?.layoutKey !== layoutKey) return undefined;
      sessions.delete(sessionId);
      sessions.set(sessionId, entry);
      return entry.heights;
    },
    record(sessionId, layoutKey, turnId, height) {
      if (!Number.isFinite(height) || height <= 0) return false;
      const entry = entryFor(sessionId, layoutKey);
      const previous = entry.heights.get(turnId);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) return false;
      entry.heights.delete(turnId);
      entry.heights.set(turnId, height);
      while (entry.heights.size > turnCapacity) {
        const oldest = entry.heights.keys().next().value;
        if (oldest === undefined) break;
        entry.heights.delete(oldest);
      }
      return true;
    },
  };
}
