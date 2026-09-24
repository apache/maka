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

export interface SessionSwipeSample {
  deltaX: number;
  deltaY: number;
  timeStamp: number;
  eligible: boolean;
}

export function createSessionSwipe() {
  let lastTime = -Infinity;
  let distance = 0;
  let verticalDistance = 0;
  let fired = false;
  let axis: 'pending' | 'horizontal' | 'blocked' = 'pending';
  return {
    sample(event: SessionSwipeSample): { claimed: boolean; direction: HistoryDirection | null } {
      if (event.timeStamp - lastTime > 250 || event.timeStamp < lastTime) {
        distance = 0;
        verticalDistance = 0;
        fired = false;
        axis = 'pending';
      }
      lastTime = event.timeStamp;
      if (!event.eligible) axis = 'blocked';
      if (axis === 'blocked') return { claimed: false, direction: null };
      distance += event.deltaX;
      verticalDistance += Math.abs(event.deltaY);
      if (axis === 'pending' && Math.max(Math.abs(distance), verticalDistance) >= 8) {
        axis = Math.abs(distance) >= verticalDistance * 2 ? 'horizontal' : 'blocked';
      }
      if (axis !== 'horizontal') return { claimed: false, direction: null };
      const direction = !fired && Math.abs(distance) >= 80 ? (distance < 0 ? -1 : 1) : null;
      if (direction !== null) fired = true;
      return { claimed: true, direction };
    },
  };
}
