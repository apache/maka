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
import { orderProcessRows, projectProcessGroups } from '../app/processGroups.ts';

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
  for (let step = 0; step < 64; step += 1) {
    const sequence = 10 + step * 5;
    const invocation = `run-${step}`;
    overlay.event(event(sequence, { kind: 'opened' }, invocation));
    overlay.page(
      cut([textPart('reply', 'background reply')], {
        invocationId: invocation,
        turnId: invocation,
        dependsOn: sequence + 1,
      }),
    );
    overlay.event(
      event(
        sequence + 2,
        { kind: 'part_committed', stepId: 'step', messageId: 'reply', ordinal: 0 },
        invocation,
      ),
    );
    overlay.event(
      event(sequence + 3, { kind: 'step_ended', stepId: 'step', completed: true }, invocation),
    );
    overlay.event(event(sequence + 4, { kind: 'ended', failed: false }, invocation));
  }
  overlay.event(event(400, { kind: 'opened' }, 'current'));
  overlay.page(
    cut([textPart('current-reply', 'current response')], {
      invocationId: 'current',
      turnId: 'current',
      dependsOn: 401,
    }),
  );
  overlay.history(index(tail), 401);
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

test('executor text survives snapshot reseeding and ends with the same canonical handoff', () => {
  const overlay = new TranscriptOverlay();
  overlay.event(event(1, { kind: 'opened' }));
  overlay.event(event(2, { kind: 'executor_started', messageId: 'executor' }));
  overlay.event(event(3, { kind: 'delta', stepId: 'run', partId: 'text', text: 'hello' }));
  overlay.observe({
    through: 3,
    run: { invocationId: 'run', turnId: 'run', state: 'running' },
    parts: [
      { stepId: 'run', partId: 'text', messageId: 'executor', textKind: 'text', startSequence: 2 },
    ],
  });
  overlay.event(event(4, { kind: 'delta', stepId: 'run', partId: 'text', text: ' world' }));
  overlay.event(event(5, { kind: 'step_ended', stepId: 'run', completed: true }));
  overlay.event(event(6, { kind: 'ended', failed: false }));
  overlay.page({ kind: 'empty', hostEpoch: 'epoch' });
  assert.deepEqual(texts(overlay), ['hello world']);
  const history = [row('executor', 'hello world', 2)];
  overlay.history(index(history), 6);
  assert.deepEqual(texts(overlay, history), ['hello world']);
});
