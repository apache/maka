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

import type { HistoryDirection } from './session-visit-history.js';

const normalMotion = { arrivalMs: 180, opacityMs: 200, holdMs: 200, returnMs: 320 };
const fastMotion = { arrivalMs: 280, opacityMs: 300, holdMs: 320, returnMs: 420 };

export interface SessionSwipeSample {
  deltaX: number;
  deltaY: number;
  timeStamp: number;
  /** null suspends input during inert transcript replacement, without rejecting the gesture. */
  eligible: boolean | null;
}

export interface SessionSwipeFeedback {
  direction: HistoryDirection;
  progress: number;
  committed: boolean;
}

export function createSessionSwipe() {
  let lastTime = -Infinity;
  let distance = 0;
  let verticalDistance = 0;
  let fired = false;
  let opposingDistance = 0;
  let axis: 'pending' | 'horizontal' | 'blocked' = 'pending';
  let presentation: 'pulling' | 'committed' | 'returning' | null = null;
  let settleAt = 0;
  let startedAt = 0;
  let fast = false;
  let firedAt = 0;
  let quietSince: number | null = null;
  let renewedDistance = 0;
  let renewedFrames = 0;
  let renewedAt = 0;
  const clearRenewal = () => {
    quietSince = null;
    renewedDistance = 0;
    renewedFrames = 0;
  };
  return {
    motion() {
      return fast ? fastMotion : normalMotion;
    },
    cancel(): void {
      axis = 'blocked';
      presentation = null;
    },
    /** The gesture owner also owns feedback lifetime; the view only schedules it. */
    settleAfter(): number | null {
      return presentation === null ? null : Math.max(0, settleAt - performance.now());
    },
    settle(): 'returning' | null {
      presentation = presentation && presentation !== 'returning' ? 'returning' : null;
      if (presentation === 'returning') settleAt = performance.now() + this.motion().returnMs;
      return presentation;
    },
    feedback(): SessionSwipeFeedback | null {
      return presentation !== null && (axis === 'horizontal' || fired) && distance !== 0
        ? { direction: distance < 0 ? -1 : 1, progress: Math.min(Math.abs(distance) / 80, 1), committed: fired }
        : null;
    },
    sample(event: SessionSwipeSample): { claimed: boolean; direction: HistoryDirection | null } {
      if (event.timeStamp - lastTime > 250 || event.timeStamp < lastTime) {
        distance = 0;
        verticalDistance = 0;
        fired = false;
        opposingDistance = 0;
        axis = 'pending';
        presentation = null;
        startedAt = event.timeStamp;
        fast = false;
        clearRenewal();
      }
      lastTime = event.timeStamp;
      if (event.eligible === null) return { claimed: false, direction: null };
      if (!event.eligible) {
        // After completion, a detached target is only an inert tail. It must
        // neither navigate nor poison a deliberate reverse on the new surface.
        if (fired) return { claimed: false, direction: null };
        axis = 'blocked';
      }
      if (axis === 'blocked') {
        if (!fired) presentation = null;
        return { claimed: false, direction: null };
      }
      // Keep momentum latched, but let an intentional reverse start another
      // gesture. Tiny opposite-sign recoil must not undo a completed swipe.
      if (fired) {
        opposingDistance = event.deltaX * distance < 0 ? opposingDistance + event.deltaX : 0;
        // Windows can join successive physical strokes into one wheel stream.
        // A quiet tail followed by two strong frames is renewed input; an
        // isolated coalesced spike, steady drag or recoil is still the tail.
        if (event.deltaX * distance > 0 && event.timeStamp - firedAt >= 180
          && Math.abs(event.deltaX) >= Math.abs(event.deltaY) * 1.5) {
          const magnitude = Math.abs(event.deltaX);
          if (magnitude <= 8) {
            quietSince ??= event.timeStamp;
            renewedDistance = 0;
            renewedFrames = 0;
          } else if (magnitude >= 12 && quietSince !== null && event.timeStamp - quietSince >= 40) {
            if (renewedFrames === 0 || event.timeStamp - renewedAt > 80) {
              renewedAt = event.timeStamp;
              renewedDistance = 0;
              renewedFrames = 0;
            }
            renewedDistance += event.deltaX;
            renewedFrames++;
          } else if (magnitude < 12) {
            // The new stroke may ramp up through weak opening frames. Keep
            // the quiet-tail readiness, but do not count them as strong input.
            renewedDistance = 0;
            renewedFrames = 0;
          } else clearRenewal();
        } else clearRenewal();
        const renewed = renewedFrames >= 2 && Math.abs(renewedDistance) >= 40;
        // Neither ordinary momentum nor an isolated spike revives the arrow.
        if (Math.abs(opposingDistance) < 24 && !renewed) return { claimed: true, direction: null };
        distance = (renewed ? renewedDistance : opposingDistance) - event.deltaX;
        verticalDistance = 0;
        opposingDistance = 0;
        fired = false;
        axis = 'pending';
        startedAt = renewed ? renewedAt : event.timeStamp;
        fast = false;
        clearRenewal();
      }
      if (distance === 0 && axis === 'pending') startedAt = event.timeStamp;
      distance += event.deltaX;
      verticalDistance += Math.abs(event.deltaY);
      if (axis === 'pending' && Math.max(Math.abs(distance), verticalDistance) >= 18) {
        axis = Math.abs(distance) >= verticalDistance * 1.5 ? 'horizontal' : 'blocked';
      }
      if (axis !== 'horizontal') return { claimed: false, direction: null };
      fast ||= Math.abs(distance) >= 40 && Math.abs(distance) / Math.max(event.timeStamp - startedAt, 16) >= 1;
      const direction = !fired && Math.abs(distance) >= 80 ? (distance < 0 ? -1 : 1) : null;
      if (direction !== null) {
        fired = true;
        firedAt = event.timeStamp;
        clearRenewal();
      }
      presentation = fired ? 'committed' : 'pulling';
      settleAt = performance.now() + (fired ? this.motion().holdMs : 500);
      return { claimed: true, direction };
    },
  };
}
