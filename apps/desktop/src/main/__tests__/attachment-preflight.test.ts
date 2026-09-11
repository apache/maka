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
import { describe, test } from 'node:test';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { preflightAttachmentItems } from '../../renderer/attachment-preflight.js';

describe('attachment preflight (before session create)', () => {
  test('rejects more than 8 items before any session is created', () => {
    const items = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => ({
      size: 100,
      source: { type: 'file' as const, file: { size: 100 } },
    }));
    assert.throws(() => preflightAttachmentItems(items), {
      message: 'attachment_ingest:count_limit',
    });
  });

  test('rejects an oversized File so no empty session is created', () => {
    assert.throws(
      () =>
        preflightAttachmentItems([
          { size: MAX_ATTACHMENT_BYTES + 1, source: { type: 'file', file: { size: MAX_ATTACHMENT_BYTES + 1 } } },
        ]),
      { message: 'attachment_ingest:item_too_large' },
    );
  });

  test('rejects an oversized approval-token attachment by pending size', () => {
    assert.throws(
      () =>
        preflightAttachmentItems([
          { size: MAX_ATTACHMENT_BYTES + 1, source: { type: 'approval', approvalId: 'a1' } },
        ]),
      { message: 'attachment_ingest:item_too_large' },
    );
  });

  test('rejects a duplicate approvalId', () => {
    const duplicate = [
      { size: 10, source: { type: 'approval' as const, approvalId: 'dup' } },
      { size: 10, source: { type: 'approval' as const, approvalId: 'dup' } },
    ];
    assert.throws(() => preflightAttachmentItems(duplicate), {
      message: 'attachment_ingest:duplicate_source',
    });
  });

  test('passes approval tokens and files under the cap', () => {
    assert.doesNotThrow(() =>
      preflightAttachmentItems([
        { size: 100, source: { type: 'approval', approvalId: 'a1' } },
        { size: 100, source: { type: 'file', file: { size: 100 } } },
      ]),
    );
  });
});