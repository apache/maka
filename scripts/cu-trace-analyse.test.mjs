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
// So each shape below is asserted twice: once on a trajectory that must trip
// it, once on a neighbouring trajectory that must not. A counter that only ever
// goes up is not a measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseCalls,
  blindCalls,
  carriesObservation,
  classify,
  endedAbandoned,
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

const observed = (app) => ({
  resultText: `observation_id=obs_1 app=${app}\n\t0 AXWindow "w"`,
});
const refused = (code, text) => ({ error: code, resultText: text ?? `failed: ${code}` });

test('a driver trace line is not a model decision', () => {
  assert.equal(classify({ kind: 'driver', event: 'dispatch' }), null);
  assert.notEqual(classify({ kind: 'call', rawArgs: { action: 'observe' } }), null);
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
  assert.equal(carriesObservation('observation_id=obs_4\n\t0 AXWindow'), true);
  assert.equal(carriesObservation('clicked, and it worked'), false);
  assert.equal(carriesObservation(undefined), false);
});

test('one observation does not excuse every click that follows it', () => {
  // The trajectory the old implementation reported BLIND 0 on. Only the first
  // click had a live tree; each one after it acted on a tree its own
  // predecessor invalidated.
  const calls = parseTrace(
    [
      line({ action: 'observe', app: 'a', window_id: 1 }, observed('a')),
      ...Array.from({ length: 4 }, (_, n) =>
        line({ action: 'click_element', app: 'a', window_id: 1, element_id: String(n) }),
      ),
    ].join('\n'),
  );
  assert.equal(calls.length, 5);
  assert.equal(blindCalls(calls).length, 3, 'the first click looked; the other three did not');
});

test('an action that hands back a tree leaves the next one sighted', () => {
  // Maka attaches an observation to an action's result, so a run of clicks that
  // each return one is not blind — and reporting it as blind would be an
  // analyser that flags the product working correctly.
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
      line({ action: 'click_element', app: 'b', window_id: 1, element_id: '0' }),
    ].join('\n'),
  );
  assert.equal(blindCalls(calls).length, 1, 'the tree it holds describes a different application');
});

test('acting with nothing observed at all is blind', () => {
  const calls = parseTrace(
    [line({ action: 'click_element', app: 'a', element_id: '0' })].join('\n'),
  );
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
