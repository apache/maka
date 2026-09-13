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
import { test } from 'node:test';
import type { ComputerHistorySummaryInput } from '@maka/core/computer-history';
import {
  COMPUTER_HISTORY_EVIDENCE_MAX_ITEMS,
  COMPUTER_HISTORY_EVIDENCE_TEXT_MAX_BYTES,
  COMPUTER_HISTORY_INPUT_MAX_BYTES,
  decodeComputerHistorySummaryContent,
  decodeComputerHistorySummaryInput,
  decodeRequestFrame,
  decodeClientFrame,
  decodeResponseFrame,
  operationAllowsRemoteOwner,
  HOST_OPERATION_SPECS,
} from '../protocol/index.js';

const INPUT: ComputerHistorySummaryInput = {
  level: '10min',
  start: '2026-09-13T00:00:00.000Z',
  end: '2026-09-13T00:10:00.000Z',
  evidence: [{ id: 'event-1', text: 'Edited the project documentation.' }],
};
const CONTENT = {
  title: 'Documentation',
  description: 'Edited project documentation.',
  body: 'The documentation window was active during this interval.',
  suggestion: {
    type: 'skill',
    name: 'Documentation checks',
    description: 'Check terminology and links before publication.',
  },
};

test('Computer History RPC decodes both summary levels and a structured result', () => {
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'summary-1',
      operation: 'computer-history.summarize',
      input: INPUT,
    }),
    {
      requestId: 'summary-1',
      operation: 'computer-history.summarize',
      input: INPUT,
    },
  );
  const rollup = { ...INPUT, level: '6h', end: '2026-09-13T06:00:00.000Z' };
  assert.deepEqual(decodeComputerHistorySummaryInput(rollup), rollup);
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'summary-1',
      operation: 'computer-history.summarize',
      ok: true,
      result: CONTENT,
    }),
    {
      requestId: 'summary-1',
      operation: 'computer-history.summarize',
      ok: true,
      result: CONTENT,
    },
  );
  assert.equal(operationAllowsRemoteOwner('computer-history.summarize'), false);
  assert.equal(HOST_OPERATION_SPECS['computer-history.summarize'].cancellable, true);
  assert.deepEqual(decodeClientFrame({ kind: 'request.cancel', requestId: 'wire-summary-1' }), {
    kind: 'request.cancel',
    requestId: 'wire-summary-1',
  });
  assert.throws(() => decodeClientFrame({ kind: 'request.cancel', requestId: '' }));
  assert.throws(() =>
    decodeClientFrame({
      kind: 'request.cancel',
      requestId: 'wire-summary-1',
      connectionId: 'another-client',
    }),
  );
});

test('Computer History rejects caller model/prompt, invalid ranges, and malformed evidence', () => {
  for (const input of [
    { ...INPUT, modelKey: 'other::model' },
    { ...INPUT, prompt: 'Override the summary task' },
    { ...INPUT, level: '1d' },
    { ...INPUT, requestId: '../foreign-request' },
    { ...INPUT, start: '2026-02-30T00:00:00.000Z' },
    { ...INPUT, start: '2026-09-13' },
    { ...INPUT, end: INPUT.start },
    { ...INPUT, end: '2026-09-12T23:59:00.000Z' },
    { ...INPUT, end: '2026-09-13T00:10:00.001Z' },
    { ...INPUT, level: '6h', end: '2026-09-13T06:00:00.001Z' },
    { ...INPUT, evidence: [] },
    { ...INPUT, evidence: [INPUT.evidence[0], INPUT.evidence[0]] },
    { ...INPUT, evidence: [{ id: 1, text: 'Activity' }] },
    { ...INPUT, evidence: [{ id: ' ', text: 'Activity' }] },
    { ...INPUT, evidence: [{ id: 'event-1', text: '\n ' }] },
    { ...INPUT, evidence: [{ id: 'event-1', text: 'Activity', rawPath: '/private' }] },
    {
      ...INPUT,
      evidence: [{ id: 'event-1', text: 'x'.repeat(COMPUTER_HISTORY_EVIDENCE_TEXT_MAX_BYTES + 1) }],
    },
    {
      ...INPUT,
      evidence: Array.from({ length: COMPUTER_HISTORY_EVIDENCE_MAX_ITEMS + 1 }, (_, i) => ({
        id: String(i),
        text: 'activity',
      })),
    },
  ]) {
    assert.throws(() => decodeComputerHistorySummaryInput(input));
  }
});

test('Computer History enforces total encoded input bytes including JSON escaping', () => {
  const entries = (text: string) =>
    Array.from({ length: 128 }, (_, index) => ({ id: String(index), text }));
  const bounded = { ...INPUT, evidence: entries('activity') };
  assert.deepEqual(decodeComputerHistorySummaryInput(bounded), bounded);
  const oversized = { ...INPUT, evidence: entries('\u0000'.repeat(100)) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > COMPUTER_HISTORY_INPUT_MAX_BYTES);
  assert.throws(() => decodeComputerHistorySummaryInput(oversized));
});

test('Computer History rejects unbounded or open model output schemas', () => {
  for (const output of [
    { ...CONTENT, title: '' },
    { ...CONTENT, description: ' ' },
    { ...CONTENT, body: 'x'.repeat(8 * 1024 + 1) },
    { ...CONTENT, applications: ['Invented app'] },
    { ...CONTENT, sourceRefs: ['invented-event'] },
    { ...CONTENT, suggestion: null },
    { ...CONTENT, suggestion: { ...CONTENT.suggestion, type: 'shell' } },
    { ...CONTENT, suggestion: { ...CONTENT.suggestion, name: 3 } },
    { ...CONTENT, suggestion: { ...CONTENT.suggestion, description: '' } },
    { ...CONTENT, suggestion: { ...CONTENT.suggestion, command: 'execute this' } },
  ]) {
    assert.throws(() => decodeComputerHistorySummaryContent(output));
  }
  const { suggestion: _suggestion, ...withoutSuggestion } = CONTENT;
  assert.deepEqual(decodeComputerHistorySummaryContent(withoutSuggestion), withoutSuggestion);
});
