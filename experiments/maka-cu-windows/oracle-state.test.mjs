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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOracleEvent,
  emptyOracleState,
  applicationEvidence,
  navigationCompleted,
  boundNavigationCompleted,
  pageAHasCompatValue,
  pageAHasValue,
  classifyDispatchedTask,
  createOracleStore,
  pageAClicked,
  pageAScrolled,
} from './oracle-state.mjs';

function event(overrides) {
  return {
    run: 'seq-1',
    event: 'ready',
    page: 'A',
    value: '',
    compatValue: '',
    clickCount: 0,
    enterCount: 0,
    scrollTop: 0,
    at: 1,
    ...overrides,
  };
}

function fold(events) {
  return events.reduce((state, item) => applyOracleEvent(state, item), emptyOracleState());
}

test('click must increment exactly once, including reordered duplicate actions', () => {
  assert.equal(pageAClicked(fold([event({ event: 'click', clickCount: 1 })])), true);
  assert.equal(pageAClicked(fold([event({ event: 'click', clickCount: 2 })])), false);
  assert.equal(
    pageAClicked(
      fold([event({ event: 'click', clickCount: 2 }), event({ event: 'click', clickCount: 1 })]),
    ),
    false,
  );
  assert.equal(pageAClicked(fold([event({ event: 'click', clickCount: 3 })]), 2), true);
  assert.equal(pageAClicked(fold([event({ event: 'click', clickCount: 2 })]), 2), false);
  assert.equal(pageAClicked(fold([event({ event: 'click', page: 'B', clickCount: 1 })])), false);
});

test('a scroll event alone does not prove a downward scroll', () => {
  assert.equal(pageAScrolled(fold([event({ event: 'scroll', scrollTop: 0 })]), 0), false);
  assert.equal(pageAScrolled(fold([event({ event: 'scroll', scrollTop: 10 })]), 20), false);
  assert.equal(pageAScrolled(fold([event({ event: 'scroll', scrollTop: 40 })]), 20), true);
  assert.equal(pageAScrolled(fold([event({ event: 'ready', scrollTop: 40 })]), 20), false);
  assert.equal(
    pageAScrolled(fold([event({ event: 'scroll', page: 'B', scrollTop: 40 })]), 20),
    false,
  );
});

test('enter then pageB-load then ready keeps page-A Enter evidence', () => {
  const state = fold([
    event({ event: 'ready', page: 'A' }),
    event({ event: 'compat-input', page: 'A', compatValue: 'compat-browser-text' }),
    event({ event: 'enter', page: 'A', compatValue: 'compat-browser-text', enterCount: 1 }),
    event({ event: 'pageB-load', page: 'B', value: '', compatValue: '', enterCount: 0 }),
    event({ event: 'ready', page: 'B', value: '', compatValue: '', enterCount: 0 }),
  ]);
  const evidence = applicationEvidence(state);
  assert.equal(evidence.enterOnPageA, true);
  assert.equal(evidence.enterCountOnPageA, 1);
  assert.equal(evidence.compatValueOnPageAEnter, 'compat-browser-text');
  assert.equal(evidence.pageBLoaded, true);
  assert.equal(navigationCompleted(state, 'compat-browser-text'), true);
  assert.equal(state.lastEvent.compatValue, '');
  assert.equal(state.lastEvent.enterCount, 0);
});

test('out-of-order pageB-load before enter still records navigation', () => {
  const state = fold([
    event({ event: 'compat-input', page: 'A', compatValue: 'compat-browser-text' }),
    event({ event: 'pageB-load', page: 'B', value: '', compatValue: '', enterCount: 0 }),
    event({ event: 'enter', page: 'A', compatValue: 'compat-browser-text', enterCount: 1 }),
    event({ event: 'ready', page: 'B', value: '', compatValue: '', enterCount: 0 }),
  ]);
  assert.equal(navigationCompleted(state, 'compat-browser-text'), true);
  assert.equal(pageAHasCompatValue(state, 'compat-browser-text'), true);
});

test('page B ready does not count as navigation without Enter on page A', () => {
  const state = fold([
    event({ event: 'ready', page: 'A' }),
    event({ event: 'pageB-load', page: 'B', enterCount: 0 }),
    event({ event: 'ready', page: 'B', enterCount: 0 }),
  ]);
  assert.equal(navigationCompleted(state, 'compat-browser-text'), false);
  assert.equal(applicationEvidence(state).enterOnPageA, false);
});

test('page A input survives later empty page B snapshots', () => {
  const state = fold([
    event({ event: 'input', page: 'A', value: 'chromium-matrix-text' }),
    event({ event: 'ready', page: 'B', value: '', compatValue: '' }),
  ]);
  assert.equal(pageAHasValue(state, 'chromium-matrix-text'), true);
  assert.equal(state.lastEvent.value, '');
});

test('unknown helper outcome is not upgraded when the page completed', () => {
  const classified = classifyDispatchedTask({
    helperResponse: { result: { outcome: { status: 'unknown', reason: 'missing_readback' } } },
    applicationCompleted: true,
  });
  assert.equal(classified.executionState, 'unknown');
  assert.equal(classified.helperOutcome.status, 'unknown');
  assert.equal(classified.applicationCompleted, true);
  assert.equal(classified.contractConformance, 'pass');
});

