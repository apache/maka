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
import { Preview } from '../app/preview.ts';
import { orderProcessRows, projectProcessGroups } from '../app/processGroups.ts';
import { updateToolActivity } from '../app/toolActivity.ts';

test('immutable preview seed, suffix and same ID canonical handoff use byte offsets', () => {
  const preview = new Preview();
  const page = (revision, offset, text, totalBytes = 8) => ({
    kind: 'cut',
    hostEpoch: 'epoch',
    invocationId: 'invocation',
    turnId: 'turn',
    stepId: 'step',
    revision,
    dependsOn: 17,
    first: offset === 0,
    last: offset + Buffer.byteLength(text) === totalBytes,
    parts: [
      {
        ordinal: 0,
        messageId: 'message',
        providerPartId: 'part',
        startedAt: 0,
        field: { kind: 'text', textKind: 'text' },
        offset,
        totalBytes,
        text,
      },
    ],
  });
  const canonical = new Map();
  let current = preview.page(page(1, 0, '🦀'), [], [], canonical);
  current = preview.page(page(1, 4, '中!'), current.rows, current.tools, canonical);
  current = preview.page(page(2, 8, '?', 9), current.rows, current.tools, canonical);
  assert.equal(current.rows[0].text, '🦀中!?');
  assert.equal(current.rows[0].sequence, undefined);
  assert.equal(current.rows[0].startSequence, undefined);
  current = preview.page(page(2, 0, '🦀中!?', 9), current.rows, current.tools, canonical);
  assert.equal(current.rows[0].text, '🦀中!?');
  preview.commit('invocation', 'step', 'message');
  assert.strictEqual(
    preview.page(page(3, 9, 'old', 12), current.rows, [], canonical).rows,
    current.rows,
  );
});

test('tool input preview reconnect replaces its display and canonical admission takes over', () => {
  const preview = new Preview();
  const page = (offset, text) => ({
    kind: 'cut',
    hostEpoch: 'epoch',
    invocationId: 'invocation',
    turnId: 'turn',
    stepId: 'step',
    revision: 1,
    dependsOn: 17,
    first: offset === 0,
    last: false,
    parts: [
      {
        ordinal: null,
        messageId: 'input',
        providerPartId: null,
        startedAt: 0,
        field: { kind: 'tool_input', toolUseId: 'tool', name: 'search', providerExecuted: false },
        offset,
        totalBytes: 6,
        text,
      },
    ],
  });
  let current = preview.page(page(0, '中'), [], [], new Map());
  current = preview.page(page(3, '文'), [], current.tools, new Map());
  assert.equal(current.tools[0].detail, '中文');
  current = preview.page(page(0, '中文'), [], current.tools, new Map());
  assert.equal(current.tools[0].detail, '中文');
  const admitted = updateToolActivity(current.tools, {
    sequence: 21,
    invocationId: 'invocation',
    turnId: 'turn',
    fact: { kind: 'tool_dispatched', toolUseId: 'tool', name: 'search' },
  });
  assert.equal(admitted[0].phase, 'running');
  assert.equal(admitted[0].startSequence, 21);
  assert.equal(admitted[0].previewOrder, undefined);
  assert.equal(preview.page(page(0, 'old'), [], admitted, new Map()).tools[0].phase, 'running');
});

test('pending tool input follows the same immutable cut’s thinking and intermediate reply', () => {
  const preview = new Preview();
  const part = (ordinal, messageId, field, text) => ({
    ordinal,
    messageId,
    providerPartId: null,
    startedAt: 0,
    field,
    offset: 0,
    totalBytes: Buffer.byteLength(text),
    text,
  });
  const current = preview.page(
    {
      kind: 'cut',
      hostEpoch: 'epoch',
      invocationId: 'invocation',
      turnId: 'turn',
      stepId: 'step',
      revision: 1,
      dependsOn: 17,
      first: true,
      last: true,
      parts: [
        part(0, 'thought', { kind: 'text', textKind: 'thinking' }, 'thinking'),
        part(1, 'reply', { kind: 'text', textKind: 'text' }, 'intermediate reply'),
        part(
          null,
          'input',
          {
            kind: 'tool_input',
            toolUseId: 'tool',
            name: 'todo_write',
            providerExecuted: false,
          },
          '{"todos":[',
        ),
      ],
    },
    [],
    [],
    new Map(),
  );
  const projection = projectProcessGroups({
    rows: orderProcessRows(current.rows),
    toolActivity: current.tools,
    activeTurnId: 'turn',
  });
  assert.deepEqual(
    projection.entries.map((entry) =>
      entry.kind === 'process'
        ? { kind: entry.kind, rows: entry.rowIds, tools: entry.toolIds }
        : { kind: entry.kind, row: entry.rowId },
    ),
    [
      { kind: 'process', rows: ['thought/thinking'], tools: [] },
      { kind: 'message', row: 'reply/body' },
      { kind: 'process', rows: [], tools: ['tool'] },
    ],
  );
});
