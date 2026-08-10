// Behavior contract for how an observation is written for the model.
//
// The format follows Codex's Computer Use — one indented line per element,
// containment carried by indentation — with the protocol fields Maka needs and
// Codex does not have. What is asserted here is mostly what must NOT happen:
// nothing dropped, nothing ambiguous, and no way for one element's text to be
// read as two.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderObservationForModel,
  renderObservationText,
} from '../computer-use-observation-text.js';
import type { CuObservation, CuObservedElement } from '../computer-use-types.js';

function observation(elements: CuObservedElement[]): CuObservation {
  return {
    observationId: 'obs_1',
    appId: 'com.apple.Safari',
    pid: 988,
    windowId: 45,
    windowTitle: 'Activity Monitor',
    elements,
  };
}

function lines(text: string): string[] {
  return text.split('\n');
}

test('the header carries what the model must quote back', () => {
  const text = renderObservationForModel(observation([]));
  const [head] = lines(text);
  assert.match(head ?? '', /^observation_id=obs_1 /);
  assert.match(head ?? '', /app=com\.apple\.Safari/);
  assert.match(head ?? '', /window_id=45/);
  assert.match(head ?? '', /window="Activity Monitor"/);
  assert.match(head ?? '', /elements=0/);
});

test('an element line reads id, role, label, value, state, frame', () => {
  const text = renderObservationForModel(
    observation([
      {
        elementId: '7',
        role: 'AXTextField',
        label: 'Search',
        value: 'hello',
        enabled: false,
        selected: true,
        frame: { x: 100.4, y: 200.6, width: 80, height: 30 },
      },
    ]),
  );
  assert.equal(
    lines(text)[1],
    '7 AXTextField "Search" ="hello" [disabled,selected] @100,201 80x30',
  );
});

test('only the informative half of each state is written', () => {
  // Every element is enabled and unselected unless the driver says otherwise.
  // Writing that out for all of them costs tokens to say nothing.
  const text = renderObservationForModel(
    observation([{ elementId: '1', role: 'AXButton', enabled: true, selected: false }]),
  );
  assert.equal(lines(text)[1], '1 AXButton');
});

test('containment is indentation, and the parent link is not repeated as a field', () => {
  const text = renderObservationForModel(
    observation([
      { elementId: '0', role: 'AXWindow' },
      { elementId: '1', role: 'AXToolbar', parentElementId: '0' },
      { elementId: '2', role: 'AXButton', label: 'Save', parentElementId: '1' },
      { elementId: '3', role: 'AXButton', label: 'Close', parentElementId: '0' },
    ]),
  );
  assert.deepEqual(lines(text).slice(1), [
    '0 AXWindow',
    '\t1 AXToolbar',
    '\t\t2 AXButton "Save"',
    '\t3 AXButton "Close"',
  ]);
  assert.doesNotMatch(text, /parent_element_id/);
});

test('an element whose parent was pruned away is still written', () => {
  // The driver prunes, so a reported child can outlive its reported parent.
  // Hiding it to keep the tree tidy would hide a real target.
  const text = renderObservationForModel(
    observation([{ elementId: '9', role: 'AXButton', label: 'Orphan', parentElementId: '404' }]),
  );
  assert.deepEqual(lines(text).slice(1), ['9 AXButton "Orphan"']);
});

test('a parent cycle neither loops nor loses an element', () => {
  const text = renderObservationForModel(
    observation([
      { elementId: 'a', role: 'AXGroup', parentElementId: 'b' },
      { elementId: 'b', role: 'AXGroup', parentElementId: 'a' },
      { elementId: 'c', role: 'AXButton', label: 'Reachable' },
    ]),
  );
  const body = lines(text).slice(1);
  assert.equal(body.length, 3);
  for (const id of ['a', 'b', 'c']) {
    assert.ok(
      body.some((line) => line.trimStart().startsWith(`${id} `)),
      `${id} must appear exactly once`,
    );
  }
});

test('an element that is its own parent is a root, not a hang', () => {
  const text = renderObservationForModel(
    observation([{ elementId: '5', role: 'AXGroup', parentElementId: '5' }]),
  );
  assert.deepEqual(lines(text).slice(1), ['5 AXGroup']);
});

test('a post-action no-change observation says so without repeating the tree', () => {
  const text = renderObservationForModel({
    ...observation([{ elementId: '0', role: 'AXWindow', label: 'Main' }]),
    renderDifference: true,
    difference: {
      baseObservationId: 'obs_0',
      presentation: 'no-change',
      changes: [],
      removedStableIdRanges: [],
    },
  });

  assert.deepEqual(lines(text).slice(1), [
    'no_change=true(the window has no effective accessibility changes since obs_0)',
  ]);
});

