import type { CuAction, CuPoint } from '@maka/core';
import type { CuOverlayHook, CuOverlayHookContext, CuPresentationFence } from '@maka/runtime';

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
 * A covered target is therefore a reason to stay HIGH, not to disappear: while
 * the cursor is travelling it is deliberately drawn on top of whatever covers
 * the target.
 *
 * The launch half is the sink's own business (the presentation layer is what
 * knows when a motion settles). This is the observation half: stay elevated
 * unless the target is both stacked under something and exposed at the point
 * the cursor is heading for. With no stacking evidence at all, stay elevated —
 * an unseen cursor is the failure this whole path exists to avoid.
 */
function keepElevated(context: CuOverlayHookContext): boolean {
  const stacking = context.targetStacking;
  if (!stacking) return true;
  return stacking.frontmost || stacking.destinationCovered;
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
      const screenPoint = result?.resolvedScreenPoint;
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
      });
    },
  };
}
