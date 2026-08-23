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

import { randomUUID } from 'node:crypto';
import type {
  ComputerUseBoundAction,
  ComputerUseFrameIdentity,
  ComputerUseObservationIdentity,
  ComputerUseRect,
  ComputerUseWindowIdentity,
  CuAction,
  CuPoint,
} from '@maka/core/computer-use';

export type CuaFrameIdentity = ComputerUseFrameIdentity;
export type CuaObservation = ComputerUseObservationIdentity;
export type CuaBoundAction = ComputerUseBoundAction & {
  fingerprint: string;
};

export interface CuaObservationSnapshot {
  capturedAt: number;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  displays: ComputerUseObservationIdentity['displays'];
  target: ComputerUseWindowIdentity;
}

export type CuaActionRejectionReason =
  | 'invalid_binding'
  | 'no_active_frame'
  | 'stale_epoch'
  | 'stale_frame'
  | 'duplicate_action'
  // The same action again, where the first attempt was refused before anything
  // was dispatched. Its own label because the recovery is the opposite one:
  // `duplicate_action` means "it may already have taken effect, look", and this
  // means "it did not, and the window is as it was". Both used to come back as
  // `duplicate_action`, so the sentence that followed a retired action told the
  // model to observe for a change that provably had not happened — directly
  // contradicting the refusal it had just been given, which said the frame was
  // still current and observing again was the round trip to skip.
  | 'retired_action'
  | 'action_not_claimed';

export type CuaActionClaimResult = { ok: true } | { ok: false; reason: CuaActionRejectionReason };

export type CuaActionConfirmationResult =
  | { ok: true; epoch: number }
  | { ok: false; reason: CuaActionRejectionReason };

export class CuaFrameState {
  private epoch = 0;
  private currentFrame: CuaObservation | undefined;
  private readonly claimedActions = new Set<string>();
  private readonly consumedActions = new Set<string>();
  /**
   * The subset of `consumedActions` that never reached the window.
   *
   * Kept apart because the two produce opposite instructions, and the model was
   * being given the wrong one half the time.
   */
  private readonly retiredActions = new Set<string>();

  constructor(private readonly createFrameId: (epoch: number) => string = () => randomUUID()) {}

  observe(snapshot: CuaObservationSnapshot): CuaObservation {
    const frame = {
      frameId: this.createFrameId(this.epoch),
      epoch: this.epoch,
      ...snapshot,
    };
    this.currentFrame = frame;
    this.claimedActions.clear();
    return frame;
  }

  activeObservation(): CuaObservation | undefined {
    return this.currentFrame;
  }

  invalidate(): number {
    this.epoch += 1;
    this.currentFrame = undefined;
    this.claimedActions.clear();
    return this.epoch;
  }

  claimAction(action: CuaBoundAction): CuaActionClaimResult {
    if (this.consumedActions.has(action.fingerprint)) {
      return {
        ok: false,
        reason: this.retiredActions.has(action.fingerprint) ? 'retired_action' : 'duplicate_action',
      };
    }
    const rejection = this.validateAction(action);
    if (rejection) return { ok: false, reason: rejection };
    if (this.claimedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'duplicate_action' };
    }
    this.claimedActions.add(action.fingerprint);
    return { ok: true };
  }

  confirmAction(action: CuaBoundAction): CuaActionConfirmationResult {
    const rejection = this.validateAction(action);
    if (rejection) return { ok: false, reason: rejection };
    if (!this.claimedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'action_not_claimed' };
    }
    this.consumedActions.add(action.fingerprint);
    this.retiredActions.delete(action.fingerprint);
    return { ok: true, epoch: this.invalidate() };
  }

  /**
   * Record that an action was tried and leave the frame alive.
   *
   * For a refusal the executor never dispatched. `confirmAction` invalidates,
   * because an action that ran may have changed the window the frame describes
   * — but one that was refused before any dispatch changed nothing, and
   * invalidating on its behalf costs the model an `observe` to get back a frame
   * that was never stale. Measured on a real save-as-PDF run: three rounds of
   * `click_element` → refused → `click_element` → `reobserve_required` →
   * `observe`, 9 of 23 calls, before it found the route.
   *
   * The action is still retired rather than released, so sending the same one
   * again is `duplicate_action` — which is the truth, and is a better answer
   * than letting it be refused identically forever.
   */
  retireAction(action: CuaBoundAction): CuaActionConfirmationResult {
    const rejection = this.validateAction(action);
    if (rejection) return { ok: false, reason: rejection };
    if (!this.claimedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'action_not_claimed' };
    }
    this.claimedActions.delete(action.fingerprint);
    this.consumedActions.add(action.fingerprint);
    this.retiredActions.add(action.fingerprint);
    return { ok: true, epoch: this.epoch };
  }

  isConsumed(frame: CuaFrameIdentity, actionFingerprint: string): boolean {
    return this.consumedActions.has(
      bindCuaAction(frame, actionFingerprint, this.requireTarget(frame)).fingerprint,
    );
  }

  /**
   * Whether a consumed action was retired rather than dispatched.
   *
   * The companion to `isConsumed`, for the pre-check that refuses a repeat
   * before it is bound: "already sent" and "already refused without being sent"
   * are the same lookup and opposite instructions.
   */
  wasRetired(frame: CuaFrameIdentity, actionFingerprint: string): boolean {
    return this.retiredActions.has(
      bindCuaAction(frame, actionFingerprint, this.requireTarget(frame)).fingerprint,
    );
  }

  private requireTarget(frame: CuaFrameIdentity): ComputerUseWindowIdentity {
    if (
      this.currentFrame &&
      this.currentFrame.frameId === frame.frameId &&
      this.currentFrame.epoch === frame.epoch
    ) {
      return this.currentFrame.target;
    }
    return { pid: -1, windowId: -1 };
  }

  private validateAction(action: CuaBoundAction): CuaActionRejectionReason | undefined {
    if (fingerprintBoundAction(action) !== action.fingerprint) {
      return 'invalid_binding';
    }
    if (!this.currentFrame) return 'no_active_frame';
    if (action.epoch !== this.epoch) return 'stale_epoch';
    if (action.frameId !== this.currentFrame.frameId) return 'stale_frame';
    return undefined;
  }
}

