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

import { useLayoutEffect, useRef, type RefObject } from 'react';

// Experiment only: measured space within one overlapping, fixed-layout history
// traversal. No unknown-height estimates, persistent cache or publication change.
// Resize/content revision and arbitrary disconnected navigation are not acceptance
// claims of this A/B prototype. It is not intended to merge as a complete design.
export function useTranscriptKnownSpace(
  root: RefObject<HTMLElement | null>,
  sessionId: string | undefined,
  ids: readonly string[],
  enabled: boolean,
) {
  const previous = useRef<{
    sessionId: string | undefined;
    ids: readonly string[];
    pitch: Map<string, number>;
    gap: number;
  }>({ sessionId, ids: [], pitch: new Map(), gap: 0 });
  const old = previous.current;
  const mounted = new Set(ids);
  const overlaps = old.sessionId === sessionId
    ? old.ids.flatMap((id, index) => mounted.has(id) ? [index] : []) : [];
  const prefix = overlaps.length ? old.ids.slice(0, overlaps[0]) : [];
  const suffix = overlaps.length ? old.ids.slice(overlaps.at(-1)! + 1) : [];
  const pitch = overlaps.length ? new Map(old.pitch) : new Map<string, number>();
  const sum = (values: readonly string[]) => values.reduce((total, id) => total + (pitch.get(id) ?? 0), 0);
  const before = sum(prefix);
  const after = sum(suffix);
  const gap = overlaps.length ? old.gap : 0;

  useLayoutEffect(() => {
    if (!enabled) return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('.maka-transcript-turn') ?? [])];
    const nextGap = rows[0]?.parentElement
      ? Number.parseFloat(getComputedStyle(rows[0].parentElement).rowGap) || 0 : 0;
    for (const row of rows) {
      const id = row.dataset.transcriptTurnId;
      if (id) pitch.set(id, row.getBoundingClientRect().height + nextGap);
    }
    previous.current = { sessionId, ids: [...prefix, ...ids, ...suffix], pitch, gap: nextGap };
  });

  return {
    before, after,
    beforeHeight: Math.max(0, before - gap),
    afterHeight: Math.max(0, after - gap),
  };
}
