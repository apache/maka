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
import {
  orderProcessRows,
  projectProcessGroups,
  sameProcessRows,
  turnOutcome,
  turnWorkFold,
} from '../app/processGroups.ts';
import { historyTurnKey, stableRowId } from '../app/history.ts';
import { TranscriptOverlay } from '../app/transcriptOverlay.ts';

const row = (messageId, text, sequence, changes = {}) => ({
  key: messageId,
  messageId,
  text,
  field: 'body',
  role: 'assistant',
  turnId: 'run',
  position: { kind: 'live', sequence, fact: '00000000-0000-4000-8000-000000000003', itemIndex: 0 },
  order: { path: [sequence], itemIndex: 0 },
  ...changes,
});

test('streaming thoughts and tool inputs wait for the history they follow', () => {
  const overlay = new TranscriptOverlay();
  overlay.history(new Map(), 6);
  overlay.page({
    kind: 'cut',
    hostEpoch: 'host',
    runId: 'run',
    turnId: 'turn',
    stepId: 'step',
    attemptId: 'attempt',
    revision: 1,
    dependsOn: 8,
    first: true,
    last: true,
    parts: [
      {
        ordinal: 0,
        messageId: 'thought',
        field: { kind: 'text', textKind: 'thinking' },
        offset: 0,
        totalBytes: 8,
        text: 'Checking',
      },
      {
        messageId: 'input',
        field: { kind: 'tool_input', toolUseId: 'tool', name: 'read', providerExecuted: false },
        offset: 0,
        totalBytes: 2,
        text: '{}',
      },
    ],
  });
  const preview = () => {
    const { rows, tools } = overlay.snapshot();
    return [...rows.map((row) => row.text), ...tools.map((tool) => tool.name)];
  };
  assert.deepEqual(preview(), []);
  overlay.history(new Map(), 8);
  assert.deepEqual(preview(), ['Checking', 'read']);
});

test('committed model text replaces its streaming row before the next tool or model step', () => {
  const overlay = new TranscriptOverlay();
  const step = { stepId: 'step', attemptId: 'attempt' };
  const turn = { runId: 'run', turnId: 'run' };
  const texts = [
    { field: 'thinking', textKind: 'thinking', text: 'Checking the log' },
    { field: 'body', textKind: 'text', text: 'I found the cause.' },
  ];
  const entries = (history = []) => {
    const { rows, tools } = overlay.snapshot();
    const { entries, rowsById } = projectProcessGroups({
      rows: orderProcessRows([...history, ...rows]),
      toolActivity: tools,
      activeTurnId: turn.turnId,
    });
    return entries
      .flatMap((entry) => (entry.kind === 'process' ? entry.rowIds : [entry.rowId]))
      .map((id) => [id, rowsById.get(id).text]);
  };

  overlay.history(new Map(), 1);
  overlay.page({
    kind: 'cut',
    hostEpoch: 'host',
    ...turn,
    ...step,
    revision: 1,
    dependsOn: 1,
    first: true,
    last: true,
    parts: texts.map(({ text, textKind }, ordinal) => ({
      ordinal,
      messageId: `preview-${ordinal}`,
      field: { kind: 'text', textKind },
      offset: 0,
      totalBytes: text.length,
      text,
    })),
  });
  const streaming = entries();
  assert.deepEqual(
    streaming.map(([, text]) => text),
    ['Checking the log', 'I found the cause.'],
  );

  const committed = texts.map(({ field, text }, ordinal) =>
    row(`fact-${ordinal}`, text, ordinal + 2, {
      field,
      modelPart: { ...step, ordinal },
    }),
  );
  overlay.event({
    ...turn,
    sequence: 2,
    fact: { kind: 'part_committed', ...step, messageId: 'fact-0', ordinal: 0 },
  });
  assert.deepEqual(entries(), streaming, 'the watch event alone keeps both text rows visible');

  overlay.history(new Map(committed.map((row) => [stableRowId(row), row])), 3);
  assert.deepEqual(entries(committed), streaming);
  assert.deepEqual(overlay.snapshot().rows, [], 'history takes over even ahead of the watch event');
});

test('a turn has work to fold only beside its final answer', () => {
  const worked = (rows) =>
    projectProcessGroups({ rows, toolActivity: [], activeTurnId: null }).turns.get('run').worked;
  const request = row('request', 'Summarize', 1, { role: 'user' });
  const answer = row('answer', 'Done', 4, { finalOutput: true });
  assert.equal(worked([request, answer]), false);
  assert.equal(worked([request, row('draft', 'Reading first', 2), answer]), true);
  assert.equal(
    worked([request, row('thought', 'Checking', 2, { role: 'thinking', field: 'thinking' })]),
    true,
  );
  assert.equal(worked([request, row('draft', 'Streaming', 2)]), true, 'a running reply is work');
  assert.equal(
    worked([request, row('limit', 'Rate limited', 2, { role: 'failure' }), answer]),
    true,
    'a recovered failure folds away',
  );
});

