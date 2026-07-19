import { randomUUID } from 'node:crypto';
import type {
  ComputerUseBoundAction,
  ComputerUseFrameIdentity,
  ComputerUseObservationIdentity,
  ComputerUseWindowIdentity,
  CuAction,
  CuPoint,
} from '@maka/core';

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
      return { ok: false, reason: 'duplicate_action' };
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
    return { ok: true, epoch: this.invalidate() };
  }

  isConsumed(frame: CuaFrameIdentity, actionFingerprint: string): boolean {
    return this.consumedActions.has(
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

export function bindCuaSemanticActionToObservation(
  observation: CuaObservation,
  input: { type: string; elementId?: string; value?: string; sourceCoordinate?: CuPoint },
): CuaBoundAction {
  return bindCuaAction(
    observation,
    fingerprintCuaSemanticAction(input.type, input.elementId, input.value),
    observation.target,
    {
      ...(input.elementId ? { elementId: input.elementId } : {}),
      ...(input.sourceCoordinate
        ? {
            sourceCoordinate: input.sourceCoordinate,
            windowCoordinate: input.sourceCoordinate,
            coordinateSpace: 'window-screenshot-local' as const,
          }
        : {}),
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
