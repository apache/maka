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
import test from 'node:test';
import { TranscriptOverlay } from '../app/transcriptOverlay.ts';
import { historyFollowPosition, historyTurnKey } from '../app/history.ts';
import { thinkingSummary } from '../app/thinkingSummary.ts';
import { orderProcessRows, projectProcessGroups, sameProcessRows } from '../app/processGroups.ts';

const FACTS = {
  1: 'e18e24b1-55b7-4b2a-98a1-000000000001',
  2: 'e18e24b1-55b7-4b2a-98a1-000000000002',
  3: 'e18e24b1-55b7-4b2a-98a1-000000000003',
  4: 'e18e24b1-55b7-4b2a-98a1-000000000004',
  5: 'e18e24b1-55b7-4b2a-98a1-000000000005',
  6: 'e18e24b1-55b7-4b2a-98a1-000000000006',
  7: 'e18e24b1-55b7-4b2a-98a1-000000000007',
  8: 'e18e24b1-55b7-4b2a-98a1-000000000008',
  9: 'e18e24b1-55b7-4b2a-98a1-000000000009',
  10: 'e18e24b1-55b7-4b2a-98a1-00000000000a',
  11: 'e18e24b1-55b7-4b2a-98a1-00000000000b',
  12: 'e18e24b1-55b7-4b2a-98a1-00000000000c',
  13: 'e18e24b1-55b7-4b2a-98a1-00000000000d',
  14: 'e18e24b1-55b7-4b2a-98a1-00000000000e',
  15: 'e18e24b1-55b7-4b2a-98a1-00000000000f',
  16: 'e18e24b1-55b7-4b2a-98a1-000000000010',
  17: 'e18e24b1-55b7-4b2a-98a1-000000000011',
  18: 'e18e24b1-55b7-4b2a-98a1-000000000012',
  19: 'e18e24b1-55b7-4b2a-98a1-000000000013',
  20: 'e18e24b1-55b7-4b2a-98a1-000000000014',
  21: 'e18e24b1-55b7-4b2a-98a1-000000000015',
  22: 'e18e24b1-55b7-4b2a-98a1-000000000016',
  23: 'e18e24b1-55b7-4b2a-98a1-000000000017',
  24: 'e18e24b1-55b7-4b2a-98a1-000000000018',
  25: 'e18e24b1-55b7-4b2a-98a1-000000000019',
};
const livePosition = (sequence, itemIndex = 0) => {
  const fact = FACTS[sequence];
  assert.ok(fact, 'the fixture declares this original fact');
  return { kind: 'live', sequence, fact, itemIndex };
};

