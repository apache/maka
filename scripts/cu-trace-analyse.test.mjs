#!/usr/bin/env node
// The analyser had no test, and three of its counters were wrong in the
// direction that reports a clean run.
//
// `blind` searched every preceding call for any observation, so one `observe`
// at the top of a trajectory made every later call unflaggable — twenty blind
// clicks reported BLIND 0. `abandoned` was documented as "the turn ended within
// one call of a refusal" and implemented as "the last call was a refusal".
// Refusal detection read one regex over rendered prose, so a wording change in
// the executor would have zeroed every refusal count, every dead end, and the
// whole failure-by-action table without changing a line of this file.
//
// A second reading found three more of the same kind, and they are the reason
// the fixtures below are built out of the renderer's real output rather than a
// plausible-looking imitation: the observation marker, the action vocabulary
// and the signature were all written from memory, and all three were wrong.
// `observation_id=` does not occur in the product; `left_click` was in neither
// action list; and the signature was key-order sensitive, so three byte-equal
// calls read as three schema guesses.
//
// So each shape below is asserted twice: once on a trajectory that must trip
// it, once on a neighbouring trajectory that must not. A counter that only ever
// goes up is not a measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CU_TOOL_ACTION_TYPES } from '@maka/core';

import {
  analyseCalls,
  blindCalls,
  carriesObservation,
  classify,
  endedAbandoned,
  parseJournal,
  parseTrace,
  signature,
  targetKey,
} from './cu-trace-analyse.mjs';

/** One journal line in the shape `CuDebugRecord` is written in. */
function line(rawArgs, extra = {}) {
  return JSON.stringify({
    at: '2026-08-01T00:00:00.000Z',
    kind: 'call',
    ts: 1,
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    rawArgs,
    modelFacingArgs: rawArgs,
    durationMs: 1,
    ...extra,
  });
}

/**
 * A result carrying an observation, in the shape the product actually renders.
 *
 * This is `observationText` from `packages/runtime/src/computer-use-tools.ts`:
 * one JSON object with an `observation_id` key. The previous fixture wrote
 * `observation_id=obs_1`, a form with zero occurrences in the repository, and
 * every assertion built on it passed while the analyser could not recognise a
 * single real observation.
 */
const observed = (app, win = 1) => ({
  resultText: JSON.stringify({
    observation_id: 'obs_1',
    app,
    pid: 42,
    window_id: win,
    elements: [{ element_id: '0', role: 'AXButton', label: 'w' }],
  }),
});
const refused = (code, text) => ({ error: code, resultText: text ?? `failed: ${code}` });

/**
 * An action that was delivered but handed back no replacement tree — the other
 * branch of the same renderer, verbatim.
 */
const consumed = {
  resultText:
    'computer.click_element delivered path=ax\nObservation consumed; call observe before the next action.',
};

test('a driver trace line is not a model decision', () => {
  assert.equal(classify({ kind: 'driver', event: 'dispatch' }), null);
  assert.notEqual(
    classify({ kind: 'call', rawArgs: { action: 'observe' }, resultText: 'ok' }),
    null,
  );
});

test('the observation id is not part of what the model asked for', () => {
  assert.equal(
    signature({ action: 'click_element', element_id: '3', observation_id: 'obs_1' }),
    signature({ action: 'click_element', element_id: '3', observation_id: 'obs_9' }),
  );
  assert.notEqual(
    signature({ action: 'click_element', element_id: '3' }),
    signature({ action: 'click_element', element_id: '4' }),
  );
});

test('the order the keys were serialised in is not part of it either', () => {
  // Three byte-identical calls, emitted with the keys in three orders. This
  // used to produce three distinct signatures, so verbatim repetition was
  // reported as `thrash: click_element×3 shapes` and `repeated: 0` — the model
  // sending the same thing over and over, diagnosed as the model guessing at
  // the schema, which is the exact confusion this file's header claims to have
  // fixed.
  const a = { action: 'click_element', app: 'a', window_id: 1, element_id: '3' };
  const b = { element_id: '3', action: 'click_element', app: 'a', window_id: 1 };
  const c = { window_id: 1, app: 'a', element_id: '3', action: 'click_element' };
  assert.equal(signature(a), signature(b));
  assert.equal(signature(b), signature(c));
  const report = analyseCalls(
    parseTrace([line(a, observed('a')), line(b, observed('a')), line(c, observed('a'))].join('\n')),
  );
  assert.equal(report.repeated.length, 1);
  assert.deepEqual(report.thrash, []);
  // And the same three calls with one field genuinely different are still three
  // shapes, so the fix did not simply collapse everything into one bucket.
  const varied = analyseCalls(
    parseTrace(
      [
        line({ action: 'click_element', app: 'a', element_id: '3' }, observed('a')),
        line({ action: 'click_element', app: 'a', element_id: '4' }, observed('a')),
        line({ action: 'click_element', app: 'a', element_id: '5' }, observed('a')),
      ].join('\n'),
    ),
  );
  assert.deepEqual(varied.thrash, ['click_element×3 shapes']);
  assert.equal(varied.repeated.length, 0);
});

