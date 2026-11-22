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

import {
  cleanup,
  createAnimatedValue,
  Easing,
  platform,
  reduceMotion,
  type AnimatedValue,
} from 'nsh';

/** Single gate for all Room animations: strictly disabled under Reduce Motion or terminal idiom. */
export const motionEnabled = () => !reduceMotion() && platform.idiom !== 'terminal';

export const ROOM_SPRING = {
  pillBounce: { stiffness: 460, damping: 18, mass: 0.9 },
  pillTilt: { stiffness: 380, damping: 16, mass: 0.8 },
  roomSwitch: { stiffness: 340, damping: 32 },
} as const;

/** Smooth subtle starting/ending classes for Popover & HoverCard; empty when motion is reduced. */
export function popupMotionProps(direction: 'up' | 'down' = 'down') {
  if (!motionEnabled()) return {};
  return {
    popupStartingClass:
      direction === 'up'
        ? 'opacity-0 translate-y-1 scale-[0.97]'
        : 'opacity-0 -translate-y-1 scale-[0.97]',
    popupEndingClass:
      direction === 'up'
        ? 'opacity-0 translate-y-0.5 scale-[0.98]'
        : 'opacity-0 -translate-y-0.5 scale-[0.98]',
  };
}

/** Gentle 190ms rise for live incoming messages only; never used on initial load or pagination. */
export function useLiveMessageStyle(isLive: boolean) {
  if (!isLive || !motionEnabled()) return undefined;
  const p = createAnimatedValue(0);
  void p.timing(1, { duration: 190, easing: Easing.out(Easing.cubic) });
  cleanup(() => p.stop());
  return {
    opacity: p,
    transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
  };
}

/** Subtle organic breathing motion for active working / waiting member indicators. */
export function useBreathingStyle(slow = false) {
  if (!motionEnabled()) return undefined;
  const p = createAnimatedValue(0);
  void p.keyframes([0, 1, 0], {
    duration: slow ? 3200 : 2200,
    easing: Easing.inOut(Easing.sin),
    iterations: 'infinite',
    frameRate: 30,
  });
  cleanup(() => p.stop());
  return {
    opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.96] }),
    transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.1] }) }],
  };
}

/** Breathing fade-out highlight for jump-to-quote / pin / search navigation. */
export function runJumpHighlight(progress: AnimatedValue): Promise<void> {
  if (!motionEnabled()) {
    progress.set(1);
    return new Promise((resolve) => {
      setTimeout(() => {
        progress.set(0);
        resolve();
      }, 1400);
    });
  }
  progress.stop();
  progress.set(0);
  return progress
    .keyframes([0, 1, 0.3, 0.78, 0], {
      duration: 1650,
      easing: Easing.inOut(Easing.sin),
    })
    .then(() => undefined);
}

/** Create a clean AnimatedValue initialized at 0 for jump highlights. */
export function createJumpHighlightValue() {
  return createAnimatedValue(0);
}
