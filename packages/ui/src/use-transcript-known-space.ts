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
  const overlaps = enabled && old.sessionId === sessionId
    ? old.ids.flatMap((id, index) => mounted.has(id) ? [index] : []) : [];
  const prefix = overlaps.length ? old.ids.slice(0, overlaps[0]) : [];
  const suffix = overlaps.length ? old.ids.slice(overlaps.at(-1)! + 1) : [];
  const pitch = overlaps.length ? new Map(old.pitch) : new Map<string, number>();
  const estimate = 320;
  const sum = (values: readonly string[]) => values.reduce((total, id) => total + (pitch.get(id) ?? estimate + old.gap), 0);
  const before = sum(prefix);
  const after = sum(suffix);
  const gap = overlaps.length ? old.gap : 0;

  useEffect(() => {
    if (!enabled) return;
    const parent = root.current?.querySelector('.maka-transcript-turn')?.parentElement;
    if (parent) previous.current.gap = Number.parseFloat(getComputedStyle(parent).rowGap) || 0;
  }, [enabled, root, sessionId]);
  useLayoutEffect(() => {
    if (!enabled) return;
    previous.current = { sessionId, ids: [...prefix, ...ids, ...suffix], pitch, gap: previous.current.gap };
  });

  return {
    before, after,
    beforeHeight: Math.max(0, before - gap),
    afterHeight: Math.max(0, after - gap),
    height: (id: string) => Math.max(1, (pitch.get(id) ?? estimate + gap) - gap),
    measure: (id: string, height: number) => previous.current.pitch.set(id, height + previous.current.gap),
  };
}
