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

/** Thinking may echo credentials, so renderer state keeps a second redaction boundary. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyThinkingComplete, applyThinkingDelta } from '@maka/ui';

describe('applyThinkingDelta — secondary redaction', () => {
  it('masks raw `Authorization: Bearer ...` text before storing', () => {
    const result = applyThinkingDelta(
      'reasoning so far...\n',
      'I should call the API with Authorization: Bearer sk-test1234567890ABCDEF and check the response',
    );
    assert.equal(result.redacted, true);
    // The actual mask token comes from @maka/ui redactSecrets; the
    // contract that matters is the raw bearer never survives.
    assert.equal(
      result.text.includes('sk-test1234567890ABCDEF'),
      false,
      'raw token must NOT survive into stored thinking state',
    );
  });

  it('masks bare API-key prefixes inside thinking', () => {
    const result = applyThinkingDelta('', 'planning to use sk-ant-1234567890abcdefghijklmnopqrstuvwxyz for this');
    assert.equal(result.redacted, true);
    assert.equal(
      result.text.includes('sk-ant-1234567890abcdefghijklmnopqrstuvwxyz'),
      false,
    );
  });
});

describe('applyThinkingComplete — final replace path', () => {
  it('redacts secrets in the final payload', () => {
    const result = applyThinkingComplete('final thinking with Authorization: Bearer sk-secret123ABC ...');
    assert.equal(result.redacted, true);
    assert.equal(result.text.includes('sk-secret123ABC'), false);
  });
});

describe('applyThinkingDelta — combined secret + oversize', () => {
  it('secret never appears in stored text regardless of which gate fires', () => {
    const noise = 'reasoning step '.repeat(2000); // > maxDelta
    const secret = 'Authorization: Bearer sk-secret1234567890ABCDEF';
    const result = applyThinkingDelta('', noise + secret);
    // Either redaction or truncation (or both) may have fired; the
    // ONLY contract that matters here: secret never in result.text.
    assert.equal(result.text.includes('sk-secret1234567890ABCDEF'), false);
  });
});