const RUN = {
  runId: 'a0000000-0000-4000-8000-000000000001',
  turnId: 'd0000000-0000-4000-8000-000000000001',
};
const NEXT_RUN = {
  runId: 'a0000000-0000-4000-8000-000000000002',
  turnId: 'd0000000-0000-4000-8000-000000000002',
};
const BACKGROUND = {
  runId: 'a0000000-0000-4000-8000-000000000003',
  turnId: 'd0000000-0000-4000-8000-000000000003',
};
const CURRENT = {
  runId: 'a0000000-0000-4000-8000-000000000004',
  turnId: 'd0000000-0000-4000-8000-000000000004',
};
const MODEL = {
  stepId: 'b0000000-0000-4000-8000-000000000001',
  attemptId: 'c0000000-0000-4000-8000-000000000001',
};
const SECOND_MODEL = {
  stepId: 'b0000000-0000-4000-8000-000000000002',
  attemptId: 'c0000000-0000-4000-8000-000000000002',
};
const NEXT_MODEL = {
  stepId: 'b0000000-0000-4000-8000-000000000003',
  attemptId: 'c0000000-0000-4000-8000-000000000003',
};
const BACKGROUND_MODEL = {
  stepId: 'b0000000-0000-4000-8000-000000000004',
  attemptId: 'c0000000-0000-4000-8000-000000000004',
};
const CURRENT_MODEL = {
  stepId: 'b0000000-0000-4000-8000-000000000005',
  attemptId: 'c0000000-0000-4000-8000-000000000005',
};
const SEAT_A = {
  stepId: 'b0000000-0000-4000-8000-000000000006',
  attemptId: 'c0000000-0000-4000-8000-000000000006',
};
const SEAT_B = {
  stepId: 'b0000000-0000-4000-8000-000000000007',
  attemptId: 'c0000000-0000-4000-8000-000000000007',
};
const SEAT_C = {
  stepId: 'b0000000-0000-4000-8000-000000000008',
  attemptId: 'c0000000-0000-4000-8000-000000000008',
};
const PAGED_OUT = {
  stepId: 'b0000000-0000-4000-8000-000000000009',
  attemptId: 'c0000000-0000-4000-8000-000000000009',
};
const TOOL_ONLY = {
  stepId: 'b0000000-0000-4000-8000-00000000000a',
  attemptId: 'c0000000-0000-4000-8000-00000000000a',
};
const THOUGHT = {
  stepId: 'b0000000-0000-4000-8000-00000000000b',
  attemptId: 'c0000000-0000-4000-8000-00000000000b',
};
const BODY = {
  stepId: 'b0000000-0000-4000-8000-00000000000c',
  attemptId: 'c0000000-0000-4000-8000-00000000000c',
};
const event = (sequence, fact, execution = RUN) => ({ sequence, ...execution, fact });
const textPart = (messageId, text, ordinal = 0, textKind = 'text') => ({
  ordinal,
  messageId,
  providerPartId: messageId,
  startedAt: 0,
  field: { kind: 'text', textKind },
  offset: 0,
  totalBytes: Buffer.byteLength(text),
  text,
});
const cut = (parts, changes = {}) => ({
  kind: 'cut',
  hostEpoch: 'epoch',
  ...RUN,
  ...MODEL,
  revision: 1,
  dependsOn: 2,
  first: true,
  last: true,
  parts,
  ...changes,
});
const row = (messageId, text, sequence, changes = {}) => ({
  key: `${sequence}/0/${changes.field ?? 'body'}`,
  messageId,
  text,
  totalBytes: Buffer.byteLength(text),
  fragments: [{ offset: 0, text }],
  field: 'body',
  role: 'assistant',
  turnId: RUN.turnId,
  position: livePosition(sequence, 0),
  order: { path: [sequence], itemIndex: 0 },
  ...changes,
});
const index = (rows) => new Map(rows.map((row) => [`${row.messageId}/${row.field}`, row]));
const texts = (overlay, history = []) =>
  orderProcessRows([...history, ...overlay.snapshot().rows]).map((row) => row.text);
const ended = (overlay) => {
  overlay.event(event(3, { kind: 'part_committed', ...MODEL, messageId: 'reply', ordinal: 0 }));
  overlay.event(event(4, { kind: 'step_ended', ...MODEL, completed: true }));
  overlay.event(event(5, { kind: 'ended', failed: false }));
};

test('the complete end/empty chain keeps committed text visible until history takes over', () => {
  const overlay = new TranscriptOverlay();
  overlay.event(event(1, { kind: 'opened' }));
  overlay.page(cut([textPart('reply', 'response')]));
  assert.deepEqual(texts(overlay), ['response']);
  ended(overlay);
  overlay.page({ kind: 'empty', hostEpoch: 'epoch' });
  assert.deepEqual(texts(overlay), ['response']);
  // An older read completing after the terminal facts cannot retire the handoff.
  overlay.history(new Map(), 2);
  assert.deepEqual(texts(overlay), ['response']);
  const history = [row('reply', 'response', 3, { finalOutput: true })];
  overlay.history(index(history), 5);
  assert.deepEqual(texts(overlay, history), ['response']);
});

