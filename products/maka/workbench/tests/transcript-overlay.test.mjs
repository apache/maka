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
import { historyFollowPosition } from '../app/history.ts';
import { thinkingSummary } from '../app/thinkingSummary.ts';
import { orderProcessRows, projectProcessGroups, sameProcessRows } from '../app/processGroups.ts';

const event = (sequence, fact, invocationId = 'run') => ({
  sequence,
  invocationId,
  turnId: invocationId,
  fact,
});
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
  invocationId: 'run',
  turnId: 'run',
  stepId: 'step',
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
  turnId: 'run',
  position: { sourceSequence: sequence, itemIndex: 0 },
  order: { sourceSequence: sequence, itemIndex: 0 },
  ...changes,
});
const index = (rows) => new Map(rows.map((row) => [`${row.messageId}/${row.field}`, row]));
const texts = (overlay, history = []) =>
  orderProcessRows([...history, ...overlay.snapshot().rows]).map((row) => row.text);
const ended = (overlay) => {
  overlay.event(
    event(3, { kind: 'part_committed', stepId: 'step', messageId: 'reply', ordinal: 0 }),
  );
  overlay.event(event(4, { kind: 'step_ended', stepId: 'step', completed: true }));
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

test('reconnect reconciles missed terminal facts before accepting the current invocation or step', () => {
  for (const invocation of ['next', 'run']) {
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
      run: { invocationId: invocation, turnId: invocation, state: 'running' },
      parts: [],
    });
    const history = [row('user', 'next request', 6, { role: 'user', turnId: invocation })];
    overlay.history(index(history), 8);
    // This page was queued before the snapshot query returned.
    overlay.page(old);
    overlay.page(
      cut([textPart('next-reply', 'new reply'), input('new-input', 'new-tool')], {
        invocationId: invocation,
        turnId: invocation,
        stepId: 'next-step',
        dependsOn: 8,
      }),
    );
    overlay.observe({
      through: 2,
      run: { invocationId: 'run', turnId: 'run', state: 'running' },
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
  const tail = [row('user', 'next request', 6, { role: 'user', turnId: 'next' })];
  overlay.history(index(tail), 6);
  assert.deepEqual(texts(overlay, tail), ['next request']);
  // Off-tail overlays are not displayed. Terminal rows need not accumulate there.
  overlay.history(new Map(), null);
  overlay.event(event(10, { kind: 'opened' }, 'background'));
  overlay.page(
    cut([textPart('background-reply', 'background response')], {
      invocationId: 'background',
      turnId: 'background',
      dependsOn: 11,
    }),
  );
  assert.deepEqual(texts(overlay), ['background response']);
  overlay.event(
    event(
      12,
      { kind: 'part_committed', stepId: 'step', messageId: 'background-reply', ordinal: 0 },
      'background',
    ),
  );
  overlay.event(event(13, { kind: 'step_ended', stepId: 'step', completed: true }, 'background'));
  overlay.event(event(14, { kind: 'ended', failed: false }, 'background'));
  assert.deepEqual(texts(overlay), []);
  overlay.event(event(15, { kind: 'opened' }, 'current'));
  overlay.page(
    cut([textPart('current-reply', 'current response')], {
      invocationId: 'current',
      turnId: 'current',
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
      role: 'thinking',
      modelPart: { stepId: 'step', ordinal: 0 },
    }),
    row('reply', 'intermediate reply', 4, { modelPart: { stepId: 'step', ordinal: 1 } }),
    row('user', 'next request', 10, { role: 'user', turnId: 'next' }),
  ];
  const project = () =>
    projectProcessGroups({
      rows: orderProcessRows([...history, ...overlay.snapshot().rows]),
      toolActivity: overlay.snapshot().tools,
      activeTurnId: 'run',
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
      stepId: 'step',
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
      activeTurnId: 'run',
    }).entries.map((entry) => (entry.kind === 'process' ? entry.toolIds : entry.rowId));
  const start = (sequence, messageId) =>
    overlay.event(event(sequence, { kind: 'executor_message_started', messageId }));
  const delta = (sequence, stepId, text) =>
    overlay.event(event(sequence, { kind: 'delta', stepId, partId: 'text', text }));
  const commit = (sequence, messageId) =>
    overlay.event(
      event(sequence, { kind: 'part_committed', stepId: messageId, messageId, ordinal: 0 }),
    );
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
  start(4, 'A');
  delta(4, 'A', '');
  assert.deepEqual(overlay.snapshot().rows, []);
  delta(5, 'A', 'same');
  delta(6, 'A', ' same');
  tool(7, 'second-tool');
  commit(8, 'A');
  start(9, 'B');
  delta(10, 'B', 'same');
  tool(11, 'third-tool');
  commit(12, 'B');
  start(13, 'C');
  delta(14, 'C', 'final');
  assert.deepEqual(texts(overlay), ['same same', 'same', 'final']);
  const expected = [['first-tool'], 'A/body', ['second-tool'], 'B/body', ['third-tool'], 'C/body'];
  assert.deepEqual(project(), expected);
  assert.deepEqual(
    overlay.snapshot().parts.map((part) => [part.messageId, part.stepId, part.startSequence]),
    [
      ['C', 'C', 13],
      ['C', 'C', 13],
    ],
  );

  // A completed tool's canonical row replaces its live header at the original seat.
  cover(8, [
    toolRow('first-tool', 3),
    row('A', 'same same', 8, { order: { sourceSequence: 4, itemIndex: 0 } }),
    toolRow('second-tool', 7),
  ]);
  assert.deepEqual(project(), expected);
  cover(12, [
    ...history,
    row('B', 'same', 12, { order: { sourceSequence: 9, itemIndex: 0 } }),
    toolRow('third-tool', 11),
  ]);
  assert.deepEqual(project(), expected);
  commit(15, 'C');
  overlay.event(event(16, { kind: 'step_ended', stepId: 'run', completed: true }));
  // Closed rows must not retain parts just because the final step is invocation-scoped.
  assert.deepEqual(overlay.snapshot().parts, []);
  assert.deepEqual(project(), expected);
  cover(15, [...history, row('C', 'final', 15, { order: { sourceSequence: 13, itemIndex: 0 } })]);
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
  overlay.event(event(2, { kind: 'executor_message_started', messageId: 'paged-out' }));
  overlay.event(event(3, { kind: 'delta', stepId: 'paged-out', partId: 'text', text: 'older' }));
  overlay.event(event(4, { kind: 'executor_message_started', messageId: 'tool-only' }));
  overlay.event(event(5, { kind: 'executor_tool_start', toolUseId: 'tool', name: 'Shell' }));
  overlay.event(
    event(6, { kind: 'part_committed', stepId: 'paged-out', messageId: 'paged-out', ordinal: 0 }),
  );
  overlay.event(
    event(7, { kind: 'part_committed', stepId: 'tool-only', messageId: 'tool-only', ordinal: 0 }),
  );
  const history = [
    row('tool', 'result', 5, {
      role: 'tool',
      tool: { toolUseId: 'tool' },
      order: { sourceSequence: 4, itemIndex: 0 },
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
      cursor: { position: { sourceSequence: 5, itemIndex: 0 }, field: 'body', offset: 0 },
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
      activeTurnId: 'run',
    }).entries.map((entry) =>
      entry.kind === 'process'
        ? { thinking: entry.rowIds.filter((id) => id.endsWith('/thinking')), tools: entry.toolIds }
        : entry.rowId,
    );
  overlay.event(event(1, { kind: 'opened' }));
  overlay.event(event(2, { kind: 'executor_message_started', messageId: 'thought' }));
  overlay.event(
    event(3, { kind: 'delta', stepId: 'thought', partId: 'thinking', text: 'old\n\n**检查中**\n' }),
  );
  overlay.event(event(4, { kind: 'executor_tool_start', toolUseId: 'tool', name: 'Shell' }));
  assert.equal(thinkingSummary(overlay.snapshot().rows[0].text), '检查中');
  assert.deepEqual(project(), [{ thinking: ['thought/thinking'], tools: ['tool'] }]);
  history = [row('tool', 'result', 4, { role: 'tool', tool: { toolUseId: 'tool' } })];
  overlay.history(index(history), 4);
  overlay.disconnect();
  // MessageEnd was missed offline, while the invocation itself remains active.
  overlay.observe({
    through: 5,
    run: { invocationId: 'run', turnId: 'run', state: 'running' },
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
      role: 'thinking',
      order: { sourceSequence: 2, itemIndex: 0 },
    }),
  );
  overlay.history(index(history), 5);
  assert.deepEqual(project(), [{ thinking: ['thought/thinking'], tools: ['tool'] }]);
  assert.equal(thinkingSummary(history[0].text), '检查中');

  overlay.event(event(6, { kind: 'executor_message_started', messageId: 'body' }));
  overlay.event(event(7, { kind: 'delta', stepId: 'body', partId: 'text', text: 'before cancel' }));
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
    position: { sourceSequence: 9, itemIndex: 1 },
    order: { sourceSequence: 6, itemIndex: 0 },
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
    cursor: { position: { sourceSequence: 9, itemIndex: 1 }, field: 'body', offset: 0 },
  });
});

