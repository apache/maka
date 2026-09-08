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

import type {
  CuOverlayHook,
  CuOverlayHookContext,
  CuPresentationAction,
  CuPresentationFence,
} from '@maka/runtime/computer-use-types';

export type CursorActionKind = 'click' | 'scroll';

export interface CursorMoveInput {
  actionId: string;
  sessionId: string;
  screenX: number;
  screenY: number;
  kind: CursorActionKind;
  pressed?: boolean;
  instant?: boolean;
  /**
   * Keep the cursor at its top window level once this motion settles, instead
   * of letting it sink toward the target's own layer. Only an explicit `false`
   * lets it sink: a caller that says nothing has offered no evidence that the
   * target is exposed, and an unseen cursor is the worse failure.
   */
  keepElevated?: boolean;
  /**
   * The window a resting cursor should be ordered directly above.
   *
   * Absent when the action is not bound to a window, in which case the cursor
   * falls back to resting at a fixed level.
   */
  targetWindowId?: number;
}

export interface CursorCompleteInput extends CursorMoveInput {
  pulse: boolean;
}

export interface CursorCancelInput {
  actionId: string;
  sessionId: string;
}

export interface OverlayCursorSink {
  ensure(sessionId: string): void;
  move(input: CursorMoveInput): CuPresentationFence | void;
  complete(input: CursorCompleteInput): void;
  cancel(input: CursorCancelInput): void;
}

const RESOLVED_PRESENTATION_FENCE: CuPresentationFence = {
  readyForInteraction: Promise.resolve(),
  finished: Promise.resolve(),
};

function kindOf(action: CuPresentationAction): CursorActionKind | undefined {
  switch (action.type) {
    case 'click_element':
    case 'select_text':
    case 'secondary_action':
      return 'click';
    case 'scroll_element':
      return 'scroll';
    default:
      return undefined;
  }
}

/**
 * Codex keeps its cursor above every other window while any of two reasons
 * holds — the target app is frontmost (or has a menu open), and the cursor has
 * just been launched to a new position — and only lets it sink into the
 * target's own layer once the target is genuinely the window under the cursor.
 *
 * The launch half is the sink's own business. The covered half is the aim
 * point against `obscuringRects` from the last observation: a control on the
 * top edge can be visible while the middle of the window is buried, so a
 * non-empty rect list is not enough to stay up. Missing rects must not flip
 * window-bound cursors to stay-up — that is what put the cursor over the
 * user's own windows. With no window to order against there is nothing to
 * sink to, so it stays up: an unseen cursor is the failure this path exists
 * to avoid.
 */
function pointInRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function keepElevated(context: CuOverlayHookContext): boolean {
  if (context.targetWindowId === undefined) return true;
  const point = context.presentationScreenPoint;
  const rects = context.obscuringRects;
  if (!point || !rects || rects.length === 0) return false;
  return rects.some((rect) => pointInRect(point, rect));
}

export function createComputerUseOverlayHook(controller: OverlayCursorSink): CuOverlayHook {
  return {
    onActionBegin(action, context) {
      const kind = kindOf(action);
      const screenPoint = context.presentationScreenPoint;
      if (!kind || !screenPoint) {
        controller.ensure(context.sessionId);
        return RESOLVED_PRESENTATION_FENCE;
      }
      return controller.move({
        actionId: context.toolCallId,
        sessionId: context.sessionId,
        screenX: screenPoint.x,
        screenY: screenPoint.y,
        kind,
        instant: true,
        keepElevated: keepElevated(context),
        ...(context.targetWindowId !== undefined ? { targetWindowId: context.targetWindowId } : {}),
      });
    },
    onActionEnd(action, result, context) {
      const kind = kindOf(action);
      if (!kind) return;
      if (!result?.outcome.ok) {
        controller.cancel({
          actionId: context.toolCallId,
          sessionId: context.sessionId,
        });
        return;
      }
      const screenPoint = context.presentationScreenPoint;
      if (!screenPoint) {
        controller.cancel({
          actionId: context.toolCallId,
          sessionId: context.sessionId,
        });
        return;
      }
      controller.complete({
        actionId: context.toolCallId,
        sessionId: context.sessionId,
        screenX: screenPoint.x,
        screenY: screenPoint.y,
        kind,
        pulse: kind === 'click',
        // `complete` raises the cursor for the landing, so it has to know
        // where to come back down to.
        ...(context.targetWindowId !== undefined ? { targetWindowId: context.targetWindowId } : {}),
      });
    },
  };
}