test('reconnect reconciles missed terminal facts before accepting the current Run or attempt', () => {
  for (const next of [
    { ...NEXT_RUN, ...NEXT_MODEL },
    { ...RUN, ...SECOND_MODEL },
  ]) {
    const overlay = new TranscriptOverlay();
    overlay.event(event(1, { kind: 'opened' }));
    const input = (messageId, toolUseId) => ({
      ...textPart(messageId, '{"query":'),
      ordinal: null,
      field: { kind: 'tool_input', toolUseId, name: 'search', providerExecuted: false },
    });
    const old = cut([textPart('reply', 'old response'), input('old-input', 'old-tool')]);
    overlay.page(old);
    overlay.disconnect();
    // While offline the old step ends, then either the next run opens or this
    // run starts another step. Subscription resumes after snapshot.through.
    overlay.observe({
      through: 8,
      run: { ...next, state: 'running' },
      parts: [],
    });
    const history = [row('user', 'next request', 6, { role: 'user', turnId: next.turnId })];
    overlay.history(index(history), 8);
    // This page was queued before the snapshot query returned.
    overlay.page(old);
    overlay.page(
      cut([textPart('next-reply', 'new reply'), input('new-input', 'new-tool')], {
        ...next,
        dependsOn: 8,
      }),
    );
    overlay.observe({
      through: 2,
      run: { ...RUN, state: 'running' },
      parts: [],
    });
    overlay.event(event(1, { kind: 'opened' }));
    assert.deepEqual(texts(overlay, history), ['next request', 'new reply']);
    assert.deepEqual(
      overlay.snapshot().tools.map((tool) => [tool.toolUseId, tool.phase]),
      [['new-tool', 'preparing']],
    );
  }
});

test('history window replacement releases retired rows, including work completed while reading older history', () => {
  const overlay = new TranscriptOverlay();
  overlay.page(cut([textPart('reply', 'previous turn')]));
  ended(overlay);
  const tail = [row('user', 'next request', 6, { role: 'user', turnId: NEXT_RUN.turnId })];
  overlay.history(index(tail), 6);
  assert.deepEqual(texts(overlay, tail), ['next request']);
  // Off-tail overlays are not displayed. Terminal rows need not accumulate there.
  overlay.history(new Map(), null);
  overlay.event(event(10, { kind: 'opened' }, BACKGROUND));
  overlay.page(
    cut([textPart('background-reply', 'background response')], {
      ...BACKGROUND,
      ...BACKGROUND_MODEL,
      dependsOn: 11,
    }),
  );
  assert.deepEqual(texts(overlay), ['background response']);
  overlay.event(
    event(
      12,
      { kind: 'part_committed', ...BACKGROUND_MODEL, messageId: 'background-reply', ordinal: 0 },
      BACKGROUND,
    ),
  );
  overlay.event(
    event(13, { kind: 'step_ended', ...BACKGROUND_MODEL, completed: true }, BACKGROUND),
  );
  overlay.event(event(14, { kind: 'ended', failed: false }, BACKGROUND));
  assert.deepEqual(texts(overlay), []);
  overlay.event(event(15, { kind: 'opened' }, CURRENT));
  overlay.page(
    cut([textPart('current-reply', 'current response')], {
      ...CURRENT,
      ...CURRENT_MODEL,
      dependsOn: 16,
    }),
  );
  overlay.history(index(tail), 16);
  assert.deepEqual(texts(overlay, tail), ['next request', 'current response']);
});

test('UTF-8 fragments reconnect from byte zero and canonical replacement rejects a late suffix', () => {
  const overlay = new TranscriptOverlay();
  const page = (revision, offset, text) => {
    const totalBytes = revision === 1 ? 8 : 9;
    return cut([{ ...textPart('reply', text), offset, totalBytes }], {
      revision,
      first: offset === 0 || revision === 2,
      last: offset + Buffer.byteLength(text) === totalBytes,
    });
  };
  overlay.page(page(1, 0, '🦀'));
  overlay.page(page(1, 4, '中!'));
  overlay.page(page(2, 8, '?'));
  assert.deepEqual(texts(overlay), ['🦀中!?']);
  overlay.page(page(2, 0, '🦀中!?'));
  assert.deepEqual(texts(overlay), ['🦀中!?']);
  const history = [row('reply', '🦀中!?', 3)];
  overlay.history(index(history), null);
  overlay.page(
    cut([{ ...textPart('reply', 'obsolete'), offset: 9, totalBytes: 17 }], { revision: 3 }),
  );
  assert.deepEqual(texts(overlay, history), ['🦀中!?']);
});

