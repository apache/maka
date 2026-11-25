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
  groupLatestIsThought,
  groupThought,
  orderProcessRows,
  projectProcessGroups,
  sameProcessRows,
  showTurnSummary,
  turnOutcome,
  turnThought,
  turnWorkFold,
} from '../app/processGroups.ts';
import {
  applyWorkTailThought,
  groupStepsFollowCursor,
  HistoryRows,
  historyFollowPosition,
  historyFollowTail,
  historyRowKey,
  historyRowThrough,
  historyTurnKey,
  isReplyWithActions,
  mergeHistoryPage,
  stableRowId,
} from '../app/history.ts';
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

test('a recorded work group keeps one key and holds the steps read for it', () => {
  const part = (ordinal) => ({ stepId: 'step', attemptId: 'attempt', ordinal });
  const tool = (toolUseId, sequence, call) => ({
    toolUseId,
    call: { position: row('', '', sequence).position, ancestorToolUseIds: [], ...call },
    result: null,
  });
  const message = row('message', 'Looking first.', 1, { modelPart: part(0) });
  const work = row(undefined, '', 2, {
    key: 'work',
    role: 'tool_call',
    modelPart: part(1),
    work: { kinds: [{ kind: 'tool', presentation: null }], tools: 1 },
  });
  const script = row(undefined, '', 2, {
    key: 'script',
    role: 'tool_call',
    modelPart: part(1),
    tool: tool('script', 2, { origin: 'provider', name: 'exec' }),
  });
  const child = row(undefined, '', 3, {
    key: 'child',
    role: 'tool_result',
    tool: tool('child', 3, { origin: 'code_mode', name: 'read', ancestorToolUseIds: ['script'] }),
  });
  const answer = row('answer', 'Done.', 4);
  const groups = (rows) =>
    projectProcessGroups({ rows: orderProcessRows(rows), toolActivity: [], activeTurnId: null })
      .entries.filter((entry) => entry.kind === 'process')
      .map((entry) => [entry.key, entry.rowIds]);

  const preview = row(undefined, 'Checking', undefined, {
    key: 'preview',
    role: 'thinking',
    field: 'thinking',
    position: undefined,
    order: undefined,
    modelPart: part(1),
  });
  const [[live]] = groups([message, preview]);
  assert.deepEqual(groups([message, work, answer]), [[live, []]]);
  assert.deepEqual(groups([answer, child, script, work, message]), [[live, [stableRowId(child)]]]);
  const tooled = { ...work, work: { ...work.work, firstToolUseId: 'running' } };
  const started = projectProcessGroups({
    rows: [message],
    toolActivity: [{ toolUseId: 'running', turnId: 'run', startSequence: 2 }],
    activeTurnId: 'run',
  }).entries.filter((entry) => entry.kind === 'process');
  assert.deepEqual(
    groups([message, tooled]).map(([key]) => key),
    started.map((entry) => entry.key),
  );
  const running = projectProcessGroups({
    rows: orderProcessRows([message, work, answer]),
    toolActivity: [{ toolUseId: 'running', turnId: 'run', startSequence: 2 }],
    activeTurnId: 'run',
  }).entries.filter((entry) => entry.kind === 'process');
  assert.deepEqual(
    running.map((entry) => [entry.key, entry.toolIds]),
    [[live, ['running']]],
  );

  const rows = new HistoryRows();
  const chunk = ({ key, messageId, ...rest }) => ({
    ...rest,
    offset: 0,
    totalBytes: 0,
  });
  const put = (value) =>
    rows.put(mergeHistoryPage([chunk(value)], (key) => rows.byKey.get(key), false, 5));
  put(work);
  put(script);
  put({ ...work, work: { ...work.work, tools: 2 } });
  assert.deepEqual(
    rows.ordered.map((value) => value.work?.tools ?? value.tool.toolUseId),
    [2, 'script'],
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

test('a direct final reply has no work header, including after history reloads', () => {
  const request = row('request', 'Hi', 1, { role: 'user' });
  const final = row('reply', 'Hello!', 3, { finalOutput: true });
  const completed = { startedAt: 1000, finished: { at: 12000, outcome: 'completed' } };
  const project = (rows, activeTurnId = null) =>
    projectProcessGroups({ rows, toolActivity: [], activeTurnId }).turns.get('run');
  const thought = row('thought', 'Checking', 2, { role: 'thinking', field: 'thinking' });
  const tool = row('call', '', 2, { role: 'tool_call', tool: { toolUseId: 'read' } });
  for (const terminal of [false, true]) {
    assert.equal(showTurnSummary(project([request, final], 'run'), terminal), false);
    assert.equal(
      showTurnSummary(project([{ ...request, timing: completed }, final]), terminal),
      false,
    );
    assert.equal(showTurnSummary(project([request, thought, final]), terminal), true);
    assert.equal(showTurnSummary(project([request, tool, final]), terminal), true);
    for (const outcome of ['failed', 'aborted']) {
      const timing = { ...completed, finished: { ...completed.finished, outcome } };
      assert.equal(showTurnSummary(project([{ ...request, timing }]), terminal), true);
    }
  }
  assert.equal(showTurnSummary(project([request], 'run'), false), true);
});

test('imported replies stay visible while thinking and tool activity fold', () => {
  const imported = (ordinal, text, changes = {}) =>
    row(String(ordinal), text, ordinal, {
      position: {
        kind: 'imported',
        path: [],
        snapshot: 'history',
        messageOrdinal: ordinal,
        partOrdinal: 0,
      },
      importedTurn: 0,
      ...changes,
    });
  const request = imported(0, '测试代号是什么？', { role: 'user' });
  const reply = imported(4, '海星');
  const call = imported(2, '');
  call.tool = { toolUseId: 'lookup', call: { origin: 'imported', position: call.position } };
  const result = imported(3, '', {
    role: 'tool_result',
    tool: { toolUseId: 'lookup', result: { isError: false } },
  });
  const thought = imported(1, '回顾之前的问题', { field: 'thinking' });
  assert.equal(isReplyWithActions(reply), true);
  for (const other of [request, call, result, thought, { ...reply, sourceCitation: true }])
    assert.equal(isReplyWithActions(other), false);
  for (const rows of [
    [request, reply],
    [request, thought, reply],
    [request, thought, call, result, reply],
  ]) {
    const { entries, turns } = projectProcessGroups({ rows, activeTurnId: null, toolActivity: [] });
    const turn = turns.get(historyTurnKey(reply));
    const hasWork = rows.includes(thought) || rows.includes(call);
    const hasTools = rows.includes(call);
    for (const terminal of [false, true]) {
      assert.equal(showTurnSummary(turn, terminal), hasWork);
      assert.equal(turnWorkFold(turn, terminal), hasWork ? 'closed' : 'unavailable');
    }
    const groups = entries.filter((entry) => entry.kind === 'process');
    assert.equal(groups.length, hasWork ? 1 : 0);
    assert.deepEqual(
      groups.flatMap((group) => group.toolIds),
      hasTools ? ['lookup'] : [],
    );
    if (rows.includes(thought)) {
      assert.equal(
        entries.some((entry) => entry.kind === 'message' && entry.rowId === stableRowId(thought)),
        false,
      );
      assert.equal(groups[0].rowIds.includes(stableRowId(thought)), true);
    }
    const answer = entries.find((entry) => entry.rowId === stableRowId(reply));
    assert.equal(answer.kind, 'message');
    assert.equal(answer.processTurnKey, undefined);
  }
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

test('expanded group steps keep the chat follow tail and newer streamed text intact', () => {
  const rows = new HistoryRows();
  const chunk = ({ key, ...rest }) => ({ ...rest, offset: 0, totalBytes: rest.text.length });
  const put = (items, through) =>
    rows.put(mergeHistoryPage(items, (key) => rows.byKey.get(key), false, through));

  const work = row(undefined, '', 2, {
    role: 'thinking',
    field: 'thinking',
    work: {
      end: { position: row('', '', 3).position, field: 'thinking', offset: 0 },
      last: { kind: 'thought' },
      firstToolUseId: null,
      lastCall: null,
      kinds: [{ kind: 'thought' }],
      thoughts: 1,
      tools: 0,
      messages: 0,
      imageCount: 0,
      images: [],
    },
  });
  const thought = row('ext-thought', 'First.', 3, { role: 'thinking', field: 'thinking' });
  put([chunk(work), chunk(thought)], 3);
  assert.equal(historyFollowTail(rows.ordered, 'chat')?.work?.thoughts, 1);

  put([chunk({ ...thought, text: 'First. Second.' })], 5);
  put([chunk({ ...thought, text: 'First.' })], 4);
  assert.equal(rows.byMessage.get('ext-thought/thinking').text, 'First. Second.');
});

test('a row opened during refresh is read at a fence that contains it', () => {
  const oldFence = 11;
  const position = {
    kind: 'live',
    sequence: 12,
    fact: '00000000-0000-4000-8000-000000000012',
    itemIndex: 0,
  };
  const [admission] = mergeHistoryPage(
    [
      {
        position,
        order: { path: [position.sequence], itemIndex: 0 },
        field: 'body',
        role: 'user',
        messageId: 'completion',
        offset: 0,
        totalBytes: 0,
        text: '',
      },
    ],
    () => undefined,
    false,
    12,
  );
  assert.equal(historyRowThrough(admission, oldFence), 12);
  assert.equal(historyRowThrough(admission, 34), 34);
});

test('reverse-paging a group whose first tool finishes in the tail page keeps one group key', () => {
  const rows = new HistoryRows();
  const chunk = ({ key, ...rest }) => ({ ...rest, offset: 0, totalBytes: rest.text.length });
  const put = (items, through, prepend = false) =>
    rows.put(mergeHistoryPage(items, (key) => rows.byKey.get(key), prepend, through));

  const execCallPos = row('', '', 1).position;
  const childCallPos = row('', '', 80).position;
  const work = row(undefined, '', 1, {
    role: 'tool_call',
    field: 'body',
    work: {
      end: { position: row('', '', 101).position, field: 'body', offset: 0 },
      last: { kind: 'tool', presentation: null },
      firstToolUseId: 'exec-1',
      lastCall: null,
      kinds: [{ kind: 'tool', presentation: null }],
      thoughts: 0,
      tools: 100,
      messages: 0,
      imageCount: 0,
      images: [],
    },
  });
  put([chunk(work)], 101);
  const collapsed = projectProcessGroups({
    rows: rows.ordered,
    toolActivity: [],
    activeTurnId: 'run',
  });
  const initialKey = collapsed.entries[0].key;

  const child = row('child-80', '', 80, {
    role: 'tool_call',
    field: 'body',
    tool: {
      toolUseId: 'child-80',
      call: {
        position: childCallPos,
        name: 'Read',
        origin: 'code_mode',
        ancestorToolUseIds: ['exec-1'],
        presentation: null,
      },
      result: { position: row('', '', 81).position, isError: false, image: false },
    },
  });
  const execResult = row('exec-result', '', 101, {
    role: 'tool_result',
    field: 'body',
    tool: {
      toolUseId: 'exec-1',
      call: {
        position: execCallPos,
        name: 'exec',
        origin: 'model',
        ancestorToolUseIds: [],
        presentation: null,
      },
      result: { position: row('', '', 101).position, isError: false, image: false },
    },
  });
  put([chunk(child), chunk(execResult)], 101);
  const tail = projectProcessGroups({
    rows: rows.ordered,
    toolActivity: [],
    activeTurnId: 'run',
    previous: collapsed.entries,
  });
  assert.equal(tail.entries[0].key, initialKey);
  assert.deepEqual(tail.entries[0].rowIds, [stableRowId(child)]);

  const execCall = row('exec-call', '', 1, {
    role: 'tool_call',
    field: 'body',
    tool: {
      toolUseId: 'exec-1',
      call: {
        position: execCallPos,
        name: 'exec',
        origin: 'model',
        ancestorToolUseIds: [],
        presentation: null,
      },
      result: { position: row('', '', 101).position, isError: false, image: false },
    },
  });
  put([chunk(execCall)], 101, true);
  const head = projectProcessGroups({
    rows: rows.ordered,
    toolActivity: [],
    activeTurnId: 'run',
    previous: tail.entries,
  });
  assert.equal(head.entries[0].key, initialKey);
});

test('groupThought, turnThought, and applyWorkTailThought keep active thoughts current without regressing to expanded steps', () => {
  const workRow = (lastThought, { endPos, endField = 'body', endOffset = 0, last } = {}) =>
    row(undefined, '', 2, {
      role: 'thinking',
      field: 'thinking',
      work: {
        end: { position: endPos ?? row('', '', 7).position, field: endField, offset: endOffset },
        last: last ?? { kind: 'tool', presentation: null },
        lastCall: null,
        lastThought,
        firstToolUseId: null,
        kinds: [{ kind: 'thought' }, { kind: 'tool', presentation: null }],
        thoughts: 1,
        tools: 1,
        messages: 0,
        imageCount: 0,
        images: [],
      },
    });
  const req = row('user', 'Check PR', 1, { role: 'user', field: 'body' });
  const oldLoadedThought = row('t1', 'Old expanded thought', 2, {
    role: 'thinking',
    field: 'thinking',
  });
  const t1Work = workRow(
    { position: oldLoadedThought.position, offset: 7, text: 'Initial' },
    {
      endPos: oldLoadedThought.position,
      endField: 'thinking',
      endOffset: 7,
      last: { kind: 'thought' },
    },
  );
  const work2 = workRow({
    position: row('', '', 6).position,
    offset: 20,
    text: 'Newer folded thought',
  });
  const liveThought = {
    key: 'live/model/step-2/att-1/0',
    messageId: 'live-t2',
    role: 'thinking',
    field: 'thinking',
    text: 'Streaming live thought',
    turnId: 'run',
    startSequence: 10,
    modelPart: { stepId: 'step-2', attemptId: 'att-1', ordinal: 0 },
  };
  const lookup = (items) => {
    const map = new Map(items.map((item) => [stableRowId(item), item]));
    return (id) => map.get(id);
  };

  // Returning to tail at an old fence sends work.end.offset; Host tailThought advances both text and cursor.
  assert.deepEqual(historyFollowPosition(t1Work, []), {
    kind: 'after',
    cursor: { position: oldLoadedThought.position, field: 'thinking', offset: 7 },
  });
  const caughtUp = applyWorkTailThought(t1Work, {
    position: oldLoadedThought.position,
    offset: 19,
    text: 'Initial + continued',
  });
  assert.equal(caughtUp.work.end.offset, 19);
  assert.equal(caughtUp.work.lastThought.offset, 19);
  assert.equal(caughtUp.work.lastThought.text, 'Initial + continued');

  // When a tool occupies work.end, tailThought updates lastThought without disturbing the tool pagination cursor.
  const toolEndPos = row('', '', 8).position;
  const toolTailWork = workRow(
    { position: oldLoadedThought.position, offset: 7, text: 'Initial' },
    { endPos: toolEndPos, endField: 'body', endOffset: 0 },
  );
  const toolTailUpdated = applyWorkTailThought(toolTailWork, {
    position: oldLoadedThought.position,
    offset: 17,
    text: 'Initial plus more',
  });
  assert.deepEqual(toolTailUpdated.work.end, { position: toolEndPos, field: 'body', offset: 0 });
  assert.equal(toolTailUpdated.work.lastThought.offset, 17);
  assert.equal(toolTailUpdated.work.lastThought.text, 'Initial plus more');

  // If an in-flight steps expand at fence 7 lands after both a thought continuation (fence 8) and a
  // tool result (fence 9, bumping metadataThrough), follow prioritizes the lagging thought over window.last
  // so one forward page catches up both the thought suffix and the tool result.
  const toolLastCursor = { position: toolEndPos, field: 'body', offset: 0 };
  const updatedWithToolResult = { ...toolTailUpdated, metadataThrough: 9 };
  const loadedSteps = new Map([
    [
      historyRowKey(oldLoadedThought.position, 'thinking'),
      { fragments: [{ offset: 0, text: 'Initial' }], totalBytes: 7 },
    ],
  ]);
  assert.deepEqual(
    groupStepsFollowCursor(
      updatedWithToolResult,
      { after: null, last: toolLastCursor, through: 7 },
      9,
      (k) => loadedSteps.get(k),
    ),
    { position: oldLoadedThought.position, field: 'thinking', offset: 7 },
  );
  // Once the thought step already covers the confirmed offset, follow advances from window.last for new tool metadata,
  // and stops completely once window.through catches up.
  loadedSteps.set(historyRowKey(oldLoadedThought.position, 'thinking'), {
    fragments: [
      { offset: 0, text: 'Initial' },
      { offset: 7, text: ' plus more' },
    ],
    totalBytes: 17,
  });
  assert.deepEqual(
    groupStepsFollowCursor(
      updatedWithToolResult,
      { after: null, last: toolLastCursor, through: 7 },
      9,
      (k) => loadedSteps.get(k),
    ),
    toolLastCursor,
  );
  assert.equal(
    groupStepsFollowCursor(
      updatedWithToolResult,
      { after: null, last: toolLastCursor, through: 9 },
      9,
      (k) => loadedSteps.get(k),
    ),
    null,
  );

  // Collapsed external executor reads work.lastThought and reports thinking title without expanding.
  const foldedOnly = projectProcessGroups({
    rows: [req, caughtUp],
    toolActivity: [],
    activeTurnId: 'run',
  });
  const foldedGroup = foldedOnly.entries.find((entry) => entry.kind === 'process');
  assert.equal(groupThought(foldedGroup, lookup([req, caughtUp])), 'Initial + continued');
  assert.equal(groupLatestIsThought(foldedGroup, lookup([req, caughtUp])), true);
  assert.equal(turnThought([foldedGroup], lookup([req, caughtUp])), 'Initial + continued');

  // After expanding once (oldLoadedThought in rowIds) and collapsing: newer work.lastThought wins.
  const expandedThenUpdated = projectProcessGroups({
    rows: [req, work2, oldLoadedThought],
    toolActivity: [],
    activeTurnId: 'run',
  });
  const updatedGroup = expandedThenUpdated.entries.find((entry) => entry.kind === 'process');
  assert.equal(
    groupThought(updatedGroup, lookup([req, work2, oldLoadedThought])),
    'Newer folded thought',
  );
  assert.equal(groupLatestIsThought(updatedGroup, lookup([req, work2, oldLoadedThought])), false);

  // While a new native thought streams live, it takes precedence over work.lastThought.
  const withLive = projectProcessGroups({
    rows: [req, work2, oldLoadedThought, liveThought],
    toolActivity: [],
    activeTurnId: 'run',
  });
  const liveGroup = withLive.entries.find((entry) => entry.kind === 'process');
  assert.equal(
    groupThought(liveGroup, lookup([req, work2, oldLoadedThought, liveThought])),
    'Streaming live thought',
  );
  assert.equal(
    groupLatestIsThought(liveGroup, lookup([req, work2, oldLoadedThought, liveThought])),
    true,
  );

  // Conversation view without work summary derives both thought and title from group.rowIds.
  const ungrouped = projectProcessGroups({
    rows: [req, oldLoadedThought],
    toolActivity: [],
    activeTurnId: 'run',
  });
  const ungroupedProc = ungrouped.entries.find((entry) => entry.kind === 'process');
  assert.equal(
    groupThought(ungroupedProc, lookup([req, oldLoadedThought])),
    'Old expanded thought',
  );
  assert.equal(groupLatestIsThought(ungroupedProc, lookup([req, oldLoadedThought])), true);

  // Streaming answer closes groups so folded TurnSummary clears its peek.
  const streamingAnswer = row('ans', 'Here is the review', 20, {
    role: 'assistant',
    field: 'body',
    finalAnswer: true,
  });
  const answering = projectProcessGroups({
    rows: [req, work2, streamingAnswer],
    toolActivity: [],
    activeTurnId: 'run',
    answerTurnId: 'run',
  });
  const closedGroups = answering.entries.filter((entry) => entry.kind === 'process');
  assert.equal(turnThought(closedGroups, lookup([req, work2, streamingAnswer])), null);
});
