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

// Focus follows the level, for any settings page that owns more than one.
//
// Without this a level change leaves the ring on `document.body` — the control
// that had focus just unmounted — and a keyboard user restarts from the top of
// the document on every move.
//
// Only the mechanism is shared, because only the mechanism drifts invisibly:
// skipping the first render, the animation frame, `preventScroll`, cancelling
// on the way out. Which element each level focuses stays with the page — a
// wrong target puts the ring somewhere you can see.
import { useEffect, useRef } from 'react';

export function useSettingsRouteFocus(options: {
  /** The level being rendered. A change here is what moves focus. */
  level: string;
  /**
   * Anything that should re-run the move without changing `level`. Compared by
   * identity, and only needed by a page whose level is not the whole route.
   */
  routeKey?: unknown;
  /** False while the page has nothing to focus yet (loading its data). */
  isReady?: boolean;
  /** Where focus goes for the level being rendered; null to leave it alone. */
  resolveTarget(level: string): HTMLElement | null;
}): void {
  const { level, routeKey, isReady = true } = options;
  // `resolveTarget` closes over fresh state every render but must not re-run
  // the effect, so it is read through a ref written in its own effect —
  // committed values only, which a ref written during render would not be.
  const resolveTargetRef = useRef(options.resolveTarget);
  useEffect(() => {
    resolveTargetRef.current = options.resolveTarget;
  });

  // Navigating, not arriving: the page does not grab focus when the settings
  // surface first renders it — the user is still on the settings nav item they
  // clicked to get here, and taking the ring off it strands them.
  const hasNavigatedRef = useRef(false);
  useEffect(() => {
    if (!isReady) return;
    if (!hasNavigatedRef.current) {
      hasNavigatedRef.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      // `preventScroll` because this is a landing, not a jump: the level just
      // rendered at the top of the content area, and scrolling to whatever the
      // target happens to be would push its own header out of view.
      resolveTargetRef.current(level)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [level, routeKey, isReady]);
}
