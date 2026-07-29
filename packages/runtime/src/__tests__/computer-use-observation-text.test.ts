// Behavior contract for how an observation is written for the model.
//
// The format follows Codex's Computer Use — one indented line per element,
// containment carried by indentation — with the protocol fields Maka needs and
// Codex does not have. What is asserted here is mostly what must NOT happen:
// nothing dropped, nothing ambiguous, and no way for one element's text to be
// read as two.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderObservationForModel } from '../computer-use-observation-text.js';
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