test('text and pending tool input keep their step seat through canonical handoff and a later user message', () => {
  const overlay = new TranscriptOverlay();
  overlay.page(
    cut([
      textPart('thought', 'thinking', 0, 'thinking'),
      textPart('reply', 'intermediate reply', 1),
      {
        ...textPart('input', '{"query":'),
        ordinal: null,
        field: { kind: 'tool_input', toolUseId: 'tool', name: 'search', providerExecuted: false },
      },
    ]),
  );
  const history = [
    row('thought', 'thinking', 3, {
      field: 'thinking',
      role: 'assistant',
      modelPart: { ...MODEL, ordinal: 0 },
    }),
    row('reply', 'intermediate reply', 4, { modelPart: { ...MODEL, ordinal: 1 } }),
    row('user', 'next request', 10, { role: 'user', turnId: NEXT_RUN.turnId }),
  ];
  const project = () =>
    projectProcessGroups({
      rows: orderProcessRows([...history, ...overlay.snapshot().rows]),
      toolActivity: overlay.snapshot().tools,
      activeTurnId: RUN.turnId,
    }).entries.map((entry) =>
      entry.kind === 'process' ? { rows: entry.rowIds, tools: entry.toolIds } : entry.rowId,
    );
  overlay.history(index(history), null);
  assert.deepEqual(project(), [
    { rows: ['thought/thinking'], tools: [] },
    'reply/body',
    { rows: [], tools: ['tool'] },
    'user/body',
  ]);
  overlay.event(
    event(5, {
      kind: 'tool_input_ready',
      ...MODEL,
      toolUseId: 'tool',
      name: 'search',
      providerExecuted: false,
    }),
  );
  overlay.event(event(6, { kind: 'tool_dispatched', toolUseId: 'tool', name: 'search' }));
  assert.equal(overlay.snapshot().tools[0].phase, 'running');
  assert.deepEqual(project(), [
    { rows: ['thought/thinking'], tools: [] },
    'reply/body',
    { rows: [], tools: ['tool'] },
    'user/body',
  ]);
});

test('executor messages keep text/tool chronology through live, history handoff and cancellation', () => {
  const overlay = new TranscriptOverlay();
  let history = [];
  const project = () =>
    projectProcessGroups({
      rows: orderProcessRows([...history, ...overlay.snapshot().rows]),
      toolActivity: overlay.snapshot().tools,
      activeTurnId: RUN.turnId,
    }).entries.map((entry) => (entry.kind === 'process' ? entry.toolIds : entry.rowId));
  const start = (sequence, messageId, seat) =>
    overlay.event(event(sequence, { kind: 'executor_message_started', messageId, ...seat }));
  const delta = (sequence, seat, text) =>
    overlay.event(event(sequence, { kind: 'delta', ...seat, partId: 'text', text }));
  const commit = (sequence, messageId, seat) =>
    overlay.event(event(sequence, { kind: 'part_committed', ...seat, messageId, ordinal: 0 }));
  const tool = (sequence, toolUseId) =>
    overlay.event(event(sequence, { kind: 'executor_tool_start', toolUseId, name: 'Shell' }));
  const cover = (through, next, coveredFrom) => {
    history = next;
    overlay.history(index(history), through, coveredFrom);
  };
  const toolRow = (messageId, sequence) =>
    row(messageId, 'result', sequence, { role: 'tool', tool: { toolUseId: messageId } });

  overlay.event(event(1, { kind: 'opened' }));
  overlay.event(event(2, { kind: 'executor_started' }));
  tool(3, 'first-tool');
  assert.deepEqual(project(), [['first-tool']]);
  assert.deepEqual(overlay.snapshot().parts, []);
  start(4, 'A', SEAT_A);
  delta(4, SEAT_A, '');
  assert.deepEqual(overlay.snapshot().rows, []);
  delta(5, SEAT_A, 'same');
  delta(6, SEAT_A, ' same');
  tool(7, 'second-tool');
  commit(8, 'A', SEAT_A);
  start(9, 'B', SEAT_B);
  delta(10, SEAT_B, 'same');
  tool(11, 'third-tool');
  commit(12, 'B', SEAT_B);
  start(13, 'C', SEAT_C);
  delta(14, SEAT_C, 'final');
  assert.deepEqual(texts(overlay), ['same same', 'same', 'final']);
  const expected = [['first-tool'], 'A/body', ['second-tool'], 'B/body', ['third-tool'], 'C/body'];
  assert.deepEqual(project(), expected);
  assert.deepEqual(
    overlay.snapshot().parts.map((part) => [part.messageId, part.stepId, part.startSequence]),
    [
      ['C', SEAT_C.stepId, 13],
      ['C', SEAT_C.stepId, 13],
    ],
  );

  // A completed tool's canonical row replaces its live header at the original seat.
  cover(8, [
    toolRow('first-tool', 3),
    row('A', 'same same', 8, { order: { path: [4], itemIndex: 0 } }),
    toolRow('second-tool', 7),
  ]);
  assert.deepEqual(project(), expected);
  cover(12, [
    ...history,
    row('B', 'same', 12, { order: { path: [9], itemIndex: 0 } }),
    toolRow('third-tool', 11),
  ]);
  assert.deepEqual(project(), expected);
  commit(15, 'C', SEAT_C);
  overlay.event(event(16, { kind: 'step_ended', ...SEAT_C, completed: true }));
  // Closed rows must not retain parts just because the final Step has its own attempt identity.
  assert.deepEqual(overlay.snapshot().parts, []);
  assert.deepEqual(project(), expected);
  cover(15, [...history, row('C', 'final', 15, { order: { path: [13], itemIndex: 0 } })]);
  overlay.event(event(17, { kind: 'ended', failed: false }));
  overlay.page({ kind: 'empty', hostEpoch: 'epoch' });
  assert.deepEqual(project(), expected);
  assert.deepEqual(texts(overlay, history), [
    'result',
    'same same',
    'result',
    'same',
    'result',
    'final',
  ]);
});