test('a post-action difference renders removed ranges and changed elements only', () => {
  const text = renderObservationForModel({
    ...observation([
      { elementId: '10', role: 'AXWindow', label: 'Main' },
      { elementId: '12', role: 'AXButton', label: 'Inserted', parentElementId: '10' },
      { elementId: '13', role: 'AXStaticText', value: 'Updated', parentElementId: '10' },
      { elementId: '99', role: 'AXButton', label: 'Unchanged', parentElementId: '10' },
    ]),
    renderDifference: true,
    difference: {
      baseObservationId: 'obs_0',
      presentation: 'difference',
      changes: [
        { kind: 'remove', path: [0, 0], stableId: 7 },
        { kind: 'insert', path: [0, 1], stableId: 12, elementId: '12' },
        { kind: 'update', path: [0, 2], stableId: 13, elementId: '13' },
      ],
      removedStableIdRanges: [
        { start: 4, end: 6 },
        { start: 7, end: 7 },
      ],
    },
  });

  assert.deepEqual(lines(text).slice(1), [
    'removed_element_ids=4-6,7',
    '\tchange=insert 12 AXButton "Inserted"',
    '\tchange=update 13 AXStaticText ="Updated"',
  ]);
  assert.doesNotMatch(text, /Unchanged/);
});

test('a full difference presentation falls back to the complete tree', () => {
  const text = renderObservationForModel({
    ...observation([
      { elementId: '10', role: 'AXWindow', label: 'Main' },
      { elementId: '11', role: 'AXButton', label: 'Save', parentElementId: '10' },
    ]),
    renderDifference: true,
    difference: {
      baseObservationId: 'obs_0',
      presentation: 'full',
      changes: [],
      removedStableIdRanges: [{ start: 4, end: 9 }],
    },
  });

  assert.deepEqual(lines(text).slice(1), ['10 AXWindow "Main"', '\t11 AXButton "Save"']);
  assert.doesNotMatch(text, /removed_element_ids/);
});

test('every element appears exactly once regardless of report order', () => {
  // The driver reports in its own order; children can precede parents.
  const elements: CuObservedElement[] = [
    { elementId: '2', role: 'AXButton', parentElementId: '1' },
    { elementId: '1', role: 'AXToolbar', parentElementId: '0' },
    { elementId: '0', role: 'AXWindow' },
  ];
  const body = lines(renderObservationForModel(observation(elements))).slice(1);
  assert.deepEqual(body, ['0 AXWindow', '\t1 AXToolbar', '\t\t2 AXButton']);
});

test('a label containing a quote or newline cannot forge a second element line', () => {
  const text = renderObservationForModel(
    observation([{ elementId: '1', role: 'AXButton', label: 'say "hi"\n2 AXButton "Delete"' }]),
  );
  assert.equal(lines(text).length, 2, 'one header, one element');
  assert.equal(lines(text)[1], '1 AXButton "say \\"hi\\"\\n2 AXButton \\"Delete\\""');
});

test('an oversized value is shortened visibly, not silently', () => {
  const value = 'x'.repeat(300);
  const text = renderObservationForModel(
    observation([{ elementId: '1', role: 'AXTextArea', value }]),
  );
  assert.match(lines(text)[1] ?? '', /…\(\+44 chars\)"$/);
  assert.ok((lines(text)[1] ?? '').length < 320);
});

test('an empty value is written, because empty is not the same as absent', () => {
  const text = renderObservationForModel(
    observation([
      { elementId: '1', role: 'AXTextField', value: '' },
      { elementId: '2', role: 'AXTextField' },
    ]),
  );
  assert.deepEqual(lines(text).slice(1), ['1 AXTextField =""', '2 AXTextField']);
});

test('the compact form is substantially smaller than the JSON it replaces', () => {
  // A window at the driver's 500-element ceiling, shaped like a real one:
  // a window, a toolbar, and rows of labelled controls.
  const elements: CuObservedElement[] = [{ elementId: '0', role: 'AXWindow', label: 'Main' }];
  for (let index = 1; index < 500; index += 1) {
    elements.push({
      elementId: String(index),
      role: index % 3 === 0 ? 'AXStaticText' : 'AXButton',
      label: `Control number ${index}`,
      enabled: true,
      selected: false,
      parentElementId: index > 1 ? String(index - 1) : '0',
      frame: { x: 100 + index, y: 200 + index, width: 80, height: 30 },
    });
  }
  const target = observation(elements);

  const previous = JSON.stringify({
    observation_id: target.observationId,
    app: target.appId,
    pid: target.pid,
    window_id: target.windowId,
    window_title: target.windowTitle,
    elements: target.elements.map((element) => ({
      element_id: element.elementId,
      role: element.role,
      ...(element.label ? { label: element.label } : {}),
      ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.enabled !== undefined ? { enabled: element.enabled } : {}),
      ...(element.selected !== undefined ? { selected: element.selected } : {}),
      ...(element.parentElementId !== undefined
        ? { parent_element_id: element.parentElementId }
        : {}),
      ...(element.frame ? { frame: element.frame } : {}),
    })),
  });
  const compact = renderObservationForModel(target);

  // Reported rather than merely asserted: a regression here is a cost
  // regression, and the number is the point of the change.
  console.log(
    `500 elements: ${previous.length} chars JSON → ${compact.length} compact ` +
      `(${Math.round((1 - compact.length / previous.length) * 100)}% smaller)`,
  );
  assert.ok(
    compact.length < previous.length * 0.5,
    `expected at least half the size, got ${compact.length} vs ${previous.length}`,
  );
});

