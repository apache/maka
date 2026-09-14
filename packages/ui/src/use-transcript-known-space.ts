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

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

// The geometry ledger contains sizes and identities, never message bodies.
// Unmeasured loaded rows get a local placeholder; unseen history has no estimate.
// An offscreen height is provisional, including after width/content changes.
// Every mount measures again; invalidating all rows to a constant would move
// the whole document before any replacement measurements are available.
export function useTranscriptKnownSpace(
  root: RefObject<HTMLElement | null>,
  sessionId: string | undefined,
  ids: readonly string[],
  enabled: boolean,
  estimates: ReadonlyMap<string, number>,
) {
  const previous = useRef<{
    sessionId: string | undefined;
    ids: readonly string[];
    heights: Map<string, { height: number; measured: boolean }>;
    gap: number;
  }>({ sessionId, ids: [], heights: new Map(), gap: 0 });
  const old = previous.current;
  const mounted = new Set(ids);
  const overlaps = enabled && old.sessionId === sessionId
    ? old.ids.flatMap((id, index) => mounted.has(id) ? [index] : []) : [];
  const prefix = overlaps.length ? old.ids.slice(0, overlaps[0]) : [];
  const suffix = overlaps.length ? old.ids.slice(overlaps.at(-1)! + 1) : [];
  // Placeholders and range spacers read the same size ledger. Observed border
  // boxes replace provisional estimates and remain authoritative thereafter.
  // Spacing belongs to the list, so it is never baked into a measured height.
  const heights = overlaps.length ? old.heights : new Map<string, { height: number; measured: boolean }>();
  const estimate = 320;
  for (const id of ids) {
    const size = heights.get(id);
    const height = estimates.get(id) ?? estimate;
    if (!size?.measured && size?.height !== height) heights.set(id, { height, measured: false });
  }
  const gap = overlaps.length ? old.gap : 0;
  const sum = (values: readonly string[]) => values.reduce((total, id) => total + (heights.get(id)?.height ?? estimate) + gap, 0);
  const before = sum(prefix);
  const after = sum(suffix);

  useEffect(() => {
    if (!enabled) return;
    const parent = root.current?.querySelector('.maka-transcript-turn')?.parentElement;
    if (parent) previous.current.gap = Number.parseFloat(getComputedStyle(parent).rowGap) || 0;
  }, [enabled, root, sessionId]);
  useLayoutEffect(() => {
    if (!enabled) return;
    previous.current = { sessionId, ids: [...prefix, ...ids, ...suffix], heights, gap: previous.current.gap };
  });

  return {
    before, after,
    beforeHeight: Math.max(0, before - gap),
    afterHeight: Math.max(0, after - gap),
    height: (id: string) => Math.max(1, heights.get(id)?.height ?? estimate),
    measure: (id: string, height: number) => { heights.set(id, { height, measured: true }); },
  };
}
