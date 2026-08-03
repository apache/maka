import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COMPUTER_USE_WITHHELD_VALUE, computerUseModelCallArgs } from '../computer-use.js';

describe('the call a model reads back as its own', () => {
  test('keeps the arguments it sent, so the shape it learns is the shape that worked', () => {
    // This projection named five keys and dropped everything else, which meant
    // `element_sequence` came back as a call carrying only an observation id.
    // A model reading that learns the empty shape is the one that succeeded,
    // and sends it again — a real session refused eighteen calls for missing
    // exactly the fields this had removed.
    const readBack = computerUseModelCallArgs({
      action: 'element_sequence',
      observation_id: 'obs-1',
      app: 'com.apple.calculator',
      steps: [{ label: '7' }, { label: '×' }, { label: '8' }],
    });

    assert.equal(readBack.action, 'element_sequence');
    assert.equal(readBack.observation_id, 'obs-1');
    assert.ok('steps' in readBack, 'the call had steps and its record must say so');
  });

  test('says how much a value held without saying what it was', () => {
    const readBack = computerUseModelCallArgs({
      action: 'set_value',
      observation_id: 'obs-1',
      element_id: '4',
      value: 'the-users-password',
    });

    assert.ok('value' in readBack);
    assert.ok(
      !JSON.stringify(readBack).includes('the-users-password'),
      'a typed value is screen content and never belongs in the record',
    );
  });

  test('reduces a coordinate to a point rather than naming where on screen', () => {
    const readBack = computerUseModelCallArgs({
      action: 'left_click',
      observation_id: 'obs-1',
      coordinate: [812, 466],
    });

    assert.equal(readBack.coordinate, '<point>');
    assert.ok(!JSON.stringify(readBack).includes('812'));
  });

  test('keeps a value the model chose itself', () => {
    // These are the model's own words or its pick from a fixed set. Reducing
    // them to a shape would cost it the ability to see what it searched for
    // or which way it scrolled, and none of them come off the screen.
    const readBack = computerUseModelCallArgs({
      action: 'observe',
      app: 'com.apple.finder',
      query: '下载',
      include_screenshot: false,
    });

    assert.equal(readBack.query, '下载');
    assert.equal(readBack.include_screenshot, false);
  });

  test('never shows a host-only field as though the model had sent it', () => {
    const readBack = computerUseModelCallArgs({
      action: 'click_element',
      observation_id: 'obs-1',
      element_id: '4',
      approvalClass: 'semantic_mutation',
      rememberForTurnAllowed: false,
    });

    assert.ok(!('approvalClass' in readBack));
    assert.ok(!('rememberForTurnAllowed' in readBack));
  });

  test('never shows the element identity the host resolved for itself', () => {
    // The Computer Use tool attaches the observed element's identity so the
    // host can verify the target. It is not in the wire schema, and that schema
    // is `.strict()`: a model imitating this record sends `element_identity`,
    // the SDK refuses the whole call before `impl`, and the refusal never
    // reaches the debug journal.
    const readBack = computerUseModelCallArgs({
      action: 'click_element',
      observation_id: 'obs-1',
      element_id: '4',
      element_identity: { token: 'ax-token', role: 'AXButton', label: 'Continue' },
    });

    assert.ok(!('element_identity' in readBack));
    assert.ok(!JSON.stringify(readBack).includes('ax-token'));
  });

  test('a withheld value is a description of one, not a string that can be resent', () => {
    // `value` and `text` are `z.string().max(8000)` with no lower bound and no
    // pattern, so whatever stands in for a withheld value is a legal call. It
    // was `<text>` — a fill-in-the-blank — and a model replaying its own
    // set_value would have typed those six characters into the user's field.
    const readBack = computerUseModelCallArgs({
      action: 'set_value',
      observation_id: 'obs-1',
      element_id: '4',
      value: 'the-users-password',
    });

    assert.equal(readBack.value, '<text:18>');
    assert.match(String(readBack.value), COMPUTER_USE_WITHHELD_VALUE);
  });

  test('answers a camelCase key in the dialect the tool accepts', () => {
    const readBack = computerUseModelCallArgs({
      action: 'click_element',
      windowId: 8677,
      observationId: 'obs-1',
      elementId: '4',
    });

    assert.equal(readBack.window_id, 8677);
    assert.equal(readBack.observation_id, 'obs-1');
    assert.equal(readBack.element_id, '4');
    assert.ok(!('windowId' in readBack));
  });
});