test('a cut tree says so, in the header, in words that change what the model does', () => {
  // The executor bounds its walk by element count and by a clock. An
  // open/save panel reaches both — 1,500 elements in 35s was measured — so a
  // partial tree is the normal outcome there, not an edge case. Only the trace
  // used to know, which left the model reading a prefix as an inventory and
  // concluding the control it wanted did not exist.
  const cut = renderObservationForModel({
    ...observation([]),
    truncated: true,
  });
  const [head] = lines(cut);
  assert.match(head ?? '', /truncated=true/);
  // The fact alone is not actionable; what the model needs is what it implies.
  assert.match(head ?? '', /may exist but not be listed/);

  const whole = renderObservationForModel(observation([]));
  assert.doesNotMatch(lines(whole)[0] ?? '', /truncated/);
});

test('a subrole is written beside the role, so a secure field is not an ordinary one', () => {
  const text = renderObservationForModel(
    observation([
      { elementId: '0', role: 'AXTextField', subrole: 'AXSecureTextField', label: '密码' },
      { elementId: '1', role: 'AXTextField', label: '用户名' },
    ]),
  );
  const rows = lines(text);
  // The `AX` prefix is on every role in the tree, so it says nothing where it
  // repeats; the subrole keeps its own name and loses the prefix.
  assert.match(rows[1] ?? '', /AXTextField\/SecureTextField/);
  // An element without one is written exactly as before.
  assert.match(rows[2] ?? '', /1 AXTextField "用户名"/);
});

test('an empty field shows what it is prompting for, marked as not a value', () => {
  // Placeholder text reads like content while the field holds nothing, so it
  // gets its own glyph: `~` one character away from `=` and meaning the
  // opposite. Folding it into the value would have a model skip a field it
  // still has to fill, or read the prompt back as data.
  const text = renderObservationForModel(
    observation([
      { elementId: '0', role: 'AXTextField', label: '搜索', placeholder: 'Search your files' },
      {
        elementId: '1',
        role: 'AXTextField',
        label: '搜索',
        value: 'report',
        placeholder: 'Search your files',
      },
      { elementId: '2', role: 'AXTextField', label: '备注' },
    ]),
  );
  const rows = lines(text);
  assert.match(rows[1] ?? '', /~"Search your files"/);
  assert.doesNotMatch(rows[1] ?? '', /="Search your files"/);
  // A field holding something has content; the prompt is no longer what a
  // model needs to know about it.
  assert.match(rows[2] ?? '', /="report"/);
  assert.doesNotMatch(rows[2] ?? '', /~/);
  assert.doesNotMatch(rows[3] ?? '', /~/);
});

test('an element says what it accepts beyond a click, and where the keys go', () => {
  const text = renderObservationForModel(
    observation([
      { elementId: '0', role: 'AXWindow', label: '计算器', actions: ['raise'] },
      { elementId: '1', role: 'AXButton', label: '7' },
      { elementId: '2', role: 'AXTextField', label: '搜索', focused: true, actions: ['show_menu'] },
    ]),
  );
  const rows = lines(text);
  // `raise` is the only window-management verb anywhere in this surface, and it
  // was undiscoverable: the schema said only "Required for secondary_action".
  assert.match(rows[1] ?? '', /\+raise/);
  // A plain button offers nothing beyond click_element, so it says nothing —
  // every actionable element advertises `press`, and printing it on every line
  // costs tokens to say what click_element already does.
  assert.doesNotMatch(rows[2] ?? '', /\+/);
  assert.match(rows[3] ?? '', /\+show_menu/);
  // The exact marker, not merely the word. The tool description tells the model
  // `[focused]` marks where a key sent without an element_id will land, and a
  // loose /focused/ here matched any spelling — renaming the marker to anything
  // containing "focused" left the suite green while the description became a
  // lie about a document the model has to read literally.
  assert.match(rows[3] ?? '', /\[focused\]/);
});

