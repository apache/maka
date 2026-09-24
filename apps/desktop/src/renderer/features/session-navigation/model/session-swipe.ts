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

export const SESSION_SWIPE_RETURN_DURATION_MS = 320;

export interface SessionSwipeSample {
  deltaX: number;
  deltaY: number;
  timeStamp: number;
  eligible: boolean;
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
  return {
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
      if (presentation === 'returning') settleAt = performance.now() + SESSION_SWIPE_RETURN_DURATION_MS;
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
      }
      lastTime = event.timeStamp;
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
        // The tail cannot extend or revive a completed visual acknowledgement.
        if (Math.abs(opposingDistance) < 24) return { claimed: true, direction: null };
        distance = opposingDistance - event.deltaX;
        verticalDistance = 0;
        opposingDistance = 0;
        fired = false;
        axis = 'pending';
      }
      distance += event.deltaX;
      verticalDistance += Math.abs(event.deltaY);
      if (axis === 'pending' && Math.max(Math.abs(distance), verticalDistance) >= 18) {
        axis = Math.abs(distance) >= verticalDistance * 1.5 ? 'horizontal' : 'blocked';
      }
      if (axis !== 'horizontal') return { claimed: false, direction: null };
      const direction = !fired && Math.abs(distance) >= 80 ? (distance < 0 ? -1 : 1) : null;
      if (direction !== null) fired = true;
      presentation = fired ? 'committed' : 'pulling';
      settleAt = performance.now() + (fired ? 650 : 500);
      return { claimed: true, direction };
    },
  };
}
