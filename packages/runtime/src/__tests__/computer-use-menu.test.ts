// The menu bar as the model reads it.
//
// Against a five-model, six-task real-machine matrix, three of the four tasks
// that failed for every model failed on one fact: no observation this executor
// produced contained a single menu element. Save as PDF, find in project and
// rotate image are menu commands and nothing in a window reaches them.
//
// Shipping the menu is not the same as shipping it usably. A whole menu bar is
// larger than most windows — TextEdit's is 369 elements against 16 — so what is
// asserted here is the shape that makes it affordable to carry on every
// observation, and the sentence without which a model cannot act on it.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderObservationForModel,
  renderObservationText,
} from '../computer-use-observation-text.js';
import type { CuObservation, CuObservedElement } from '../computer-use-types.js';

function element(
  elementId: string,
  role: string,
  extra: Partial<CuObservedElement> = {},
): CuObservedElement {
  return { elementId, role, ...extra };
}

/** A window with a menu bar beside it, shaped the way maka-cu reports one. */
function observation(overrides: Partial<CuObservation> = {}): CuObservation {
  return {
    observationId: 'obs_1',
    appId: 'com.apple.TextEdit',
    pid: 1,
    windowId: 2,
    elements: [
      element('0', 'AXWindow', { label: 'note.txt' }),
      element('1', 'AXTextArea', { parentElementId: '0', value: 'hi' }),
      // An ordinary window control whose role starts with AXMenu. TextEdit has
      // one: 文稿操作. Splitting the menu out by role prefix would move it.
      element('2', 'AXMenuButton', { parentElementId: '0', label: '文稿操作' }),
      element('3', 'AXMenuBar'),
      element('4', 'AXMenuBarItem', { parentElementId: '3', label: '文件' }),
      element('5', 'AXMenu', { parentElementId: '4' }),
      element('6', 'AXMenuItem', { parentElementId: '5', label: '新建' }),
      element('7', 'AXMenuItem', { parentElementId: '5', enabled: false }),
      element('8', 'AXMenuItem', { parentElementId: '5', label: '导出为PDF…', enabled: false }),
      element('9', 'AXMenuBarItem', { parentElementId: '3', label: '编辑' }),
    ],
    ...overrides,
  } as CuObservation;
}

test('a window control whose role begins with AXMenu stays in the window', () => {
  const text = renderObservationForModel(observation());
  const [windowPart, menuPart] = text.split(/^menu_bar=/m);
  assert.match(windowPart ?? '', /文稿操作/);
  assert.doesNotMatch(menuPart ?? '', /文稿操作/);
  // And the header counts the window, not the whole observation: a model told
  // `elements=10` and shown two lists cannot tell which number it was.
  assert.match(text, /elements=3$/m);
});

test('the empty container between a menu title and its commands is gone', () => {
  const text = renderObservationForModel(observation());
  // `AXMenu` carries no name, no state and nothing to act on. Removing it is
  // what makes an opened menu read the way a menu looks.
  assert.doesNotMatch(text, /AXMenu\b(?!Bar|Item|Button)/);
  const lines = text.split('\n');
  const title = lines.findIndex((line) => line.includes('"文件"'));
  const command = lines.findIndex((line) => line.includes('"新建"'));
  assert.ok(title >= 0 && command > title);
  // One level of indentation between them, not two.
  const depth = (line: string) => line.match(/^\t*/)?.[0].length ?? 0;
  assert.equal(depth(lines[command] ?? ''), depth(lines[title] ?? '') + 1);
});

test('a separator is not written down, and the command after it keeps its id', () => {
  const text = renderObservationForModel(observation());
  // An unnamed, disabled, actionless, childless AXMenuItem is AppKit's
  // separator line. TextEdit's 文件 menu is 8 of 42, its 格式 menu 11 of 72.
  assert.doesNotMatch(text, /^\s*7 AXMenuItem\s*$/m);
  // The rule is narrower than "drop what has no label", which was measured
  // against window trees and rejected: 1,023 unnamed but operable elements
  // across ten applications, and no pixel fallback to reach one that was hid.
  assert.match(text, /8 AXMenuItem "导出为PDF…" \[disabled\]/);
});

test('a listed menu says that it opens, and how', () => {
  const text = renderObservationForModel(observation());
  // Without this a model reads a list of menu names as a list of things that
  // cannot be used, and the round trip that would open one is never spent.
  assert.match(text, /menu_bar=2/);
  assert.match(text, /not_opened/);
  assert.match(text, /menu="<title>"/);
});

test('an opened menu names itself rather than repeating the offer', () => {
  const text = renderObservationForModel(
    observation({ menu: { opened: '文件' } } as Partial<CuObservation>),
  );
  assert.match(text, /opened="文件"/);
  assert.doesNotMatch(text, /not_opened/);
});

