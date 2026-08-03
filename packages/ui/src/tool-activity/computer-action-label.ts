/**
 * A readable row label for one `maka_computer` call, derived from the call's
 * own arguments.
 *
 * Every other tool's row reads as an action because its display name happens to
 * be a verb phrase ("加载工具组"). Computer Use's display name is a noun —
 * "Maka Computer" — so a turn that observed a window, clicked a button, and
 * observed again rendered three identical rows and the reader could not tell
 * which call did what.
 *
 * The label is derived, never declared: the model is not given an `intent`
 * field to write. Every word the model sees is owned by the runtime, and a free
 * text field would be one more place it can be wrong (and more tokens on every
 * call).
 *
 * ## What these arguments actually are
 *
 * Not the wire call. `maka_computer` declares `categoryHint: 'computer_use'`,
 * and `ToolRuntime.executeTool` replaces a Computer Use call's arguments with
 * `computerUseApprovalSummary(...)` before anything is persisted or emitted —
 * so `item.args` here is a `ComputerUseApprovalSummary`, and it is the only
 * argument shape any renderer can ever see. That projection carries
 * `{action, approvalClass, rememberForTurnAllowed, app?, windowId?,
 * observationId?, elementId?}`, in the projection's own casing.
 *
 * Everything else is withheld on purpose, and a named test enforces it:
 * `computer-use-privacy-boundary.test.ts` asserts that a `type` call's `text`
 * and a pointer call's `coordinate` reach neither the persisted `tool_call`,
 * the `tool_start` event, nor the invocation record. `value`, `text`,
 * `coordinate`, `duration`, `scroll_direction` and `region` are therefore not
 * available to this function, and no branch here pretends otherwise: a label
 * that reads "输入「你好」" could only ever come from a fixture.
 *
 * An element's human label is not available either, for a different reason.
 * `element_id` is an index into one observation, and the observation the UI can
 * see is the persisted projection (`persistedObservationText` in
 * `packages/runtime/src/computer-use-tools.ts`), a JSON header of
 * observation_id/app/pid/window_id/element_count with no element rows at all.
 * The labelled tree only ever exists in `modelText`, which is not persisted and
 * never reaches the renderer. So an element action names the element by id
 * ("点击元素 e12"), which still says what happened and to what, rather than
 * falling back to the tool name.
 */

import { type ComputerUseApprovalSummary, type UiLocale } from '@maka/core';
import type { ToolActivityItem } from '../materialize.js';
import { getToolActivityCopy, type ToolActivityCopy } from './copy.js';

/** True for a row produced by the Computer Use tool. */
export function isComputerTool(item: ToolActivityItem): boolean {
  return item.toolName === 'maka_computer' || item.activityKind === 'computer';
}

/**
 * The row label for a Computer Use call, or `undefined` for any other tool.
 *
 * A Computer Use call always gets a label — an unknown or missing `action`
 * still resolves to the generic "操作电脑", never to the tool's display name.
 */
export function computerActionLabel(
  item: ToolActivityItem,
  locale: UiLocale,
): string | undefined {
  if (!isComputerTool(item)) return undefined;
  const copy = getToolActivityCopy(locale).computer;
  const args = asRecord(item.args);
  if (!args) return copy.fallback;
  return describeAction(args, copy) ?? copy.fallback;
}

/** The projection's keys, named so a typo cannot silently read `undefined`. */
type SummaryKey = keyof ComputerUseApprovalSummary;

function describeAction(
  args: Record<string, unknown>,
  copy: ToolActivityCopy['computer'],
): string | undefined {
  const action = str(args, 'action');
  const app = displayable(str(args, 'app'));
  const windowId = int(args, 'windowId');
  const elementId = str(args, 'elementId');
  const element = elementId ? copy.element(elementId) : copy.elementUnknown;

  switch (action) {
    case 'list_apps':
      return copy.listApps;
    case 'observe':
      return app !== undefined
        ? copy.observeApp(app)
        : windowId !== undefined
          ? copy.observeWindow(windowId)
          : copy.observe;
    case 'screenshot':
      return app !== undefined
        ? copy.screenshotApp(app)
        : windowId !== undefined
          ? copy.screenshotWindow(windowId)
          : copy.screenshot;
    case 'click_element':
      return copy.clickElement(element);
    case 'set_value':
      return copy.setValue(element);
    case 'select_text':
      return copy.selectText(element);
    case 'secondary_action':
      return copy.secondaryAction(element);
    case 'press_key':
    case 'key':
      return copy.pressKey;
    case 'type':
      return copy.type;
    case 'hold_key':
      return copy.holdKey;
    case 'wait':
      return copy.wait;
    case 'zoom':
      return copy.zoom;
    case 'cursor_position':
      return copy.cursorPosition;
    case 'scroll':
      return copy.scroll;
    case 'mouse_move':
      return copy.pointer.move;
    case 'left_click':
      return copy.pointer.left;
    case 'right_click':
      return copy.pointer.right;
    case 'middle_click':
      return copy.pointer.middle;
    case 'double_click':
      return copy.pointer.double;
    case 'triple_click':
      return copy.pointer.triple;
    case 'left_mouse_down':
      return copy.pointer.down;
    case 'left_mouse_up':
      return copy.pointer.up;
    case 'left_click_drag':
      return copy.pointer.drag;
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(record: Record<string, unknown>, key: SummaryKey): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function int(record: Record<string, unknown>, key: SummaryKey): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Keep an app name short enough to stay on one row. */
const APP_CAP = 32;

/**
 * The projection already redacts and bounds `app` to 256 characters; a row is
 * narrower than that, so cap it again for layout rather than for safety.
 */
function displayable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = value.replace(/\s+/g, ' ').trim();
  if (safe.length === 0) return undefined;
  return safe.length > APP_CAP ? `${safe.slice(0, APP_CAP)}…` : safe;
}
