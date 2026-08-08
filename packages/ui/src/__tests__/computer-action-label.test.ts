import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { COMPUTER_USE_WITHHELD_VALUE, computerUseModelCallArgs } from '@maka/core';
import { ToolTrow } from '../tool-activity.js';
import { computerActionLabel, isComputerTool } from '../tool-activity/computer-action-label.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';

/**
 * A row exactly as the runtime produces one.
 *
 * The arguments handed in are the wire call the model made; what the row gets
 * is `computerUseModelCallArgs(...)` of it, because that is what `ToolRuntime`
 * puts on the `tool_start` event and in the persisted `tool_call` for any tool
 * declaring `categoryHint: 'computer_use'`.
 *
 * Every fixture in this file goes through that projection, which is the point,
 * and it has to be *that* projection rather than any projection. Hand-built
 * `args` let a label be asserted from a field the renderer can never receive:
 * with wire arguments written straight into the row, this suite passed while a
 * ten-click turn rendered ten rows reading "点击该元素". Running them through
 * the wrong projection is the same failure wearing a fixture — this file built
 * its rows with `computerUseApprovalSummary`, which spells the same fields
 * `windowId` and `elementId`, and stayed green through the seam being changed
 * underneath it.
 */
function computerCall(
  wireArgs: Record<string, unknown>,
  extra?: Partial<ToolActivityItem>,
): ToolActivityItem {
  return {
    toolUseId: `cu-${String(wireArgs.action)}`,
    toolName: 'maka_computer',
    displayName: 'Maka Computer',
    activityKind: 'computer',
    status: 'completed',
    args: computerUseModelCallArgs(wireArgs),
    ...extra,
  };
}

function label(wireArgs: Record<string, unknown>, locale: 'zh' | 'en' = 'zh'): string | undefined {
  return computerActionLabel(computerCall(wireArgs), locale);
}

function renderRows(items: ToolActivityItem[], locale: 'zh' | 'en' = 'zh'): string {
  return renderReactToStaticMarkup(
    createElement(LocaleProvider, {
      locale,
      children: createElement(ToolTrow, { items }) as ReactNode,
    }),
  );
}