test('nesting does not reintroduce key-order sensitivity', () => {
  assert.equal(
    signature({ action: 'left_click', coordinate: { x: 1, y: 2 } }),
    signature({ action: 'left_click', coordinate: { y: 2, x: 1 } }),
  );
  assert.notEqual(
    signature({ action: 'left_click', coordinate: { x: 1, y: 2 } }),
    signature({ action: 'left_click', coordinate: { x: 2, y: 1 } }),
  );
});

test('a target is an application and a window, not one or the other', () => {
  assert.equal(targetKey({ app: 'a', window_id: 1 }), targetKey({ app: 'a', window_id: 1 }));
  assert.notEqual(targetKey({ app: 'a', window_id: 1 }), targetKey({ app: 'a', window_id: 2 }));
  assert.notEqual(targetKey({ app: 'a', window_id: 1 }), targetKey({ app: 'b', window_id: 1 }));
});

test('a refusal is read from the executor field, not from how it was worded', () => {
  // The point of the fix: the code survives a rewrite of the prose.
  const reworded = classify({
    kind: 'call',
    rawArgs: { action: 'secondary_action' },
    error: 'dispatch_refused',
    resultText: 'Sorry — that control would not accept the action.',
  });
  assert.equal(reworded.failed, 'dispatch_refused');
  assert.equal(reworded.unclassified, false);
});

test('a journal with no error field still yields a code from the text', () => {
  const older = classify({
    kind: 'call',
    rawArgs: { action: 'press_key' },
    resultText: 'failed: reobserve_required',
  });
  assert.equal(older.failed, 'reobserve_required');
});

test('a failure with no code anywhere is counted, not passed over', () => {
  // The condition the old regex turned into silence. It has to be visible as a
  // number, because the alternative is a report of zero refusals on a run that
  // refused everything.
  const mystery = classify({
    kind: 'call',
    rawArgs: { action: 'click_element' },
    resultText: 'the action was blocked',
  });
  assert.equal(mystery.failed, null);
  assert.equal(mystery.unclassified, true);
  const fine = classify({
    kind: 'call',
    rawArgs: { action: 'click_element' },
    ...observed('com.apple.calculator'),
  });
  assert.equal(fine.unclassified, false);
});

test('a result carrying a fresh tree is recognised by protocol, not by prose', () => {
  // The marker is the JSON key the renderer writes. `observation_id=` is what
  // this used to look for, and it never once occurred in the product.
  assert.equal(carriesObservation(observed('a').resultText), true);
  assert.equal(
    carriesObservation(
      'computer.click_element delivered\nFresh observation: {"observation_id":"obs_2","app_id":"a"}',
    ),
    true,
  );
  assert.equal(carriesObservation('observation_id=obs_4\n\t0 AXWindow'), false);
  assert.equal(
    carriesObservation(
      'computer.click_element delivered\nObservation consumed; call observe before the next action.',
    ),
    false,
  );
  assert.equal(carriesObservation('clicked, and it worked'), false);
  assert.equal(carriesObservation(undefined), false);
});

test('the observing and mutating vocabularies are the product enum, not a copy', () => {
  // The regexes that used to stand in for this matched none of `left_click`,
  // `type`, `key`, `wait` or `zoom`, and did match `click`, `type_text`,
  // `drag`, `launch_app`, `window_action`, `element_sequence` and
  // `wait_for_text` — seven names with zero occurrences on the wire. Every
  // action the tool accepts has to be a name this file recognises, and an
  // action nobody has heard of has to be refused rather than counted.
  for (const action of CU_TOOL_ACTION_TYPES) {
    const [call] = parseTrace(line({ action, app: 'a', window_id: 1 }, observed('a')));
    assert.deepEqual(call.malformed, [], `${action} is on the wire and must classify`);
    assert.equal(call.action, action);
  }
  const [invented] = parseTrace(line({ action: 'launch_app', app: 'a' }, observed('a')));
  assert.deepEqual(invented.malformed, [
    'action "launch_app" is not on the maka_computer wire enum',
  ]);
});

