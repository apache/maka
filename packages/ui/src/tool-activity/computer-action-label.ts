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
 * Not the raw wire call, but the same dialect as it. `maka_computer` declares
 * `categoryHint: 'computer_use'`, and `ToolRuntime` replaces a Computer Use
 * call's arguments with `computerUseModelCallArgs(...)` before anything is
 * persisted or emitted — so `item.args` here is a `ComputerUseModelCallArgs`,
 * and it is the only argument shape any renderer can ever see. That projection
 * keeps every key the model sent, in the names the tool accepts: `window_id`
 * and `element_id`, not `windowId` and `elementId`.
 *
 * That distinction is load-bearing rather than cosmetic. This projection used
 * to use a host-only permission projection, which renames both keys, and a renderer
 * that reads the old names off the new projection does not fail — every
 * element action quietly falls back to "点击该元素", which is the exact defect
 * this file exists to remove. `SummaryKey` below is `keyof
 * ComputerUseModelCallArgs` so a stale name is a type error rather than a
 * silent `undefined`, and the runtime seam is pinned by name in
 * `computer-use-privacy-boundary.test.ts`.
 *
 * Values that came off the screen or out of a person's head are reduced to
 * their shape by that projection, and a named test enforces it:
 * `computer-use-privacy-boundary.test.ts` asserts that a `type` call's `text`
 * arrives as `<text>` in the persisted `tool_call`, the `tool_start` event and
 * the invocation record. `value` and `text` are therefore not available to this
 * function as anything a person would want read out, and no branch here
 * pretends otherwise: a label that reads "输入「你好」" could only ever come
 * from a fixture.
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

import { type ComputerUseModelCallArgs } from '@maka/core/computer-use';

import { type UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';
import { getToolActivityCopy, type ToolActivityCopy } from './copy.js';

/** True for a row produced by the Computer Use tool. */
export function isComputerTool(item: ToolActivityItem): boolean {
  return (
    item.toolName === 'maka_computer' ||
    item.toolName.endsWith('__maka_computer') ||
    item.activityKind === 'computer'
  );
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

export function computerActionTarget(
  item: ToolActivityItem,
  locale: UiLocale,
): string | undefined {
  if (!isComputerTool(item)) return undefined;
  const args = asRecord(item.args);
  if (!args) return undefined;
  const copy = getToolActivityCopy(locale).computer;
  const app = displayable(str(args, 'app'));
  if (app !== undefined) return copy.targetApp(app);
  const windowId = int(args, 'window_id');
  return windowId === undefined ? undefined : copy.targetWindow(windowId);
}

export function computerActionLabelIncludesTarget(item: ToolActivityItem): boolean {
  const args = asRecord(item.args);
  const action = str(args ?? {}, 'action');
  return (
    action === 'launch_app' ||
    action === 'screenshot' ||
    (action === 'observe' && str(args ?? {}, 'menu') === undefined)
  );
}

export function computerRunningLabel(
  items: readonly ToolActivityItem[],
  locale: UiLocale,
): string | undefined {
  let target: string | undefined;
  let active: ToolActivityItem | undefined;
  for (const item of items) {
    if (!isComputerTool(item)) continue;
    target = computerActionTarget(item, locale) ?? target;
    if (item.status === 'running') active = item;
  }
  if (!active) return undefined;
  const copy = getToolActivityCopy(locale).computer;
  const args = asRecord(active.args);
  const actionName = str(args ?? {}, 'action');
  if (actionName === 'element_sequence' && active.progress) {
    return copy.runningSequence(active.progress.current, active.progress.total, target);
  }
  const action = computerActionLabel(active, locale) ?? copy.fallback;
  return copy.runningAction(
    action,
    computerActionLabelIncludesTarget(active) ? undefined : target,
  );
}

/**
 * The keys the projection declares by name, and the only ones read below.
 *
 * Not `keyof ComputerUseModelCallArgs`: that interface carries an index
 * signature for every other argument the model sent, so `keyof` widens to
 * `string | number` and a stale camelCase name would type check again.
 * Filtering the index signature back out leaves only names the projection
 * spells out, so renaming one there is a build error here rather than a row
 * that quietly loses its target.
 */
type DeclaredArg<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: unknown;
};
type SummaryKey = DeclaredArg<ComputerUseModelCallArgs>;

function describeAction(
  args: Record<string, unknown>,
  copy: ToolActivityCopy['computer'],
): string | undefined {
  const action = str(args, 'action');
  const app = displayable(str(args, 'app'));
  const windowId = int(args, 'window_id');
  const elementId = identifier(str(args, 'element_id'));
  const element = elementId ? copy.element(elementId) : copy.elementUnknown;
  const menu = displayable(str(args, 'menu'));
  const sequenceSteps = Array.isArray(args.steps) ? args.steps.length : undefined;
  const windowAction = str(args, 'window_action');

  switch (action) {
    case 'list_apps':
      return copy.listApps;
    case 'launch_app':
      return app !== undefined ? copy.launchApp(app) : copy.launchAppUnknown;
    case 'observe':
      return menu !== undefined
        ? copy.observeMenu(menu)
        : app !== undefined
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
    case 'scroll_element':
      return copy.scrollElement(element);
    case 'element_sequence':
      return sequenceSteps !== undefined
        ? copy.elementSequence(sequenceSteps)
        : copy.elementSequenceUnknown;
    case 'window_action':
      return windowAction === 'move'
        ? copy.windowMove
        : windowAction === 'resize'
          ? copy.windowResize
          : windowAction === 'minimize'
            ? copy.windowMinimize
            : copy.windowAction;
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
 * An element id the row is willing to print, or `undefined`.
 *
 * The persisted projection keeps whatever the model sent under `element_id`,
 * redacted for secrets and bounded, and that is right for the model's own
 * record — it has to read back the call it made, wrong or not. A row is a
 * different surface. `e12` is an index into an observation and says which
 * control; free text under that key is either an accessibility label the model
 * copied off the screen or a mistake, and neither belongs in a sentence a
 * person reads. The row falls back to naming no element rather than printing
 * it, which is what the generic "点击该元素" is for.
 */
const ELEMENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
function identifier(value: string | undefined): string | undefined {
  return value !== undefined && ELEMENT_ID.test(value) ? value : undefined;
}

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