test('closed executor seats rewind missed deltas once and retire tool-only or paged-out seats', () => {
  const overlay = new TranscriptOverlay();
  overlay.event(event(1, { kind: 'opened' }));
  overlay.event(
    event(2, { kind: 'executor_message_started', messageId: 'paged-out', ...PAGED_OUT }),
  );
  overlay.event(event(3, { kind: 'delta', ...PAGED_OUT, partId: 'text', text: 'older' }));
  overlay.event(
    event(4, { kind: 'executor_message_started', messageId: 'tool-only', ...TOOL_ONLY }),
  );
  overlay.event(event(5, { kind: 'executor_tool_start', toolUseId: 'tool', name: 'Shell' }));
  overlay.event(
    event(6, { kind: 'part_committed', ...PAGED_OUT, messageId: 'paged-out', ordinal: 0 }),
  );
  overlay.event(
    event(7, { kind: 'part_committed', ...TOOL_ONLY, messageId: 'tool-only', ordinal: 0 }),
  );
  const history = [
    row('tool', 'result', 5, {
      role: 'tool',
      tool: { toolUseId: 'tool' },
      order: { path: [4], itemIndex: 0 },
    }),
  ];
  const snap = overlay.snapshot();
  assert.deepEqual(snap.closedStarts, [2, 4]);
  // With windowStart = 4 (a paged tail window starting at event 4), seat 2 is behind `before`
  // while seat 4 rewinds once from event 4 and then retires even without a canonical body row.
  assert.deepEqual(historyFollowPosition(history.at(-1), snap.rows, snap.closedStarts, 4), {
    kind: 'event',
    sequence: 4,
  });
  overlay.history(index(history), 7, 4, 4);
  assert.deepEqual(overlay.snapshot().rows, []);
  assert.deepEqual(overlay.snapshot().closedStarts, []);
  assert.deepEqual(
    historyFollowPosition(
      history.at(-1),
      overlay.snapshot().rows,
      overlay.snapshot().closedStarts,
      4,
    ),
    {
      kind: 'after',
      cursor: { position: livePosition(5, 0), field: 'body', offset: 0 },
    },
  );
});