test('a disabled command is explained once, not left to be retried', () => {
  const text = renderObservationForModel(observation());
  // Measured: TextEdit in the background has 52 of 250 menu items enabled and
  // 168 in front, and the 116 that change are 存储, 导出为PDF…, 页面设置… —
  // the commands a task is usually about. `AXPress` on one returns success and
  // does nothing, so a model not told this reads the refusal as its own error.
  assert.match(text, /needs its application in front/);
});

test('a menu with nothing disabled is not given the explanation', () => {
  const all = observation();
  const text = renderObservationForModel({
    ...all,
    elements: all.elements.filter((e) => e.enabled !== false),
  });
  assert.doesNotMatch(text, /needs its application in front/);
});

test('a menu cut short by the executor says so, and a menu merely unopened does not', () => {
  const cut = renderObservationForModel(
    observation({ menu: { opened: '文件', truncated: true } } as Partial<CuObservation>),
  );
  assert.match(cut, /truncated=true\(this menu was cut short/);
  // Stopping at the bar is the shape the host asked for. Reporting it as a
  // truncation would present the host's own request to the model as a limit of
  // the machine, and send it looking for a command that was never below.
  assert.doesNotMatch(renderObservationForModel(observation()), /truncated=true\(this menu/);
});

test('a wrapper around exactly one thing is collapsed, and its child keeps its id', () => {
  // `mergeSingleItemGroups`, which is one of the thirteen transforms Codex's own
  // renderer runs. Measured here: VS Code 172 of 985 elements, Calculator 4 of
  // 42, TextEdit 1 of 20 — and Finder 1 of 1,198, because Finder's containers
  // mostly hold several children and holding several is a statement that they
  // belong together.
  const text = renderObservationForModel({
    observationId: 'obs_1',
    appId: 'a',
    pid: 1,
    windowId: 2,
    elements: [
      element('0', 'AXWindow', { label: 'w' }),
      element('1', 'AXGroup', { parentElementId: '0' }),
      element('2', 'AXGroup', { parentElementId: '1' }),
      element('3', 'AXButton', { parentElementId: '2', label: 'Save' }),
    ],
  } as CuObservation);
  const rows = text.split('\n');
  assert.equal(rows.length, 3, 'header, window, button');
  // Collapsing is not pruning: the button keeps the id it was minted with, so
  // anything the model was already holding still addresses it.
  assert.match(rows[2] ?? '', /^\t3 AXButton "Save"$/);
});

test('a container holding several children is collapsed too, and the strict form is reachable', () => {
  // Holding several children once read as a statement that they belong
  // together, and that reading did not survive being measured: lifting the
  // children erases a line, not an element, and the relaxed rule keeps every
  // operated element and every named ancestor at 87% of the tokens. The strict
  // rule stays reachable because the offline evaluator baselines against it.
  const sample = {
    observationId: 'obs_1',
    appId: 'a',
    pid: 1,
    windowId: 2,
    elements: [
      element('0', 'AXWindow', { label: 'w' }),
      element('1', 'AXGroup', { parentElementId: '0' }),
      element('2', 'AXButton', { parentElementId: '1', label: 'A' }),
      element('3', 'AXButton', { parentElementId: '1', label: 'B' }),
    ],
  } as CuObservation;
  assert.doesNotMatch(renderObservationForModel(sample), /1 AXGroup/);
  assert.match(renderObservationText(sample, { multiChildWrappers: false }), /1 AXGroup/);
});

test('a single-child wrapper that is a control, or named, or focused, stays', () => {
  // Every clause of the test is load-bearing, and each of these would have been
  // collapsed by a rule that only asked "does it have a label".
  for (const extra of [
    { label: 'Sidebar' },
    { actions: ['raise'] },
    { focused: true },
    { value: '3' },
  ] as Array<Partial<CuObservedElement>>) {
    const text = renderObservationForModel({
      observationId: 'obs_1',
      appId: 'a',
      pid: 1,
      windowId: 2,
      elements: [
        element('0', 'AXWindow', { label: 'w' }),
        element('1', 'AXGroup', { parentElementId: '0', ...extra }),
        element('2', 'AXButton', { parentElementId: '1', label: 'Save' }),
      ],
    } as CuObservation);
    assert.match(text, /1 AXGroup/, `collapsed a group carrying ${JSON.stringify(extra)}`);
  }
});

test('a button with no label is not a wrapper, whatever it contains', () => {
  // TextEdit's full-screen button holds one anonymous group and carries no
  // label of its own. A rule written as "unnamed and holds one thing" collapses
  // the button; this one keeps it, because a button is not a container role.
  const text = renderObservationForModel({
    observationId: 'obs_1',
    appId: 'a',
    pid: 1,
    windowId: 2,
    elements: [
      element('0', 'AXWindow', { label: 'w' }),
      element('1', 'AXButton', { parentElementId: '0', subrole: 'AXFullScreenButton' }),
      element('2', 'AXGroup', { parentElementId: '1' }),
    ],
  } as CuObservation);
  assert.match(text, /1 AXButton/);
});
