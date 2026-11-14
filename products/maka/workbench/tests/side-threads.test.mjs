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

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
const appRoot = new URL('../app/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'nsh')
      return {
        url: `data:text/javascript,${encodeURIComponent(`export const signal = v => { const r = () => v; r.set = n => { v = n; }; return r; };`)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const m = await import(new URL('sideThreads.ts', appRoot));
hooks.deregister();

test('block round trip', () => {
  const block = m.formatSideBlock([
    {
      sessionId: 's1',
      title: '↳ 为什么 <x>',
      through: 't9',
      questions: ['> 原文\n\n为什么？'],
      answer: 'a'.repeat(1500),
    },
  ]);
  const text = '主线问题' + block;
  const split = m.splitSideBlock(text);
  assert.equal(split.body, '主线问题');
  assert.deepEqual(split.threads, [{ sessionId: 's1', title: '↳ 为什么 ‹x›', through: 't9' }]);
  assert.match(split.block, /truncated="true"/);
  assert.equal(m.splitSideBlock('plain').block, null);
});

test('collect updates after the carried turn', async () => {
  const chunk = (turnId, role, text, extra = {}) => ({
    turnId,
    role,
    field: 'body',
    messageId: `${turnId}-${role}`,
    offset: 0,
    text,
    ...extra,
  });
  const pages = {
    tail: {
      kind: 'ready',
      through: 50,
      before: 'c1',
      after: null,
      chunks: [
        chunk('t3', 'user', 'Q3'),
        chunk('t3', 'assistant', 'A3', { finalOutput: true }),
        chunk('t4', 'user', 'Q4 running'),
      ],
    },
    c1: {
      kind: 'ready',
      through: 50,
      before: null,
      after: null,
      chunks: [
        chunk('t1', 'user', 'old'),
        chunk('t1', 'assistant', 'old', { finalOutput: true }),
        chunk('t2', 'user', 'Q2'),
        chunk('t2', 'assistant', 'A2', { finalOutput: true }),
      ],
    },
  };
  const query = async (_p, method, input) => {
    if (method === 'list')
      return {
        revision: 'r',
        sessions: [
          { id: 'side', labels: ['maka.side:parent'] },
          { id: 'other', labels: [] },
        ],
        after: null,
      };
    if (method === 'observe')
      return {
        session: {
          id: 'side',
          title: '↳ side',
          labels: ['maka.side:parent'],
          branch: { sessionId: 'parent', position: { kind: 'through_turn', turnId: 't1' } },
        },
        lastCompletedTurnId: 't3',
        through: 50,
      };
    if (method === 'history') return input.position.kind === 'tail' ? pages.tail : pages.c1;
  };
  const updates = await m.collectSideUpdates(query, 'parent', new Map());
  assert.deepEqual(updates, [
    { sessionId: 'side', title: '↳ side', through: 't3', questions: ['Q2', 'Q3'], answer: 'A3' },
  ]);
  assert.deepEqual(await m.collectSideUpdates(query, 'parent', new Map([['side', 't3']])), []);
  const later = await m.collectSideUpdates(query, 'parent', new Map([['side', 't2']]));
  assert.deepEqual(later[0].questions, ['Q3']);
});

test('mark passages', () => {
  const a = (quote, id = 's1') => ({
    sessionId: id,
    turnId: 't',
    quotes: [quote],
    title: '',
    asked: true,
  });
  const md =
    '- 中国资产可能先出现**估值修复**，尤其是此前被低配、估值较低的部分；\n\n`被低配、估值较低` and [被低配](x)';
  assert.equal(
    m.markPassages(md, [a('被低配、估值较低')]),
    '- 中国资产可能先出现**估值修复**，尤其是此前[被低配、估值较低](maka-side:s1)的部分；\n\n`被低配、估值较低` and [被低配](x)',
  );
  // Only code and links contain it: unchanged.
  assert.equal(
    m.markPassages('`abc def`\n\n```\nabc def\n```', [a('abc def')]),
    '`abc def`\n\n```\nabc def\n```',
  );
  // Multi-line passage: each line found; one crossing formatting is linked in
  // the pieces between its marks.
  assert.equal(
    m.markPassages('first line here\n\nsecond **bold** line', [
      a('first line here\nsecond bold line'),
    ]),
    '[first line here](maka-side:s1)\n\n[second ](maka-side:s1)**[bold](maka-side:s1)**[ line](maka-side:s1)',
  );
  // Parentheses in the passage stay text.
  assert.equal(
    m.markPassages('A cache (the fast layer) helps.', [a('cache (the fast layer) helps')]),
    'A [cache (the fast layer) helps](maka-side:s1).',
  );
  // A link shows only its text: the passage around it is linked, the link is kept.
  assert.equal(
    m.markPassages('Use [the docs](https://x.y) for *more* detail.', [
      a('the docs for more detail'),
    ]),
    'Use [the docs](https://x.y)[ for ](maka-side:s1)*[more](maka-side:s1)*[ detail](maka-side:s1).',
  );
  // Brackets and escapes keep showing as written inside the mark.
  assert.equal(
    m.markPassages('Write [x] here.', [a('Write [x] here')]),
    '[Write \\[x\\] here](maka-side:s1).',
  );
  assert.equal(
    m.markPassages('see \\[1\\] ok', [a('see [1] ok')]),
    '[see \\[1\\] ok](maka-side:s1)',
  );
  // Two threads on overlapping text: the first keeps it, the second finds the next copy.
  assert.equal(
    m.markPassages('ab ab', [a('ab', 's1'), a('ab', 's2')]),
    '[ab](maka-side:s1) [ab](maka-side:s2)',
  );
  assert.equal(m.markPassages('x', []), 'x');
});

test('quote label round trip and anchors', async () => {
  const label = m.sideQuoteLabel([{ turnId: 't1', text: 'line1\nline2' }]);
  assert.ok(!/[\u0000-\u001f]/.test(label));
  assert.ok(m.isSideLabel(label));
  const sessions = [
    {
      id: 'f1',
      title: '↳ x',
      labels: [m.sideLabel('p'), label, m.sideAskedLabel],
      branch: { sessionId: 'p', position: { kind: 'through_turn', turnId: 't1' } },
    },
    {
      id: 'f2',
      title: '↳ 被低配、估值较低',
      labels: [m.sideLabel('p'), m.sideAskedLabel],
      branch: { sessionId: 'p', position: { kind: 'through_turn', turnId: 't2' } },
    },
    {
      id: 'f3',
      title: '↳ long passage…',
      labels: [m.sideLabel('p'), m.sideAskedLabel],
      branch: { sessionId: 'p', position: { kind: 'through_turn', turnId: 't2' } },
    },
    { id: 'f4', title: '↳ other', labels: [m.sideLabel('q')], branch: null },
  ];
  await m.loadSideAnchors(async () => ({ sessions, after: null }), 'p');
  assert.deepEqual(m.sideAnchors('p', 't1'), [
    { sessionId: 'f1', turnId: 't1', quotes: ['line1\nline2'], title: '↳ x', asked: true },
  ]);
  // Every thread is listed; only a whole passage marks text.
  assert.deepEqual(
    m.sideAnchors('p', 't2').map((x) => [x.sessionId, x.quotes]),
    [
      ['f2', ['被低配、估值较低']],
      ['f3', []],
    ],
  );
  assert.equal(
    m.markPassages('a long passage here', m.sideAnchors('p', 't2')),
    'a long passage here',
  );
  let opened = null;
  const stop = m.registerSideActions('p', {
    open: (id) => {
      opened = id;
    },
    archive: async () => {},
  });
  assert.equal(m.openSideLink('p', 'maka-side:f1'), true);
  assert.equal(opened, 'f1');
  assert.equal(m.openSideLink('p', 'https://x'), false);
  stop();
});

test('a cleared selection counts only briefly, and only its own clearing', () => {
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    m.notePassage('p', 't1', 'row-a', '被低配');
    assert.equal(m.selectedPassage('p', 't1'), '被低配');
    assert.equal(m.selectedPassage('p', 't2'), null);
    // Another row clearing does not touch it, even much later.
    m.notePassage('p', 't1', 'row-b', '');
    now += 600_000;
    assert.equal(m.selectedPassage('p', 't1'), '被低配');
    // Its own clearing: still there for the press, gone after.
    m.notePassage('p', 't1', 'row-a', '');
    now += 1000;
    assert.equal(m.selectedPassage('p', 't1'), '被低配');
    now += 1000;
    assert.equal(m.selectedPassage('p', 't1'), null);
    // A new selection replaces it.
    m.notePassage('p', 't1', 'row-b', 'SendUser.');
    assert.equal(m.selectedPassage('p', 't1'), 'SendUser.');
  } finally {
    Date.now = realNow;
  }
});

test('names of side threads', () => {
  assert.equal(m.sideName(m.sideTitle(null)), null);
  assert.equal(m.isUntitledSide(m.sideTitle(null)), true);
  assert.equal(m.sideName(m.sideTitle('哪些信号能确认拐点')), '哪些信号能确认拐点');
  assert.equal(m.questionOf('> 被低配、估值较低\n\n有哪些'), '有哪些');
  assert.equal(
    m.questionOf(
      '为什么' +
        m.formatSideBlock([
          { sessionId: 's', title: 't', through: 'x', questions: ['q'], answer: 'a' },
        ]),
    ),
    '为什么',
  );
  m.addSideAnchors('p2', [{ sessionId: 'a', turnId: 't', quotes: [], title: 'x', asked: true }]);
  m.removeSideAnchor('p2', 'a');
  assert.deepEqual(m.sideAnchors('p2', 't'), []);
});

test('several passages from several replies', async () => {
  const quotes = [
    { turnId: 't1', text: 'alpha one' },
    { turnId: 't3', text: 'gamma three' },
    { turnId: 't1', text: 'alpha two' },
  ];
  const label = m.sideQuoteLabel(quotes);
  const session = {
    id: 'g',
    title: m.quotesTitle(quotes.map((q) => q.text)),
    labels: [m.sideLabel('pp'), label, m.sideAskedLabel],
    branch: { sessionId: 'pp', position: { kind: 'through_turn', turnId: 't3' } },
  };
  assert.equal(session.title, '↳ alpha one (+2)');
  await m.loadSideAnchors(async () => ({ sessions: [session], after: null }), 'pp');
  // Listed under each quoted reply, each marking its own passages.
  assert.deepEqual(
    m.sideAnchors('pp', 't1').map((x) => x.quotes),
    [['alpha one', 'alpha two']],
  );
  assert.deepEqual(
    m.sideAnchors('pp', 't3').map((x) => x.quotes),
    [['gamma three']],
  );
  assert.equal(
    m.markPassages('x alpha one y alpha two', m.sideAnchors('pp', 't1')),
    'x [alpha one](maka-side:g) y [alpha two](maka-side:g)',
  );
  // The legacy single-string label still reads, at the fork turn.
  const legacy = {
    ...session,
    labels: [m.sideLabel('pp'), 'maka.side-quote:"old"', m.sideAskedLabel],
  };
  await m.loadSideAnchors(async () => ({ sessions: [legacy], after: null }), 'pp');
  assert.deepEqual(
    m.sideAnchors('pp', 't3').map((x) => x.quotes),
    [['old']],
  );
  assert.equal(m.quotePassages(['a', 'b\nc']), '> a\n\n> b\n> c\n\n');
});

test('gathering passages', () => {
  assert.equal(m.addPendingQuote('q', { turnId: 't', text: 'one' }), true);
  assert.equal(m.addPendingQuote('q', { turnId: 't', text: 'one' }), false);
  for (let i = 2; i <= 8; i += 1)
    assert.equal(m.addPendingQuote('q', { turnId: 't', text: `n${i}` }), true);
  assert.equal(m.addPendingQuote('q', { turnId: 't', text: 'ninth' }), false);
  assert.equal(m.pendingQuotes('q').length, 8);
  m.removePendingQuote('q', 0);
  assert.equal(m.pendingQuotes('q')[0].text, 'n2');
  assert.deepEqual(m.pendingQuotes('other'), []);
  m.clearPendingQuotes('q');
  assert.deepEqual(m.pendingQuotes('q'), []);
});

test('a thread not asked anything marks and lists nothing', async () => {
  const fork = (id, labels) => ({
    id,
    title: '↳ GDP平减指数',
    labels: [m.sideLabel('u'), m.sideQuoteLabel([{ turnId: 't', text: 'GDP平减指数' }]), ...labels],
    branch: { sessionId: 'u', position: { kind: 'through_turn', turnId: 't' } },
  });
  const sessions = [
    fork('fresh', []),
    fork('asked', [m.sideAskedLabel]),
    fork('legacy-done', []),
    fork('legacy-empty', []),
  ];
  const observed = { fresh: null, 'legacy-done': 't9', 'legacy-empty': null };
  const query = async (_p, method, input) =>
    method === 'list'
      ? { sessions, after: null }
      : { lastCompletedTurnId: observed[input.sessionId] ?? null };
  await m.loadSideAnchors(query, 'u');
  assert.deepEqual(
    m.sideAnchors('u', 't').map((x) => x.sessionId),
    ['asked', 'legacy-done'],
  );
  // A thread just created is not marked until asked.
  m.addSideAnchors(
    'u',
    m.anchorsOf('new', '↳ x', 't', [{ turnId: 't', text: 'GDP平减指数' }], false),
  );
  assert.equal(
    m.sideAnchors('u', 't').some((x) => x.sessionId === 'new'),
    false,
  );
  assert.ok(m.isSideLabel(m.sideAskedLabel));
});