test('native thinking-only and interrupted body rows keep their summary and seats after missed commits', () => {
  const overlay = new TranscriptOverlay();
  let history = [];
  const project = () =>
    projectProcessGroups({
      rows: orderProcessRows([...history, ...overlay.snapshot().rows]),
      toolActivity: overlay.snapshot().tools,
      activeTurnId: RUN.turnId,
    }).entries.map((entry) =>
      entry.kind === 'process'
        ? { thinking: entry.rowIds.filter((id) => id.endsWith('/thinking')), tools: entry.toolIds }
        : entry.rowId,
    );
  overlay.event(event(1, { kind: 'opened' }));
  overlay.event(event(2, { kind: 'executor_message_started', messageId: 'thought', ...THOUGHT }));
  overlay.event(
    event(3, { kind: 'delta', ...THOUGHT, partId: 'thinking', text: 'old\n\n**检查中**\n' }),
  );
  overlay.event(event(4, { kind: 'executor_tool_start', toolUseId: 'tool', name: 'Shell' }));
  assert.equal(thinkingSummary(overlay.snapshot().rows[0].text), '检查中');
  assert.deepEqual(project(), [{ thinking: ['thought/thinking'], tools: ['tool'] }]);
  history = [row('tool', 'result', 4, { role: 'tool', tool: { toolUseId: 'tool' } })];
  overlay.history(index(history), 4);
  overlay.disconnect();
  // MessageEnd was missed offline, while the Run itself remains active.
  overlay.observe({
    through: 5,
    run: { ...RUN, state: 'running' },
    parts: [],
  });
  overlay.history(index(history), 5);
  assert.deepEqual(texts(overlay, history), ['old\n\n**检查中**\n', 'result']);
  assert.deepEqual(historyFollowPosition(history.at(-1), overlay.snapshot().rows), {
    kind: 'event',
    sequence: 2,
  });
  history.unshift(
    row('thought', 'old\n\n**检查中**\n', 5, {
      field: 'thinking',
      role: 'assistant',
      order: { path: [2], itemIndex: 0 },
    }),
  );
  overlay.history(index(history), 5);
  assert.deepEqual(project(), [{ thinking: ['thought/thinking'], tools: ['tool'] }]);
  assert.equal(thinkingSummary(history[0].text), '检查中');

  overlay.event(event(6, { kind: 'executor_message_started', messageId: 'body', ...BODY }));
  overlay.event(event(7, { kind: 'delta', ...BODY, partId: 'text', text: 'before cancel' }));
  overlay.event(event(8, { kind: 'executor_tool_start', toolUseId: 'pending', name: 'Shell' }));
  const expected = [
    { thinking: ['thought/thinking'], tools: ['tool'] },
    'body/body',
    { thinking: [], tools: ['pending'] },
  ];
  assert.deepEqual(project(), expected);
  overlay.event(event(9, { kind: 'ended', failed: false }));
  overlay.history(index(history), 9);
  assert.deepEqual(texts(overlay, history), ['old\n\n**检查中**\n', 'result', 'before cancel']);
  assert.deepEqual(historyFollowPosition(history.at(-1), overlay.snapshot().rows), {
    kind: 'event',
    sequence: 6,
  });
  const interrupted = row('body', 'before cancel', 9, {
    position: livePosition(9, 1),
    order: { path: [6], itemIndex: 0 },
  });
  history.push(
    interrupted,
    row('pending', 'cancelled', 8, { role: 'tool', tool: { toolUseId: 'pending' } }),
  );
  overlay.history(index(history), 9);
  assert.deepEqual(project(), expected);
  assert.deepEqual(texts(overlay, history), [
    'old\n\n**检查中**\n',
    'result',
    'before cancel',
    'cancelled',
  ]);
  assert.deepEqual(historyFollowPosition(interrupted, []), {
    kind: 'after',
    cursor: { position: livePosition(9, 1), field: 'body', offset: 0 },
  });
});

