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
import {
  conversationCopyCommitFailureDiagnostic,
  conversationCopyCommitFailureMessage,
} from '../server/session-revision-diagnostics.js';

describe('Session revision diagnostics', () => {
  test('surfaces the error code and redacted message', () => {
    const error = Object.assign(new Error('database is locked; apiKey=provider-secret'), {
      code: 'SQLITE_BUSY',
    });

    const message = conversationCopyCommitFailureMessage(error);

    assert.equal(
      message,
      'Session conversation copy could not be committed: SQLITE_BUSY: database is locked; apiKey=[redacted]',
    );
    assert.doesNotMatch(conversationCopyCommitFailureDiagnostic(error), /provider-secret/u);
  });

  test('bounds multibyte error messages to the operation protocol limit', () => {
    const message = conversationCopyCommitFailureMessage(
      new Error(`archive mismatch ${'归'.repeat(2048)}`),
    );

    assert.ok(Buffer.byteLength(message, 'utf8') <= 1024);
    assert.match(message, /…$/u);
  });

  test('does not duplicate a code already present in the error message', () => {
    const error = Object.assign(new Error('SQLITE_FULL: database or disk is full'), {
      code: 'SQLITE_FULL',
    });

    assert.equal(
      conversationCopyCommitFailureMessage(error),
      'Session conversation copy could not be committed: SQLITE_FULL: database or disk is full',
    );
  });
});
