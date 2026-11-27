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
import { LivePreviewAccumulator } from '../app/streaming.ts';

const textPart = (ordinal, startedAt, text, textKind = 'thinking') => ({
  ordinal,
  startedAt,
  field: { kind: 'text', textKind },
  offset: 0,
  text,
});
const toolPart = (toolUseId, startedAt, text, offset = 0, ordinal = null) => ({
  ordinal,
  startedAt,
  field: { kind: 'tool_input', toolUseId, name: `Tool ${toolUseId}` },
  offset,
  text,
});
const cut = (revision, parts) => ({
  kind: 'cut',
  hostEpoch: 'host',
  runId: 'run',
  stepId: 'step',
  attemptId: 'attempt',
  revision,
  parts,
});
const labels = (snapshot) =>
  snapshot.activity.map((entry) => (entry.kind === 'thinking' ? entry.text : entry.tool.name));

test('preview weaves unnumbered tools into model order and appends same-part UTF-8 chunks', () => {
  const preview = new LivePreviewAccumulator();
  // The first cut can list unnumbered tool inputs after every text part.
  preview.applyPreviewPage(
    cut(1, [
      textPart(2, 30, 'Think 2'),
      textPart(0, 10, 'Café'),
      textPart(4, 50, 'Answer', 'text'),
      toolPart('A', 20, 'é'),
      toolPart('B', 40, ''),
    ]),
  );
  const next = preview.applyPreviewPage(
    cut(2, [{ ...textPart(0, 10, ' first'), offset: 5 }, toolPart('A', 20, 'clair', 2)]),
  );
  assert.deepEqual(labels(next), ['Café first', 'Tool A', 'Think 2', 'Tool B']);
  assert.equal(next.thinking, 'Café first\n\nThink 2');
  assert.equal(next.body, 'Answer');
  assert.deepEqual(
    next.tools.map(({ toolUseId, inputPreview }) => [toolUseId, inputPreview]),
    [
      ['A', 'éclair'],
      ['B', ''],
    ],
  );
});

test('equal-time tools keep first arrival order across repeated updates and ordinal ties', () => {
  const preview = new LivePreviewAccumulator();
  preview.applyPreviewPage(
    cut(1, [
      textPart(7, 10, 'First'),
      toolPart('A', 10, 'initial'),
      textPart(8, 10, 'Second'),
      toolPart('B', 10, ''),
      toolPart('C', 10, '', 0, 8),
    ]),
  );
  const next = preview.applyPreviewPage(
    cut(2, [toolPart('C', 10, 'new'), toolPart('A', 10, 'new')]),
  );
  assert.deepEqual(labels(next), ['First', 'Tool A', 'Second', 'Tool B', 'Tool C']);
});

test('a replayed UTF-8 prefix cannot truncate a part extended by overlapping slices', () => {
  const preview = new LivePreviewAccumulator();
  const prefix = textPart(0, 10, 'Café');
  preview.applyPreviewPage(cut(2, [prefix]));
  preview.applyPreviewPage(cut(2, [{ ...prefix, offset: 3, text: 'éAB' }]));
  assert.equal(preview.applyPreviewPage(cut(2, [prefix])).thinking, 'CaféAB');
  assert.equal(preview.applyPreviewPage(cut(3, [textPart(0, 10, 'CaféABC')])).thinking, 'CaféABC');
});

test('handoff ignores old and same-revision cuts while pending and after completion', () => {
  const preview = new LivePreviewAccumulator();
  const page = cut(2, [textPart(0, 10, 'First step')]);
  preview.applyPreviewPage(page);
  preview.applyPreviewPage({ kind: 'empty', hostEpoch: 'host' });
  assert.equal(preview.applyPreviewPage({ ...page, revision: 1 }).awaitingHistoryHandoff, true);
  assert.equal(preview.applyPreviewPage(page).awaitingHistoryHandoff, true);
  const complete = preview.completeHandoffIfPending();
  assert.ok(complete);
  assert.equal(complete.thinking, '');
  assert.equal(preview.applyPreviewPage(page).thinking, '');

  const next = preview.applyPreviewPage({
    ...cut(1, [textPart(0, 20, 'Next step')]),
    stepId: 'next',
    attemptId: 'next',
  });
  assert.equal(next.thinking, 'Next step');
  assert.equal(next.awaitingHistoryHandoff, false);
  assert.equal(preview.applyPreviewPage(page).thinking, 'Next step');
});

test('a newer revision of the same attempt can supersede a pending handoff', () => {
  const preview = new LivePreviewAccumulator();
  preview.applyPreviewPage(cut(2, [textPart(0, 10, 'Café')]));
  preview.beginHandoff();
  const newer = preview.applyPreviewPage(cut(3, [{ ...textPart(0, 10, 'AB'), offset: 5 }]));
  assert.equal(newer.thinking, 'CaféAB');
  assert.equal(newer.awaitingHistoryHandoff, false);
  assert.equal(preview.completeHandoffIfPending(), null);
});

test('a full slice repairs a preview that resumed from a nonzero byte after handoff', () => {
  const preview = new LivePreviewAccumulator();
  preview.applyPreviewPage(cut(2, [textPart(0, 10, 'Café')]));
  preview.beginHandoff();
  assert.ok(preview.completeHandoffIfPending());

  const resumed = preview.applyPreviewPage(cut(3, [{ ...textPart(0, 10, 'AB'), offset: 5 }]));
  assert.equal(resumed.thinking, 'AB');
  assert.equal(preview.applyPreviewPage(cut(3, [textPart(0, 10, 'CaféAB')])).thinking, 'CaféAB');
});

test('an overlapping prefix restores missing bytes without discarding the newer suffix', () => {
  const preview = new LivePreviewAccumulator();
  preview.applyPreviewPage(cut(1, [{ ...textPart(0, 10, 'AB'), offset: 5 }]));
  assert.equal(preview.applyPreviewPage(cut(1, [textPart(0, 10, 'CaféA')])).thinking, 'CaféAB');
});