test('verified helper plus application evidence is pass', () => {
  const classified = classifyDispatchedTask({
    helperResponse: { result: { outcome: { status: 'verified' } } },
    applicationCompleted: true,
  });
  assert.equal(classified.executionState, 'pass');
  assert.equal(classified.helperOutcome.status, 'verified');
});

test('rpc error is inspected before outcome and stays blocked', () => {
  const classified = classifyDispatchedTask({
    helperResponse: { error: { code: -32001, message: 'compat_authorization_missing' } },
    applicationCompleted: true,
  });
  assert.equal(classified.executionState, 'blocked');
  assert.equal(classified.dispatched, false);
  assert.equal(classified.applicationCompleted, true);
  assert.equal(classified.rpcError.message, 'compat_authorization_missing');
});

test('refused helper stays blocked even if the page later changed', () => {
  const classified = classifyDispatchedTask({
    helperResponse: { result: { outcome: { status: 'refused', reason: 'compat_focus_refused' } } },
    applicationCompleted: true,
  });
  assert.equal(classified.executionState, 'blocked');
  assert.equal(classified.helperOutcome.status, 'refused');
});

test('navigation evidence survives every arrival order of the four relevant POSTs', () => {
  function permutations(items) {
    if (!items.length) return [[]];
    return items.flatMap((item, index) =>
      permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
    );
  }
  const events = [
    event({ event: 'compat-input', compatValue: 'expected', at: 1 }),
    event({ event: 'enter', compatValue: 'expected', enterCount: 1, at: 2 }),
    event({ event: 'pageB-load', page: 'B', at: 3 }),
    event({ event: 'ready', page: 'B', at: 4 }),
  ];
  for (const order of permutations(events)) {
    assert.equal(navigationCompleted(fold(order), 'expected'), true);
    assert.equal(navigationCompleted(fold(order), 'wrong-value'), false);
  }
});

test('separate runs cannot combine their Enter and destination evidence', () => {
  const store = createOracleStore();
  store.ingest(event({ run: 'one', event: 'enter', compatValue: 'expected', enterCount: 1 }));
  store.ingest(event({ run: 'two', page: 'B', event: 'pageB-load' }));
  assert.equal(navigationCompleted(store.get('one'), 'expected'), false);
  assert.equal(navigationCompleted(store.get('two'), 'expected'), false);
});

test('a label or unrelated page event containing the text does not prove input', () => {
  const state = fold([
    event({ event: 'ready', value: 'expected' }),
    event({ page: 'B', event: 'input', value: 'expected' }),
  ]);
  assert.equal(pageAHasValue(state, 'expected'), false);
});

test('navigation requires destination ready and exactly one Enter, including reordered counts', () => {
  const enter = event({ event: 'enter', compatValue: 'expected', enterCount: 1 });
  const load = event({ event: 'pageB-load', page: 'B' });
  const ready = event({ event: 'ready', page: 'B' });
  assert.equal(navigationCompleted(fold([enter, load]), 'expected'), false);
  assert.equal(navigationCompleted(fold([enter, load, ready]), 'expected'), true);
  assert.equal(
    navigationCompleted(fold([event({ ...enter, enterCount: 2 }), enter, load, ready]), 'expected'),
    false,
  );
  assert.equal(navigationCompleted(fold([enter, enter, load, ready]), 'expected'), false);
});

test('bound navigation requires the exact run, source field and destination URL', () => {
  const binding = {
    run: 'seq-1',
    value: 'expected',
    sourceUrl: 'http://127.0.0.1:1234/page-a?run=seq-1',
    destinationUrl: 'http://127.0.0.1:1234/page-b?run=seq-1',
  };
  const events = [
    event({
      event: 'compat-input',
      sourceId: 'compat-input',
      url: binding.sourceUrl,
      compatValue: 'expected',
    }),
    event({
      event: 'enter',
      sourceId: 'compat-input',
      url: binding.sourceUrl,
      compatValue: 'expected',
      enterCount: 1,
    }),
    event({ event: 'pageB-load', page: 'B', url: binding.destinationUrl }),
    event({ event: 'ready', page: 'B', url: binding.destinationUrl }),
  ];
  assert.equal(boundNavigationCompleted(fold(events), binding), true);
  assert.equal(boundNavigationCompleted(fold([...events].reverse()), binding), true);
  for (const [index, changes] of [
    [0, { sourceId: 'web-input' }],
    [1, { sourceId: 'web-input' }],
    [1, { run: 'other' }],
    [1, { url: 'wrong-source' }],
    [2, { url: 'wrong-destination' }],
    [3, { run: 'other' }],
    [3, { url: 'wrong-destination' }],
  ]) {
    const changed = events.map((item, i) => (i === index ? { ...item, ...changes } : item));
    assert.equal(
      boundNavigationCompleted(fold(changed), binding),
      false,
      `${index} ${JSON.stringify(changes)}`,
    );
  }
});
