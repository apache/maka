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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORTED_TEXT_FILE_BYTES,
  MAX_IMPORTED_TEXT_FILE_COUNT,
  preflightDroppedTextFilesForPromptImport,
} from '../text-file-import.js';

describe('dropped text file import preflight', () => {
  it('rejects empty, too many, and oversize batches before renderer reads file text', () => {
    assert.deepEqual(preflightDroppedTextFilesForPromptImport([]), {
      ok: false,
      reason: 'missing',
    });
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport(
        Array.from({ length: MAX_IMPORTED_TEXT_FILE_COUNT + 1 }, () => ({ size: 1 })),
      ),
      { ok: false, reason: 'too-many-files' },
    );
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport([{ size: MAX_IMPORTED_TEXT_FILE_BYTES + 1 }]),
      { ok: false, reason: 'too-large' },
    );
  });

  it('routes obvious non-text drops before renderer reads the full file', () => {
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport([
        { name: 'photo.png', type: 'image/png', size: 128 },
      ]),
      { ok: false, reason: 'unsupported-type' },
    );
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport([
        { name: 'brief.pdf', type: 'application/pdf', size: 128 },
      ]),
      { ok: false, reason: 'unsupported-type' },
    );
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport([{ name: 'sheet.xlsx', size: 128 }]),
      { ok: false, reason: 'office-file' },
    );
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport([
        {
          name: 'unknown',
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: 128,
        },
      ]),
      { ok: false, reason: 'office-file' },
    );
  });

  it('rejects sampled binary content with an unknown file type', () => {
    assert.deepEqual(
      preflightDroppedTextFilesForPromptImport([
        { name: 'payload', type: '', size: 128, sampleBytes: new Uint8Array([80, 78, 71, 0]) },
      ]),
      { ok: false, reason: 'unsupported-type' },
    );
  });
});