test('refresh of an open executor message replays its own start without losing its seat or duplicating chunks', () => {
  const overlay = new TranscriptOverlay();
  overlay.observe({
    through: 10,
    run: { ...RUN, state: 'running' },
    parts: [
      { ...SEAT_B, partId: 'text', messageId: 'B', textKind: 'text', startSequence: 9 },
      { ...SEAT_B, partId: 'thinking', messageId: 'B', textKind: 'thinking', startSequence: 9 },
    ],
  });
  const history = [row('A', 'before', 4)];
  overlay.history(index(history), 10);
  overlay.event(event(9, { kind: 'executor_message_started', messageId: 'B', ...SEAT_B }));
  overlay.event(event(10, { kind: 'delta', ...SEAT_B, partId: 'text', text: 'same' }));
  overlay.event(event(10, { kind: 'delta', ...SEAT_B, partId: 'text', text: 'same' }));
  overlay.event(event(11, { kind: 'executor_tool_start', toolUseId: 'tool', name: 'Shell' }));
  overlay.event(event(12, { kind: 'delta', ...SEAT_B, partId: 'text', text: ' same' }));
  assert.deepEqual(texts(overlay, history), ['before', 'same same']);
  assert.deepEqual(
    projectProcessGroups({
      rows: orderProcessRows([...history, ...overlay.snapshot().rows]),
      toolActivity: overlay.snapshot().tools,
      activeTurnId: RUN.turnId,
    }).entries.map((entry) => (entry.kind === 'process' ? entry.toolIds : entry.rowId)),
    ['A/body', 'B/body', ['tool']],
  );
  const canonical = [...history, row('B', 'same same', 9)];
  overlay.event(event(13, { kind: 'part_committed', ...SEAT_B, messageId: 'B', ordinal: 0 }));
  overlay.history(index(canonical), 13);
  overlay.event(event(14, { kind: 'delta', ...SEAT_B, partId: 'text', text: 'obsolete' }));
  assert.deepEqual(texts(overlay, canonical), ['before', 'same same']);
});

test('tool input preview keeps a multi-page Unicode patch through admission', () => {
  const overlay = new TranscriptOverlay();
  const input = JSON.stringify({
    patch: '+const entry = "文件内容🦀";\n'.repeat(2000),
  });
  const chunks = input.match(/.{1,4096}/gu);
  let offset = 0;
  for (const text of chunks) {
    overlay.page(
      cut(
        [
          {
            ...textPart('patch-input', text),
            ordinal: null,
            field: {
              kind: 'tool_input',
              toolUseId: 'patch',
              name: 'ApplyPatch',
              providerExecuted: false,
            },
            offset,
            totalBytes: Buffer.byteLength(input),
          },
        ],
        {
          first: offset === 0,
          last: offset + Buffer.byteLength(text) === Buffer.byteLength(input),
        },
      ),
    );
    offset += Buffer.byteLength(text);
  }
  assert.equal(overlay.snapshot().tools[0].detail, input);
  overlay.event(
    event(3, {
      kind: 'tool_input_ready',
      ...MODEL,
      toolUseId: 'patch',
      name: 'ApplyPatch',
      providerExecuted: false,
    }),
  );
  overlay.event(event(4, { kind: 'tool_dispatched', toolUseId: 'patch', name: 'ApplyPatch' }));
  assert.equal(overlay.snapshot().tools[0].phase, 'running');
  assert.equal(overlay.snapshot().tools[0].detail, input);
});

test('agent inputs share tool activity while human messages and answers stay outside', () => {
  const origins = [
    {
      kind: 'session',
      execution: {
        sessionId: 'reviewer',
        turnId: 'd1111111-1111-4111-8111-111111111111',
        runId: 'a1111111-1111-4111-8111-111111111111',
      },
    },
    { kind: 'bot_worker', sessionId: 'worker' },
  ];
  const rows = [
    row('request', 'Review the change', 1, { role: 'user' }),
    row('thought', 'Checking', 2, { role: 'assistant', field: 'thinking' }),
    ...origins.map((origin, i) =>
      row(`agent-${i}`, 'Internal report', 3 + i, { role: 'user', origin }),
    ),
    row('tool', 'Result', 6, { role: 'tool_result', tool: { toolUseId: 'lookup' } }),
    row('human', 'Focus on correctness', 7, { role: 'user' }),
    row('answer', 'Reviewed', 8, { finalOutput: true }),
  ];
  const projection = projectProcessGroups({ rows, toolActivity: [], activeTurnId: null });
  assert.deepEqual(
    projection.entries.map((entry) => (entry.kind === 'process' ? entry.rowIds : entry.rowId)),
    [
      'request/body',
      ['thought/thinking', 'agent-0/body', 'agent-1/body', 'tool/body'],
      'human/body',
      'answer/body',
    ],
  );
  assert.equal(
    projection.turns.get(RUN.turnId).interleavedInput,
    true,
    'human steering stays visible',
  );
});

