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
import {
  canRegenerateFromText,
  mergeChunks,
  openingUserMessage,
  updateHistoryMetadata,
} from '../../workbench/app/history.ts';

const user = (text, turnId, sequence) => ({
  key: String(sequence),
  messageId: String(sequence),
  role: 'user',
  field: 'body',
  text,
  turnId,
  position: { sourceSequence: sequence, itemIndex: 0 },
});

test('turn actions require a proven opening message across history windows', () => {
  const earlier = user('Previous request', 'earlier', 1);
  const opening = user('Build the application', 'current', 2);
  const followup = user('Keep the public API unchanged', 'current', 3);
  const before = { field: 'body', position: earlier.position, offset: 0 };
  assert.equal(openingUserMessage([followup], 'current', before), null);
  assert.equal(openingUserMessage([opening, followup], 'current', before), null);
  assert.equal(
    openingUserMessage([opening, followup], 'current', null)?.text,
    'Build the application',
  );
  assert.equal(
    openingUserMessage([earlier, opening, followup], 'current', before)?.text,
    'Build the application',
  );
});

test('regeneration waits for original metadata and retains reference exclusions across fragments', () => {
  const first = {
    ...user('Original request', 'current', 2),
    offset: 0,
    totalBytes: 20,
    attachments: [],
  };
  const later = { ...first, text: 'tail', offset: 16 };
  const [tail] = mergeChunks([], [later], false, 10);
  assert.equal(canRegenerateFromText(tail), false);
  const [plain] = updateHistoryMetadata([tail], [{ ...first, hasReferences: false }], 10);
  assert.equal(canRegenerateFromText(plain), true);
  const [referenced] = updateHistoryMetadata([tail], [{ ...first, hasReferences: true }], 10);
  assert.equal(canRegenerateFromText(referenced), false);
  const [continued] = mergeChunks([referenced], [later], false, 11);
  assert.equal(canRegenerateFromText(continued), false);
  const [attached] = updateHistoryMetadata(
    [tail],
    [{ ...first, attachments: [{ name: 'image.png' }] }],
    10,
  );
  assert.equal(canRegenerateFromText(attached), false);
});
