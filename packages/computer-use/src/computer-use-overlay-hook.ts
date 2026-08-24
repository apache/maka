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

import type { CuAction, CuPoint } from '@maka/core/computer-use';
import type {
  CuOverlayHook,
  CuOverlayHookContext,
  CuPresentationFence,
} from '@maka/runtime/computer-use-types';

export type CursorActionKind = 'move' | 'click' | 'drag' | 'scroll';

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

function beginCoordinateOf(action: CuAction): CuPoint | undefined {
  switch (action.type) {
    case 'left_click_drag':
      return action.startCoordinate;
    case 'mouse_move':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'scroll':
      return action.coordinate;
    default:
      return undefined;
  }
}

function endCoordinateOf(action: CuAction): CuPoint | undefined {
  switch (action.type) {
    case 'mouse_move':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'scroll':
    case 'left_click_drag':
      return action.coordinate;
    default:
      return undefined;
  }
}

function kindOf(action: CuAction): CursorActionKind {
  switch (action.type) {
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return 'click';
    case 'left_click_drag':
      return 'drag';
    case 'scroll':
      return 'scroll';
    default:
      return 'move';
  }
}

/**
 * Codex keeps its cursor above every other window while any of two reasons
 * holds — the target app is frontmost (or has a menu open), and the cursor has
 * just been launched to a new position — and only lets it sink into the
 * target's own layer once the target is genuinely the window under the cursor.
 *
 * Maka has one of those two reasons available and not the other. The launch
 * half is the sink's own business (the presentation layer is what knows when a
 * motion settles). The frontmost/covered half needs a per-observation record of
 * what is stacked over the target, which the runtime does not collect, so it is
 * deliberately not modelled here rather than declared as a field nothing sets.
 *
 * What is left is the ordering: with a window id to order against, the cursor
 * does not need a level to stay visible — its position in the target's own
 * z-order is what keeps it readable, exactly as it is for Codex. Staying
 * elevated on top of that is what put the cursor over the user's own windows.
 * With no window to order against there is nothing to sink to, so it stays up:
 * an unseen cursor is the failure this whole path exists to avoid.
 */
function keepElevated(context: CuOverlayHookContext): boolean {
  return context.targetWindowId === undefined;
}

export function createComputerUseOverlayHook(controller: OverlayCursorSink): CuOverlayHook {
  return {
    onActionBegin(action, context) {
      const declaredPoint = beginCoordinateOf(action);
      const screenPoint = context.presentationScreenPoint;
      if (!declaredPoint || !screenPoint) {
        controller.ensure(context.sessionId);
        return RESOLVED_PRESENTATION_FENCE;
      }
      return controller.move({
        actionId: context.toolCallId,
        sessionId: context.sessionId,
        screenX: screenPoint.x,
        screenY: screenPoint.y,
        kind: kindOf(action),
        instant: action.type !== 'mouse_move',
        keepElevated: keepElevated(context),
        ...(context.targetWindowId !== undefined ? { targetWindowId: context.targetWindowId } : {}),
      });
    },
    onActionEnd(action, result, context) {
      if (!endCoordinateOf(action)) return;
      if (!result?.outcome.ok) {
        controller.cancel({
          actionId: context.toolCallId,
          sessionId: context.sessionId,
        });
        return;
      }
      // Where the executor says the pointer ended, and failing that, where the
      // cursor was sent.
      //
      // Only the coordinate paths report a landing point; `runSemantic` returns
      // none, because an element action never resolves to a pointer position at
      // all. Requiring one meant every semantic action — the whole accessibility
      // path, which is the only path Maka dispatches on by default — ended in
      // `cancel()`. The cursor flew to the control and was then wiped instead of
      // landing on it, so what a person saw was an arrow crossing the screen and
      // vanishing, never touching anything.
      //
      // The fallback is not a guess: `presentationScreenPoint` is the point this
      // same action was addressed to, computed from the element's own frame.
      const screenPoint = result.resolvedScreenPoint ?? context.presentationScreenPoint;
      if (!screenPoint) {
        controller.cancel({
          actionId: context.toolCallId,
          sessionId: context.sessionId,
        });
        return;
      }
      const kind = kindOf(action);
      controller.complete({
        actionId: context.toolCallId,
        sessionId: context.sessionId,
        screenX: screenPoint.x,
        screenY: screenPoint.y,
        kind,
        pulse: result.outcome.ok && (kind === 'click' || kind === 'drag'),
        // `complete` raises the cursor for the landing, so it has to know
        // where to come back down to.
        ...(context.targetWindowId !== undefined ? { targetWindowId: context.targetWindowId } : {}),
      });
    },
  };
}