export function bindCuaAction(
  frame: CuaFrameIdentity,
  actionFingerprint: string,
  target: ComputerUseWindowIdentity,
  binding: Omit<
    ComputerUseBoundAction,
    keyof CuaFrameIdentity | 'actionFingerprint' | 'target'
  > = {},
): CuaBoundAction {
  const action: CuaBoundAction = {
    ...frame,
    actionFingerprint,
    target,
    ...binding,
    fingerprint: '',
  };
  return { ...action, fingerprint: fingerprintBoundAction(action) };
}

export function fingerprintCuaAction(action: CuAction): string {
  return JSON.stringify(action);
}

export function fingerprintCuaSemanticAction(
  type: string,
  elementId?: string,
  value?: string,
): string {
  return JSON.stringify([type, elementId, value]);
}

/**
 * Where the cursor should be shown for an element action, from the element's
 * own observed frame.
 *
 * Element frames arrive in the same screen coordinates as the window's bounds
 * — `validateSemanticElementVisibility` compares one against the other
 * directly — so the centre needs no transform, only the containment check that
 * validator applies. Outside the window the frame is stale or the element has
 * moved, and no point at all is better than sending the cursor somewhere the
 * action will be refused from anyway.
 */
function elementPresentationPoint(
  observation: CuaObservation,
  frame: ComputerUseRect | undefined,
): CuPoint | undefined {
  const bounds = observation.target.bounds;
  if (!frame || !bounds) return undefined;
  if (frame.width <= 0 || frame.height <= 0) return undefined;
  const point = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  if (point.x < bounds.x || point.x >= bounds.x + bounds.width) return undefined;
  if (point.y < bounds.y || point.y >= bounds.y + bounds.height) return undefined;
  return point;
}

export function bindCuaSemanticActionToObservation(
  observation: CuaObservation,
  input: {
    type: string;
    elementId?: string;
    value?: string;
    /** The observed frame of `elementId`, when the observation reported one. */
    elementFrame?: ComputerUseRect;
  },
): CuaBoundAction {
  const presentationScreenPoint = elementPresentationPoint(observation, input.elementFrame);
  return bindCuaAction(
    observation,
    fingerprintCuaSemanticAction(input.type, input.elementId, input.value),
    observation.target,
    {
      ...(input.elementId ? { elementId: input.elementId } : {}),
      ...(presentationScreenPoint ? { presentationScreenPoint } : {}),
    },
  );
}

export function bindCuaActionToObservation(
  observation: CuaObservation,
  action: CuAction,
): CuaBoundAction | undefined {
  const base = bindCuaAction(observation, fingerprintCuaAction(action), observation.target);
  if (action.type === 'zoom') {
    const start = bindWindowPoint(observation, {
      x: Math.min(action.region.x1, action.region.x2),
      y: Math.min(action.region.y1, action.region.y2),
    });
    const end = bindWindowPoint(observation, {
      x: Math.max(action.region.x1, action.region.x2),
      y: Math.max(action.region.y1, action.region.y2),
    });
    if (!start || !end) return undefined;
    return {
      ...finalizeBoundAction({
        ...base,
        sourceStartCoordinate: start,
        sourceCoordinate: end,
        windowStartCoordinate: start,
        windowCoordinate: end,
        coordinateSpace: 'window-screenshot-local',
      }),
    };
  }
  if ('coordinate' in action) {
    const end = bindWindowPoint(observation, action.coordinate);
    if (!end) return undefined;
    if (action.type === 'left_click_drag') {
      const start = bindWindowPoint(observation, action.startCoordinate);
      if (!start) return undefined;
      return finalizeBoundAction({
        ...base,
        sourceStartCoordinate: start,
        sourceCoordinate: end,
        windowStartCoordinate: start,
        windowCoordinate: end,
        coordinateSpace: 'window-screenshot-local',
      });
    }
    return finalizeBoundAction({
      ...base,
      sourceCoordinate: end,
      windowCoordinate: end,
      coordinateSpace: 'window-screenshot-local',
    });
  }
  return base;
}

function bindWindowPoint(observation: CuaObservation, point: CuPoint): CuPoint | undefined {
  const width = observation.screenshotWidthPx ?? observation.target.sourceBoundsPx?.width ?? 0;
  const height = observation.screenshotHeightPx ?? observation.target.sourceBoundsPx?.height ?? 0;
  return width > 0 &&
    height > 0 &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < width &&
    point.y < height
    ? point
    : undefined;
}

function finalizeBoundAction(
  action: Omit<CuaBoundAction, 'fingerprint'> & { fingerprint?: string },
): CuaBoundAction {
  const withPlaceholder = { ...action, fingerprint: '' };
  return {
    ...withPlaceholder,
    fingerprint: fingerprintBoundAction(withPlaceholder),
  };
}

function fingerprintBoundAction(
  action: Omit<CuaBoundAction, 'fingerprint'> | CuaBoundAction,
): string {
  return JSON.stringify([
    action.frameId,
    action.epoch,
    action.actionFingerprint,
    action.target.pid,
    action.target.windowId,
    action.elementId ?? null,
    action.sourceStartCoordinate ?? null,
    action.sourceCoordinate ?? null,
  ]);
}