test('thinking appears in turn work when there is a readable summary', () => {
  const opaque = row('opaque', '', 1, { role: 'thinking', field: 'thinking' });
  const preview = row('preview', '\n ', 2, { role: 'thinking', field: 'thinking' });
  const project = (rows) => projectProcessGroups({ rows, toolActivity: [], activeTurnId: 'run' });

  const hidden = project([opaque, preview]);
  assert.deepEqual(hidden.entries, []);
  assert.equal(hidden.turns.get('run').worked, false);

  const withText = { ...preview, text: '\n Checking the log' };
  assert.equal(sameProcessRows([preview], [withText]), false);
  assert.deepEqual(project([opaque, withText]).entries[0].rowIds, [stableRowId(withText)]);
});

test('work stays open during streamed text and folds when the answer is confirmed', () => {
  const request = row('request', 'Summarize', 1, { role: 'user' });
  const thought = row('thought', 'Checking', 2, { role: 'thinking', field: 'thinking' });
  const answer = row('answer', 'Here', 3);
  const preview = { ...answer, position: undefined, startSequence: 3, order: undefined };
  const project = (rows, options = {}) =>
    projectProcessGroups({
      rows: [request, ...rows],
      toolActivity: [],
      activeTurnId: 'run',
      answerTurnId: 'run',
      ...options,
    }).turns.get('run');
  const chat = (turn) => turnWorkFold(turn, false);

  assert.equal(chat(project([thought, { ...preview, text: '' }])), 'open');
  assert.equal(chat(project([preview])), 'unavailable', 'a direct reply has no work to fold');
  for (const body of [preview, answer]) {
    const turn = project([thought, body]);
    assert.equal(chat(turn), 'open');
    assert.deepEqual(turn.answerOutputIds, [stableRowId(body)], 'keep the streamed answer visible');
    assert.equal(turnWorkFold(turn, true), 'unavailable', 'terminal Chat keeps showing the work');
  }

  const resumed = project([thought, answer], {
    toolActivity: [{ toolUseId: 'read', turnId: 'run', startSequence: 4 }],
  });
  assert.equal(chat(resumed), 'open');
  const nextThought = row('next-thought', '', 4, { role: 'thinking', field: 'thinking' });
  assert.equal(chat(project([thought, answer, nextThought])), 'open');
  assert.equal(chat(project([thought, answer], { answerTurnId: null })), 'open');
  const finalPreview = { ...preview, messageId: 'final-preview', finalAnswer: true };
  assert.equal(chat(project([thought, answer, { ...finalPreview, text: '' }])), 'open');
  const streamingFinal = project([thought, answer, finalPreview]);
  assert.equal(chat(streamingFinal), 'closed');
  assert.equal(turnOutcome(streamingFinal), null, 'the turn is still running');
  assert.deepEqual(streamingFinal.answerOutputIds, [stableRowId(finalPreview)]);
  assert.equal(chat(project([thought, answer, finalPreview, nextThought])), 'open');
  const timing = { startedAt: 1, finished: { outcome: 'completed', at: 5 } };
  const catchingUp = project([{ ...thought, timing }, answer], { activeTurnId: null });
  assert.equal(chat(catchingUp), 'closed');
  assert.deepEqual(catchingUp.answerOutputIds, [stableRowId(answer)]);
  const final = row('final', 'Done', 5, { finalOutput: true });
  const completed = project([thought, answer, final]);
  assert.equal(chat(completed), 'closed');
  assert.equal(turnWorkFold(completed, true), 'closed');
  assert.deepEqual(completed.answerOutputIds, [], 'the earlier text now belongs to the work');
});

test('recovered snapshot failures mark only their source-aware turn as having work', () => {
  const failure = row('failed', 'Rate limited', 2, {
    role: 'failure',
    position: {
      kind: 'snapshot',
      path: ['fork'],
      snapshot: 'snapshot',
      sequence: 2,
      fact: '00000000-0000-4000-8000-000000000003',
      itemIndex: 0,
    },
  });
  const projection = projectProcessGroups({
    rows: [failure],
    toolActivity: [],
    activeTurnId: null,
  });
  assert.equal(projection.turns.size, 1);
  assert.equal(projection.turns.get(historyTurnKey(failure)).worked, true);
  assert.equal(projection.turns.has('run'), false);
});