test('twenty coordinate clicks with nothing observed are twenty blind calls', () => {
  // Measured at 0 before the vocabulary came from the enum, because
  // `left_click` matched neither list and so was neither observing nor
  // mutating: the analyser walked past every one of them.
  const calls = parseTrace(
    Array.from({ length: 20 }, (_, n) =>
      line(
        { action: 'left_click', app: 'a', window_id: 1, coordinate: { x: n, y: n } },
        { resultText: 'computer.left_click delivered' },
      ),
    ).join('\n'),
  );
  assert.equal(calls.length, 20);
  assert.equal(blindCalls(calls).length, 20);
});

test('one observation does not excuse every click that follows it', () => {
  // The trajectory the old implementation reported BLIND 0 on. Only the first
  // click had a live tree; each one after it acted on a tree its own
  // predecessor invalidated.
  const calls = parseTrace(
    [
      line({ action: 'observe', app: 'a', window_id: 1 }, observed('a')),
      ...Array.from({ length: 4 }, (_, n) =>
        line({ action: 'click_element', app: 'a', window_id: 1, element_id: String(n) }, consumed),
      ),
    ].join('\n'),
  );
  assert.equal(calls.length, 5);
  assert.equal(blindCalls(calls).length, 3, 'the first click looked; the other three did not');
});

test('an action that hands back a tree leaves the next one sighted', () => {
  // Maka attaches an observation to an action's result, so a run of clicks that
  // each return one is not blind — and reporting it as blind would be an
  // analyser that flags the product working correctly. Measured at BLIND 3
  // against real renderer output before `carriesObservation` was fixed, which
  // is why this fixture is `observationText`'s own JSON.
  const calls = parseTrace(
    [
      line({ action: 'observe', app: 'a', window_id: 1 }, observed('a')),
      ...Array.from({ length: 4 }, (_, n) =>
        line(
          { action: 'click_element', app: 'a', window_id: 1, element_id: String(n) },
          observed('a'),
        ),
      ),
    ].join('\n'),
  );
  assert.equal(blindCalls(calls).length, 0);
});

test('an observation of one window says nothing about another', () => {
  const calls = parseTrace(
    [
      line({ action: 'observe', app: 'a', window_id: 1 }, observed('a')),
      line({ action: 'click_element', app: 'b', window_id: 1, element_id: '0' }, consumed),
    ].join('\n'),
  );
  assert.equal(blindCalls(calls).length, 1, 'the tree it holds describes a different application');
});

test('acting with nothing observed at all is blind', () => {
  const calls = parseTrace(line({ action: 'click_element', app: 'a', element_id: '0' }, consumed));
  assert.equal(blindCalls(calls).length, 1);
});

test('a turn that gave up one call after a refusal is abandoned', () => {
  // Documented as "within one call", so the shape below has to trip it: a
  // refusal, one more try, and then the turn stops.
  const calls = parseTrace(
    [
      line({ action: 'secondary_action', app: 'a' }, refused('dispatch_refused')),
      line({ action: 'observe', app: 'a' }, observed('a')),
    ].join('\n'),
  );
  assert.equal(endedAbandoned(calls), true);
});

test('a turn that recovered and went on working is not abandoned', () => {
  const calls = parseTrace(
    [
      line({ action: 'secondary_action', app: 'a' }, refused('dispatch_refused')),
      line({ action: 'observe', app: 'a', window_id: 1 }, observed('a')),
      line({ action: 'click_element', app: 'a', window_id: 1, element_id: '0' }, observed('a')),
      line({ action: 'observe', app: 'a', window_id: 1 }, observed('a')),
    ].join('\n'),
  );
  assert.equal(endedAbandoned(calls), false);
});

test('three argument shapes for one action is thrash; two is not', () => {
  const shapes = (n) =>
    analyseCalls(
      parseTrace(
        Array.from({ length: n }, (_, i) =>
          line({ action: 'set_value', app: 'a', ['field' + i]: i }, observed('a')),
        ).join('\n'),
      ),
    ).thrash;
  assert.deepEqual(shapes(2), []);
  assert.deepEqual(shapes(3), ['set_value×3 shapes']);
});

