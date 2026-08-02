#!/usr/bin/env node
// What the ruler has to get right before any number it prints means anything.
//
// Two of these tests exist because the same instrument, built for
// `unify-computer-use`, produced a REVERSED conclusion twice — once because a
// hand-copied policy matched exactly where the real one matched by suffix, once
// because a parser split a two-word role in half. Both were invisible: the
// evaluator ran, printed a table, and the table was wrong in the direction that
// looked like a result.
//
// So the parser is tested against the real renderer's output rather than
// against fixtures somebody typed, and the retention metric is tested against a
// scheme known to break things — a metric that cannot fail is not a metric.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderObservationForModel,
  renderObservationText,
} from '../packages/runtime/dist/computer-use-observation-text.js';
import {
  namedAncestor,
  offered,
  parseElementLine,
  parseObservationText,
  signature,
  valueCapSavings,
} from './cu-prune-eval.mjs';

function observation(elements, extra = {}) {
  return {
    observationId: 'obs_1',
    appId: 'com.apple.TextEdit',
    pid: 42,
    windowId: 7,
    windowTitle: '未命名',
    elements,
    ...extra,
  };
}

test('every field the renderer can write survives the round trip', () => {
  // Rendered by the real renderer, read back, rendered again: byte-identical or
  // the parser is lying about what the corpus contains.
  const sample = observation([
    { elementId: '0', role: 'AXWindow', label: '未命名', actions: ['raise'] },
    {
      elementId: '1',
      role: 'AXTextField',
      subrole: 'AXSecureTextField',
      label: 'say "hi"\nand\\or',
      value: 'v',
      enabled: false,
      selected: true,
      focused: true,
      parentElementId: '0',
      frame: { x: -193.4, y: -749.6, width: 674, height: 408 },
    },
    { elementId: '2', role: 'AXTextArea', placeholder: '在此输入', parentElementId: '0' },
    {
      elementId: '3',
      role: 'AXStaticText',
      value: 'x'.repeat(400),
      parentElementId: '0',
      actions: ['scroll_up', 'scroll_down'],
    },
    { elementId: '4', role: 'AXMenuBar' },
    { elementId: '5', role: 'AXMenuBarItem', label: '文件', parentElementId: '4' },
  ]);
  const text = renderObservationForModel(sample);
  const parsed = parseObservationText(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.unparsed, []);
  assert.equal(parsed.faithful, true, 'the parsed elements must re-render identically');
  // And a second full render from the parsed elements reproduces the body.
  const again = renderObservationText(parsed.observation);
  assert.deepEqual(again.split('\n').slice(1), text.split('\n').slice(1));
});

test('a label containing a quote or a space is one element, not two', () => {
  // The failure this guards: splitting on whitespace or on `"` turns one line
  // into two elements, and every count downstream is then wrong by an amount
  // that depends on how many labels had punctuation in them.
  const parsed = parseElementLine('\t\t9 AXButton "存储为 \\"草稿\\"" [disabled] +raise @1,2 3x4');
  assert.equal(parsed.depth, 2);
  assert.equal(parsed.element.elementId, '9');
  assert.equal(parsed.element.role, 'AXButton');
  assert.equal(parsed.element.label, '存储为 "草稿"');
  assert.equal(parsed.element.enabled, false);
  assert.deepEqual(parsed.element.actions, ['raise']);
  assert.deepEqual(parsed.element.frame, { x: 1, y: 2, width: 3, height: 4 });
});

test('a line the parser does not fully understand fails instead of losing a field', () => {
  assert.equal(parseElementLine('12 AXButton "ok" !!unknown'), null);
  assert.equal(parseElementLine('12 AXButton "unterminated'), null);
  assert.equal(parseElementLine('12 AXButton [glowing]'), null);
  assert.equal(parseElementLine('12 AXButton @1,2 3'), null);
});

test('a rendering the parser cannot reproduce is reported, not counted', () => {
  // The corpus spans several days of renderer changes. An observation recorded
  // by an older renderer may carry a form this one no longer writes, and the
  // honest answer is to exclude it and say so rather than to measure it wrong.
  const text = renderObservationForModel(observation([{ elementId: '0', role: 'AXWindow' }]));
  const stale = text.replace('0 AXWindow', '0 AXWindow/AXStandardWindow');
  const parsed = parseObservationText(stale);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.faithful, false);
  assert.ok(parsed.firstDivergence.stored.includes('AXWindow/AXStandardWindow'));
});

test('presence is judged by what the model reads, not by element_id', () => {
  // A scheme that renumbered would score 100% on ids while breaking every
  // reference the model holds. Role and label are what a line is recognised by.
  assert.equal(signature({ elementId: '3', role: 'AXButton', label: '存储' }), 'AXButton 存储');
  assert.equal(signature({ elementId: '9', role: 'AXButton', label: '存储' }), 'AXButton 存储');
  const counts = offered(
    renderObservationForModel(
      observation([
        { elementId: '0', role: 'AXWindow' },
        { elementId: '1', role: 'AXButton', label: '存储', parentElementId: '0' },
        { elementId: '2', role: 'AXButton', label: '存储', parentElementId: '0' },
      ]),
    ),
  );
  assert.equal(counts.get('AXButton 存储'), 2, 'duplicates are counted, not deduped');
  assert.equal(counts.get('AXWindow '), 1);
});

test('the retention metric can fail, on a scheme known to break things', () => {
  // `drop-unnamed-leaves` is the naive prune rejected by earlier research. If
  // the metric scores it perfect, the metric is measuring nothing and every
  // 100% beside it is worthless.
  const sample = observation([
    { elementId: '0', role: 'AXWindow' },
    { elementId: '1', role: 'AXButton', parentElementId: '0' },
  ]);
  const full = offered(renderObservationForModel(sample));
  const pruned = offered(renderObservationForModel({ ...sample, elements: [sample.elements[0]] }));
  assert.equal(full.get('AXButton ') ?? 0, 1);
  assert.equal(pruned.get('AXButton ') ?? 0, 0);
});

test('the named ancestor is the one the model would have to name', () => {
  // The blind spot: the target survives, the only thing that could describe it
  // does not. Offline retention read 100% and the real chain broke anyway.
  const elements = [
    { elementId: '0', role: 'AXWindow', label: '未命名' },
    { elementId: '1', role: 'AXGroup', label: '边栏', parentElementId: '0' },
    { elementId: '2', role: 'AXGroup', parentElementId: '1' },
    { elementId: '3', role: 'AXButton', parentElementId: '2' },
  ];
  const byId = new Map(elements.map((element) => [element.elementId, element]));
  assert.equal(namedAncestor(byId.get('3'), byId).elementId, '1', 'skips the unnamed one');
  assert.equal(namedAncestor(byId.get('0'), byId), undefined, 'a root has none');
});

test('a shorter value cap saves the characters past it, minus what says so', () => {
  // 300 characters written, capped at 128: 172 go, and `…(+172 chars)` arrives.
  assert.equal(valueCapSavings([300], 128), 300 - 128 - '…(+172 chars)'.length);
  assert.equal(valueCapSavings([100], 128), 0);
  assert.equal(valueCapSavings([], 128), 0);
});