describe('computer action label', () => {
  it('names each action from what the projection actually carries', () => {
    assert.equal(label({ action: 'list_apps' }), '列出打开的应用');
    assert.equal(label({ action: 'observe', app: '计算器' }), '观察「计算器」窗口');
    assert.equal(label({ action: 'observe', window_id: 42 }), '观察窗口 42');
    assert.equal(label({ action: 'screenshot', app: '计算器' }), '截图「计算器」窗口');
    assert.equal(label({ action: 'screenshot', window_id: 42 }), '截图窗口 42');
    assert.equal(label({ action: 'click_element', element_id: 'e12' }), '点击元素 e12');
    assert.equal(label({ action: 'set_value', element_id: 'e12', value: '你好' }), '设置值：元素 e12');
    assert.equal(label({ action: 'select_text', element_id: 'e12', text: 'abc' }), '选择文本：元素 e12');
    assert.equal(label({ action: 'secondary_action', element_id: 'e12', text: '复制' }), '次要操作：元素 e12');
    assert.equal(label({ action: 'press_key', text: 'Return' }), '按下按键');
    assert.equal(label({ action: 'left_click', coordinate: [120, 340] }), '点击');
    assert.equal(label({ action: 'right_click', coordinate: [1, 2] }), '右键点击');
    assert.equal(label({ action: 'double_click', coordinate: [1, 2] }), '双击');
    assert.equal(label({ action: 'triple_click', coordinate: [1, 2] }), '三击');
    assert.equal(label({ action: 'middle_click', coordinate: [1, 2] }), '中键点击');
    assert.equal(label({ action: 'mouse_move', coordinate: [1, 2] }), '移动指针');
    assert.equal(label({ action: 'left_mouse_down', coordinate: [1, 2] }), '按下鼠标');
    assert.equal(label({ action: 'left_mouse_up', coordinate: [1, 2] }), '松开鼠标');
    assert.equal(label({ action: 'left_click_drag', coordinate: [1, 2] }), '拖动');
    assert.equal(label({ action: 'type', text: '你好' }), '输入文本');
    assert.equal(label({ action: 'key', text: 'Return' }), '按下按键');
    assert.equal(label({ action: 'hold_key', text: 'Shift', duration: 2 }), '按住按键');
    assert.equal(label({ action: 'scroll', scroll_direction: 'up' }), '滚动');
    assert.equal(label({ action: 'wait', duration: 1.5 }), '等待');
    assert.equal(label({ action: 'zoom', region: [0, 0, 10, 10] }), '放大查看区域');
    assert.equal(label({ action: 'cursor_position' }), '读取指针位置');
  });

  /**
   * The one row that separates two clicks in the same turn. `element_id` is the
   * only target-naming field that survives to the renderer, so a label that
   * cannot read it is the ten-identical-rows defect itself.
   */
  it('tells two element actions in the same turn apart', () => {
    const seven = label({
      action: 'click_element',
      app: 'Calculator',
      window_id: 7,
      observation_id: 'frame-1',
      element_id: 'e7',
    });
    const nine = label({
      action: 'click_element',
      app: 'Calculator',
      window_id: 7,
      observation_id: 'frame-1',
      element_id: 'e9',
    });
    assert.equal(seven, '点击元素 e7');
    assert.equal(nine, '点击元素 e9');
    assert.notEqual(seven, nine);
  });

  /**
   * The persisted projection keeps whatever the model sent under `element_id`,
   * because the model has to read back the call it made. The row does not: an
   * accessibility label the model copied off the screen is not an index into an
   * observation, and it has no business in a sentence a person reads.
   */
  it('drops an element id that is free text rather than an identifier', () => {
    const args = computerUseModelCallArgs({
      action: 'click_element',
      element_id: 'Customer SSN 123-45-6789',
    });
    // The projection carries it — this is the renderer's own refusal, not the
    // projection's, so it has to be asserted against a projection that kept it.
    assert.equal(args.element_id, 'Customer SSN 123-45-6789');
    assert.equal(label({ action: 'click_element', element_id: 'Customer SSN 123-45-6789' }), '点击该元素');
  });

  /**
   * Not a preference: `computer-use-privacy-boundary.test.ts` asserts that a
   * typed value reaches neither the persisted call nor the event as anything
   * but its shape. A row that spelled one out would be reading a field that
   * does not exist outside a fixture.
   */
  it('never spells out a value the privacy boundary withholds', () => {
    const args = computerUseModelCallArgs({
      action: 'set_value',
      element_id: 'e1',
      value: 'sk-abcdefghijklmnopqrstuvwx',
      coordinate: [123, 456],
    });
    assert.deepEqual(Object.keys(args).sort(), [
      'action',
      'coordinate',
      'element_id',
      'value',
    ]);
    // The written value never crosses; only its shape does. Matched against the
    // pattern the tool refuses on rather than a literal, so the claim is "this
    // is a withheld placeholder" and not "the placeholder is spelled this way" —
    // the spelling gained a length after this test was written, and pinning it
    // reddened here for a change that was correct.
    const written = args.value;
    assert.equal(typeof written, 'string');
    assert.match(written as string, COMPUTER_USE_WITHHELD_VALUE);
    assert.equal((written as string).includes('abcdefghijklmnop'), false);
    const row = computerActionLabel(computerCall({
      action: 'set_value',
      element_id: 'e1',
      value: 'sk-abcdefghijklmnopqrstuvwx',
      coordinate: [123, 456],
    }), 'zh');
    assert.equal(row, '设置值：元素 e1');
    assert.doesNotMatch(row ?? '', /abcdefghijklmnop|123|456/);
  });

  it('falls back to something that still says what happened, never to the tool name', () => {
    // No element_id: the action is still named, the target is generic.
    assert.equal(label({ action: 'click_element' }), '点击该元素');
    assert.equal(label({ action: 'observe' }), '观察当前窗口');
    // Unknown, missing, and malformed arguments all land on the generic verb —
    // the noun "Maka Computer" is never the answer for a CU row.
    assert.equal(label({ action: 'teleport' }), '操作电脑');
    assert.equal(label({}), '操作电脑');
    assert.equal(computerActionLabel(computerCall({}, { args: 'not-an-object' }), 'zh'), '操作电脑');
    assert.equal(computerActionLabel(computerCall({}, { args: undefined }), 'zh'), '操作电脑');
  });


  /**
   * A declared `intent` and a derived label are no longer competing for one
   * slot. Astryx gives a row a `name` and a `target`; the derived label is the
   * name and the backend's intent is the target, so the Pi backend path keeps
   * its words and a CU row still says which call it was.
   */
  it('keeps a declared intent visible alongside the derived label', () => {
    const markup = renderRows([
      computerCall({ action: 'click_element', element_id: 'e12' }, { intent: '点击等号' }),
    ]);
    assert.match(markup, /点击等号/);
    assert.match(markup, /点击元素 e12/);
  });

  it('names a call that declares its kind rather than the CU tool name', () => {
    // `activityKind: 'computer'` is legal on the wire and is what every other
    // builtin declares. Recognised only by tool name, a renamed or wrapped CU
    // tool fell through to the tool's own noun.
    const wrapped: ToolActivityItem = {
      toolUseId: 'x',
      toolName: 'some_other_name',
      activityKind: 'computer',
      status: 'completed',
      args: computerUseModelCallArgs({ action: 'click_element', element_id: 'e7' }),
    };
    assert.equal(isComputerTool(wrapped), true);
    assert.equal(computerActionLabel(wrapped, 'zh'), '点击元素 e7');
    assert.equal(
      isComputerTool({ toolUseId: 'y', toolName: 'Bash', status: 'completed', args: {} }),
      false,
    );
  });

  it('renders one turn of Computer Use as three rows that read differently', () => {
    const markup = renderRows([
      computerCall({ action: 'observe', app: '计算器' }, { toolUseId: 'cu-1' }),
      computerCall({ action: 'click_element', element_id: 'e7' }, { toolUseId: 'cu-2' }),
      computerCall({ action: 'observe', app: '计算器' }, { toolUseId: 'cu-3' }),
    ]);

    // What the row must say, not how many times the renderer happens to say it.
    // An exact occurrence count pins the component's internals — a collapsed
    // detail body, a title attribute — none of which is the claim being made.
    assert.match(markup, /观察「计算器」窗口/);
    assert.match(markup, /点击元素 e7/);
    // The regression this fixes: three identical noun rows.
    assert.doesNotMatch(markup, /Maka Computer/);
    // And that they are genuinely different from one another, which is the
    // whole point — one label reaching the markup would satisfy the two
    // matches above on its own.
    const labels = [
      computerActionLabel(computerCall({ action: 'observe', app: '计算器' }), 'zh'),
      computerActionLabel(computerCall({ action: 'click_element', element_id: 'e7' }), 'zh'),
    ];
    assert.equal(new Set(labels).size, 2, 'two different actions must read differently');
  });
});
