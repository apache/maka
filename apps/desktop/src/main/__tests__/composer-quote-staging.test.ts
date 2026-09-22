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
import { QUOTE_COMMENT_MAX_LENGTH, type QuoteRef } from '@maka/core/events';
import { stageQuoteInBucket } from '../../renderer/features/conversation/testing.js';

// The transcript's marks and the editor's re-resolve both identify a staged
// quote by (text, sourceTurnId). stageQuoteInBucket is the single write path
// that keeps that identity unique.
describe('stageQuoteInBucket', () => {
  test('a byte-identical stage folds into the existing quote instead of duplicating', () => {
    const bucket: QuoteRef[] = [{ text: 'the excerpt', sourceTurnId: 'turn-1' }];
    stageQuoteInBucket(bucket, { text: 'the excerpt', turnId: 'turn-1' });
    assert.equal(bucket.length, 1);
  });

  test('a repeated stage carrying a note updates the existing quote in place', () => {
    const bucket: QuoteRef[] = [{ text: 'the excerpt', sourceTurnId: 'turn-1' }];
    stageQuoteInBucket(bucket, { text: 'the excerpt', turnId: 'turn-1', comment: 'check this' });
    assert.equal(bucket.length, 1);
    assert.equal(bucket[0]?.comment, 'check this');
  });

  test('same text on a different turn is a different quote', () => {
    const bucket: QuoteRef[] = [{ text: 'the excerpt', sourceTurnId: 'turn-1' }];
    stageQuoteInBucket(bucket, { text: 'the excerpt', turnId: 'turn-2' });
    assert.equal(bucket.length, 2);
  });

  test('the staged comment is capped at the protocol bound', () => {
    const bucket: QuoteRef[] = [];
    stageQuoteInBucket(bucket, {
      text: 'the excerpt',
      turnId: 'turn-1',
      comment: 'x'.repeat(QUOTE_COMMENT_MAX_LENGTH + 50),
    });
    assert.equal(bucket[0]?.comment?.length, QUOTE_COMMENT_MAX_LENGTH);
  });
});