test('refresh of an open executor message replays its own start without losing its seat or duplicating chunks', () => {
  const overlay = new TranscriptOverlay();
  overlay.observe({
    through: 10,
    run: { invocationId: 'run', turnId: 'run', state: 'running' },
    parts: [
      { stepId: 'B', partId: 'text', messageId: 'B', textKind: 'text', startSequence: 9 },
      { stepId: 'B', partId: 'thinking', messageId: 'B', textKind: 'thinking', startSequence: 9 },
    ],
  });
  const history = [row('A', 'before', 4)];
  overlay.history(index(history), 10);
  overlay.event(event(9, { kind: 'executor_message_started', messageId: 'B' }));
  overlay.event(event(10, { kind: 'delta', stepId: 'B', partId: 'text', text: 'same' }));
  overlay.event(event(10, { kind: 'delta', stepId: 'B', partId: 'text', text: 'same' }));
  overlay.event(event(11, { kind: 'executor_tool_start', toolUseId: 'tool', name: 'Shell' }));
  overlay.event(event(12, { kind: 'delta', stepId: 'B', partId: 'text', text: ' same' }));
  assert.deepEqual(texts(overlay, history), ['before', 'same same']);
  assert.deepEqual(
    projectProcessGroups({
      rows: orderProcessRows([...history, ...overlay.snapshot().rows]),
      toolActivity: overlay.snapshot().tools,
      activeTurnId: 'run',
    }).entries.map((entry) => (entry.kind === 'process' ? entry.toolIds : entry.rowId)),
    ['A/body', 'B/body', ['tool']],
  );
  const canonical = [...history, row('B', 'same same', 9)];
  overlay.event(event(13, { kind: 'part_committed', stepId: 'B', messageId: 'B', ordinal: 0 }));
  overlay.history(index(canonical), 13);
  overlay.event(event(14, { kind: 'delta', stepId: 'B', partId: 'text', text: 'obsolete' }));
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
      stepId: 'step',
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
    { kind: 'session', invocation: { session_id: 'reviewer' } },
    { kind: 'bot_worker', sessionId: 'worker' },
  ];
  const rows = [
    row('request', 'Review the change', 1, { role: 'user' }),
    row('thought', 'Checking', 2, { role: 'thinking', field: 'thinking' }),
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
  assert.equal(projection.turns.get('run').interleavedInput, true, 'human steering stays visible');
});

test('an agent-started turn folds with its work without being treated as human steering', () => {
  const origin = { kind: 'session', invocation: { session_id: 'parent' } };
  const rows = [
    row('delegation', 'Verify the patch', 1, { role: 'user', origin }),
    row('thought', 'Checking', 2, { role: 'thinking', field: 'thinking' }),
    row('report', 'Done', 3, { role: 'user', origin: { kind: 'bot_worker', sessionId: 'worker' } }),
    row('answer', 'Verified', 4, { finalOutput: true }),
  ];
  const projection = projectProcessGroups({ rows, toolActivity: [], activeTurnId: null });
  assert.deepEqual(
    projection.entries.map((entry) => (entry.kind === 'process' ? entry.rowIds : entry.rowId)),
    [['delegation/body', 'thought/thinking', 'report/body'], 'answer/body'],
  );
  assert.equal(projection.turns.get('run').interleavedInput, false);
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
    origin: { kind: 'session', invocation: { session_id: 'parent' } },
  };
  assert.equal(sameProcessRows([pending], [canonical]), false);
  assert.equal(sameProcessRows([canonical], [{ ...canonical, text: 'Task details' }]), true);
});