test('the states a line can carry are written together in one bracket', () => {
  // Pins the whole vocabulary, not one marker: `disabled` and `selected` are
  // documented the same way and were unpinned in the same manner.
  const text = renderObservationForModel(
    observation([
      { elementId: '0', role: 'AXWindow', label: '计算器' },
      { elementId: '1', role: 'AXButton', label: '7', enabled: false },
      { elementId: '2', role: 'AXRow', label: 'report', selected: true, focused: true },
    ]),
  );
  const rows = lines(text);
  assert.match(rows[2] ?? '', /\[disabled\]/);
  assert.match(rows[3] ?? '', /\[selected,focused\]/);
});

test('a subrole is written only where it says something the role does not', () => {
  const text = renderObservationForModel(
    observation([
      // Unnamed and one of many: the subrole is the only thing telling these
      // three apart, and without it the model sees three identical buttons.
      { elementId: '0', role: 'AXButton', subrole: 'AXCloseButton' },
      // Unnamed, but a container — unnamed because it is scaffolding, not
      // because its name went missing. `AXWindow/AXStandardWindow` is a longer
      // way of writing `AXWindow`.
      { elementId: '1', role: 'AXWindow', subrole: 'AXStandardWindow' },
      // Named: the label already says which control this is.
      { elementId: '2', role: 'AXButton', subrole: 'AXToggleButton', label: '深色模式' },
      // Secure: always, because this is the one the model must not fill, and
      // that rule is only enforceable if it can tell.
      { elementId: '3', role: 'AXTextField', subrole: 'AXSecureTextField', label: '密码' },
    ]),
  );
  const rows = lines(text);
  assert.match(rows[1] ?? '', /AXButton\/CloseButton/);
  assert.equal((rows[2] ?? '').includes('/'), false, 'a container keeps its bare role');
  assert.equal((rows[3] ?? '').includes('/'), false, 'a labelled control keeps its bare role');
  assert.match(rows[4] ?? '', /AXTextField\/SecureTextField/);
});

// ---------------------------------------------------------------------------
// The offline evaluator's entry point
// ---------------------------------------------------------------------------
//
// `scripts/cu-prune-eval.mjs` measures what a rendering change would cost
// against recorded trajectories. It has to call the real renderer — the same
// instrument built elsewhere reached a reversed conclusion twice because it
// carried a hand-written copy of the policy — so the policy takes an option
// instead. What must stay true is that the option changes nothing until it is
// asked to.

test('collapsing a wrapper is not the same thing as dropping one', () => {
  // The relaxed form the evaluator measures lifts one clause and only one: a
  // container may hold several children. It still may not carry a name, a
  // value, an action, focus or selection — and it still must hold at least one
  // child, because a childless container has nothing to lift into its parent
  // and removing it would be a deletion wearing a collapse's name.
  const sample = observation([
    { elementId: '0', role: 'AXWindow' },
    { elementId: '1', role: 'AXGroup', parentElementId: '0' },
    { elementId: '2', role: 'AXButton', label: '一', parentElementId: '1' },
    { elementId: '3', role: 'AXButton', label: '二', parentElementId: '1' },
    { elementId: '4', role: 'AXGroup', parentElementId: '0' },
    { elementId: '5', role: 'AXGroup', label: '分组', parentElementId: '0' },
    { elementId: '6', role: 'AXButton', label: '三', parentElementId: '5' },
  ]);
  const shipped = lines(renderObservationForModel(sample)).slice(1);
  assert.deepEqual(shipped, [
    '0 AXWindow',
    // The two-child wrapper is gone and both children moved up a level: the
    // line went, the elements did not.
    '\t2 AXButton "一"',
    '\t3 AXButton "二"',
    // The childless one stays: there is nothing to lift, so removing it would
    // remove an element rather than a level.
    '\t4 AXGroup',
    // The named one stays: its name is what a model would point at.
    '\t5 AXGroup "分组"',
    '\t\t6 AXButton "三"',
  ]);
  // Nothing addressable was lost: element 1 is the line that went, and every
  // id that could be acted on is still there to be named.
  for (const id of ['0', '2', '3', '4', '5', '6']) {
    assert.match(shipped.join('\n'), new RegExp(`(^|\\t)${id} AX`, 'm'));
  }

  // The strict form is still reachable, and is what the evaluator baselines
  // against — otherwise baseline and candidate would be the same renderer and
  // every measured saving would read as zero.
  const strict = lines(renderObservationText(sample, { multiChildWrappers: false })).slice(1);
  assert.deepEqual(strict, [
    '0 AXWindow',
    '\t1 AXGroup',
    '\t\t2 AXButton "一"',
    '\t\t3 AXButton "二"',
    '\t4 AXGroup',
    '\t5 AXGroup "分组"',
    '\t\t6 AXButton "三"',
  ]);
});
