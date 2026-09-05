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
import { redactSecrets } from '@maka/ui';

describe('redactSecrets', () => {
  it('masks credential headers, query parameters, provider keys, and high-entropy tokens', () => {
    const cases: Array<[string, RegExp]> = [
      ['Authorization: Bearer sk-ant-api03-abc123def456ghi789jkl0mn1opq', /Bearer <redacted>/],
      ['Authorization: Basic dXNlcjpwYXNzd29yZA==', /Basic <redacted>/],
      ['X-API-Key: 1234567890abcdef1234567890abcdef', /X-API-Key: <redacted>/],
      ['https://x.com/p?access_token=abc&keep=ok', /access_token=<redacted>/],
      ['https://x.com/p?api-key=abc&keep=ok', /api-key=<redacted>/],
      ['use sk-proj-abcdefghijklmnopqrstuvwxyz1234567890abcdef', /<redacted>/],
      ['Anthropic sk-ant-api03-aabbccddeeffgghhiijjkk1122334455', /<redacted>/],
      ['Google AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', /<redacted>/],
      ['GitHub ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd', /<redacted>/],
      ['Slack xoxb-1234567890-abcdefghijklmnopqrstuvwx', /<redacted>/],
      [`hash=${'deadbeef'.repeat(6)}`, /hash=<redacted>/],
    ];
    for (const [input, expected] of cases) {
      const output = redactSecrets(input);
      assert.match(output, expected, input);
      assert.notEqual(output, input, input);
    }
  });

  it('preserves non-secret URL context and ordinary text', () => {
    const url = redactSecrets(
      'https://api.example.com/v1/chat?model=gpt-4o&api_key=secret123abc&user=alice',
    );
    assert.equal(url.includes('secret123abc'), false);
    assert.match(url, /https:\/\/api\.example\.com\/v1\/chat/);
    assert.match(url, /model=gpt-4o/);
    assert.match(url, /user=alice/);

    for (const text of ['', 'Connection refused', 'Permission denied for /tmp/file.txt']) {
      assert.equal(redactSecrets(text), text);
    }
  });
});