test('an agent-started turn folds with its work without being treated as human steering', () => {
  const origin = {
    kind: 'session',
    execution: {
      sessionId: 'parent',
      turnId: 'd2222222-2222-4222-8222-222222222222',
      runId: 'a2222222-2222-4222-8222-222222222222',
    },
  };
  const rows = [
    row('delegation', 'Verify the patch', 1, { role: 'user', origin }),
    row('thought', 'Checking', 2, { role: 'assistant', field: 'thinking' }),
    row('report', 'Done', 3, { role: 'user', origin: { kind: 'bot_worker', sessionId: 'worker' } }),
    row('answer', 'Verified', 4, { finalOutput: true }),
  ];
  const projection = projectProcessGroups({ rows, toolActivity: [], activeTurnId: null });
  assert.deepEqual(
    projection.entries.map((entry) => (entry.kind === 'process' ? entry.rowIds : entry.rowId)),
    [['delegation/body', 'thought/thinking', 'report/body'], 'answer/body'],
  );
  assert.equal(projection.turns.get(RUN.turnId).interleavedInput, false);
  const previous = projection.entries[0];
  const reloaded = projectProcessGroups({
    rows: rows.map((row) => ({ ...row })),
    toolActivity: [],
    activeTurnId: null,
    previous: projection.entries,
  });
  assert.equal(reloaded.entries[0].key, previous.key, 'history refresh retains disclosure state');
});

test('agent attribution arriving with canonical metadata invalidates the live grouping', () => {
  const pending = row('input', 'Task', 1, { role: 'user' });
  const canonical = {
    ...pending,
    origin: {
      kind: 'session',
      execution: {
        sessionId: 'parent',
        turnId: 'd2222222-2222-4222-8222-222222222222',
        runId: 'a2222222-2222-4222-8222-222222222222',
      },
    },
  };
  assert.equal(sameProcessRows([pending], [canonical]), false);
  assert.equal(sameProcessRows([canonical], [{ ...canonical, text: 'Task details' }]), true);
});

test('imported work groups by source and ordinal without borrowing a Root Turn or author role', () => {
  const position = {
    kind: 'imported',
    path: [RUN.runId],
    snapshot: 'imported-one',
    messageOrdinal: 0,
    partOrdinal: 0,
  };
  const imported = {
    key: 'imported-row',
    position,
    order: { path: [1, 1], itemIndex: 0 },
    messageId: undefined,
    turnId: undefined,
    importedTurn: 0,
    role: 'assistant',
    field: 'thinking',
    text: 'inspect',
  };
  const next = {
    ...imported,
    key: 'other-source-row',
    position: { ...position, snapshot: 'imported-two' },
    order: { path: [2, 1], itemIndex: 0 },
  };
  const projection = projectProcessGroups({
    rows: [imported, next],
    toolActivity: [],
    activeTurnId: RUN.turnId,
  });
  const groups = projection.entries.filter((entry) => entry.kind === 'process');
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].turnKey, groups[1].turnKey);
  assert.equal(groups[0].turnKey, historyTurnKey(imported));
  assert.equal(projection.turns.get(groups[0].turnKey).active, false);
  assert.equal(projection.rowsById.get(groups[0].rowIds[0]).turnId, undefined);
  assert.equal(projection.rowsById.get(groups[0].rowIds[0]).role, 'assistant');
});

test('stale-attempt delta and another Run cannot append to an open executor seat', () => {
  const overlay = new TranscriptOverlay();
  overlay.event(event(1, { kind: 'opened' }));
  overlay.event(event(2, { kind: 'executor_message_started', messageId: 'A', ...SEAT_A }));
  overlay.event(event(3, { kind: 'delta', ...SEAT_A, partId: 'text', text: 'current' }));
  overlay.event(
    event(4, {
      kind: 'delta',
      stepId: SEAT_A.stepId,
      attemptId: SECOND_MODEL.attemptId,
      partId: 'text',
      text: 'stale attempt',
    }),
  );
  overlay.event(
    event(5, { kind: 'delta', ...SEAT_A, partId: 'text', text: 'other Run' }, NEXT_RUN),
  );
  assert.deepEqual(texts(overlay), ['current']);
  overlay.event(event(6, { kind: 'delta', ...SEAT_A, partId: 'text', text: ' accepted' }));
  assert.deepEqual(texts(overlay), ['current accepted']);
});
