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

import type { PetActivityState, PetAnimationV1, PetSpriteSheetV1 } from '@maka/core/pet';

import type { SessionStatus } from '@maka/core/session';

export interface PetRuntimeActivityInput {
  readonly hasActiveSession: boolean;
  readonly hasActiveInteraction: boolean;
  readonly turnActive: boolean;
  readonly sessionStatus: SessionStatus | undefined;
}

/**
 * Project authoritative shell signals onto the pack contract. Completion is a
 * separate edge-triggered pulse: normal turns return their session to `active`,
 * so a durable status cannot distinguish "ready just now" from ordinary idle.
 */
export function derivePetActivityState(
  input: PetRuntimeActivityInput,
): PetActivityState {
  if (!input.hasActiveSession) return 'idle';
  if (input.hasActiveInteraction || input.sessionStatus === 'waiting_for_user') {
    return 'needs-input';
  }
  if (input.sessionStatus === 'blocked') return 'blocked';
  if (input.turnActive) return 'working';
  return 'idle';
}

/** The pack state for the displayed Session: Conversation's activity reading plus its catalog row. */
export function petActivityForSession(input: {
  readonly activity: { readonly turnRunning: boolean; readonly awaitingInteraction: boolean };
  readonly hasActiveSession: boolean;
  readonly sessionStatus: SessionStatus | undefined;
}): PetActivityState {
  return derivePetActivityState({
    hasActiveSession: input.hasActiveSession,
    hasActiveInteraction: input.activity.awaitingInteraction,
    turnActive: input.activity.turnRunning,
    sessionStatus: input.sessionStatus,
  });
}

export interface PetAnimationSample {
  readonly frame: number;
  readonly sequenceIndex: number;
  readonly complete: boolean;
}

/** Pure elapsed-time sampler so delayed frames do not slow the animation. */
export function samplePetAnimation(
  animation: PetAnimationV1,
  elapsedMs: number,
): PetAnimationSample {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const unboundedIndex = Math.floor((elapsed * animation.fps) / 1_000);
  const complete = !animation.loop && unboundedIndex >= animation.frames.length;
  const sequenceIndex = animation.loop
    ? unboundedIndex % animation.frames.length
    : Math.min(unboundedIndex, animation.frames.length - 1);
  return {
    frame: animation.frames[sequenceIndex],
    sequenceIndex,
    complete,
  };
}

export interface PetFrameSourceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function petFrameSourceRect(
  frame: number,
  sheet: PetSpriteSheetV1,
): PetFrameSourceRect {
  return {
    x: (frame % sheet.columns) * sheet.frameWidth,
    y: Math.floor(frame / sheet.columns) * sheet.frameHeight,
    width: sheet.frameWidth,
    height: sheet.frameHeight,
  };
}
