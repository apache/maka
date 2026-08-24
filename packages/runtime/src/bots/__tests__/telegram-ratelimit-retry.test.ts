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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../telegram-bridge.js';

const { classifyTelegramSendResponse } = __TEST__;

describe('classifyTelegramSendResponse', () => {
  it('returns the optional message id on successful responses', () => {
    assert.deepEqual(classifyTelegramSendResponse({ ok: true, result: { message_id: 12345 } }), {
      kind: 'ok',
      messageId: '12345',
    });
    assert.deepEqual(classifyTelegramSendResponse({ ok: true, result: {} }), {
      kind: 'ok',
      messageId: null,
    });
  });

  it('clamps Telegram retry hints to the bounded retry window', () => {
    for (const [retryAfter, expected] of [
      [5, 5_000],
      [3600, 30_000],
      ['wat', 1_000],
    ] as const) {
      const result = classifyTelegramSendResponse({
        ok: false,
        error_code: 429,
        parameters: { retry_after: retryAfter },
      });
      assert.equal(result.kind, 'retry');
      if (result.kind === 'retry') assert.equal(result.delayMs, expected, String(retryAfter));
    }
  });

  it('classifies permanent and malformed failures with stable descriptions', () => {
    const cases: Array<[unknown, string]> = [
      [{ ok: false, error_code: 400, description: 'Bad Request' }, 'Bad Request'],
      [null, 'send-failed'],
    ];
    for (const [payload, description] of cases) {
      assert.deepEqual(classifyTelegramSendResponse(payload), { kind: 'fatal', description });
    }
  });
});