test('a refusal answered by the same action again is a dead end', () => {
  const same = analyseCalls(
    parseTrace(
      [
        line({ action: 'secondary_action', app: 'a' }, refused('dispatch_refused')),
        line({ action: 'secondary_action', app: 'a' }, refused('dispatch_refused')),
      ].join('\n'),
    ),
  );
  assert.equal(same.deadEnds, 1);
  const moved = analyseCalls(
    parseTrace(
      [
        line({ action: 'secondary_action', app: 'a' }, refused('dispatch_refused')),
        line({ action: 'observe', app: 'a' }, observed('a')),
      ].join('\n'),
    ),
  );
  assert.equal(moved.deadEnds, 0);
});

test('the same call sent twice is reported once, and a different one is not reported', () => {
  const twice = analyseCalls(
    parseTrace(
      [
        line({ action: 'click_element', app: 'a', window_id: 1, element_id: '3' }, observed('a')),
        line({ action: 'click_element', app: 'a', window_id: 1, element_id: '3' }, observed('a')),
      ].join('\n'),
    ),
  );
  assert.equal(twice.repeated.length, 1);
  const varied = analyseCalls(
    parseTrace(
      [
        line({ action: 'click_element', app: 'a', window_id: 1, element_id: '3' }, observed('a')),
        line({ action: 'click_element', app: 'a', window_id: 1, element_id: '4' }, observed('a')),
      ].join('\n'),
    ),
  );
  assert.equal(varied.repeated.length, 0);
});

test('an unreadable line is dropped without taking the trajectory with it', () => {
  const calls = parseTrace(
    ['{ not json', line({ action: 'observe', app: 'a' }, observed('a'))].join('\n'),
  );
  assert.equal(calls.length, 1);
});

test('but the unreadable line is counted, not forgotten', () => {
  // Dropping it silently is how a journal truncated mid-write presents as a
  // short, tidy trajectory with nothing wrong.
  const journal = parseJournal(
    ['{ not json', line({ action: 'observe', app: 'a' }, observed('a')), '{"kind"'].join('\n'),
  );
  assert.equal(journal.calls.length, 1);
  assert.deepEqual(journal.unreadable, [1, 3]);
  assert.equal(journal.lines, 3);
});

test('a record in a shape this file does not know is refused, not counted as fine', () => {
  // Measured on the analyser as it stood: twenty of these reported
  // {"calls":20,"refusals":0,"blind":0,"actions":["?"]} and exit 0. The
  // arguments are under `arguments`, the result under `result`, and the action
  // is not on the wire — three disagreements with the shape read here, and the
  // report was a clean bill of health for a corpus it had not read one field
  // of. Nothing writes MAKA_CU_DEBUG_LOG yet, so this is the likeliest way the
  // first producer to land will present.
  const report = analyseCalls(
    parseTrace(
      Array.from({ length: 20 }, () =>
        JSON.stringify({
          kind: 'call',
          arguments: { action: 'frobnicate' },
          result: 'failed: dispatch_refused',
        }),
      ).join('\n'),
    ),
  );
  assert.equal(report.calls, 20);
  assert.equal(report.malformed.length, 40, 'two complaints per record');
  assert.deepEqual(
    [...new Set(report.malformed)].sort(),
    ['no rawArgs/modelFacingArgs object', 'no resultText, resultModelText or error field'].sort(),
  );
});

test('a well-formed corpus raises no complaint, so the guard is a measurement', () => {
  const report = analyseCalls(
    parseTrace(
      [
        line({ action: 'observe', app: 'a', window_id: 1 }, observed('a')),
        line({ action: 'click_element', app: 'a', window_id: 1, element_id: '0' }, observed('a')),
        line(
          { action: 'set_value', app: 'a', window_id: 1, element_id: '1', value: 'x' },
          consumed,
        ),
      ].join('\n'),
    ),
  );
  assert.deepEqual(report.malformed, []);
  assert.equal(report.calls, 3);
});

test('a call with an action but no result at all is refused', () => {
  const [call] = parseTrace(line({ action: 'observe', app: 'a' }));
  assert.deepEqual(call.malformed, ['no resultText, resultModelText or error field']);
});

test('an error code with no result text is a complete record', () => {
  // A refusal carries the structural code and may carry nothing else; that is
  // the shape the executor writes, and it must not be mistaken for a record
  // this file failed to read.
  const [call] = parseTrace(line({ action: 'press_key', app: 'a' }, { error: 'dispatch_refused' }));
  assert.deepEqual(call.malformed, []);
  assert.equal(call.failed, 'dispatch_refused');
});
