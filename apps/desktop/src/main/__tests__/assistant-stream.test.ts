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
import {
  ASSISTANT_MAX_DELTA_CHARS,
  ASSISTANT_MAX_TOTAL_CHARS,
  applyAssistantComplete,
  applyAssistantDelta,
} from '@maka/ui/assistant-stream';

function visibleDeltaResult(result: ReturnType<typeof applyAssistantDelta>) {
  return {
    text: result.text,
    redacted: result.redacted,
    truncated: result.truncated,
  };
}

describe('assistant stream state boundary', () => {
  it('appends valid deltas and drops malformed input', () => {
    assert.deepEqual(visibleDeltaResult(applyAssistantDelta('', 'hello')), {
      text: 'hello',
      redacted: false,
      truncated: false,
    });
    assert.equal(applyAssistantDelta('hello ', 'world').text, 'hello world');
    assert.equal(applyAssistantDelta(undefined as unknown as string, 'x').text, 'x');
    assert.equal(applyAssistantDelta(null as unknown as string, 'x').text, 'x');

    for (const delta of [undefined, null, 42, {}, [], true, '']) {
      assert.deepEqual(visibleDeltaResult(
        applyAssistantDelta('so far', delta as unknown as string),
      ), {
        text: 'so far',
        redacted: false,
        truncated: false,
      });
    }
  });

  it('redacts secrets before they enter state', () => {
    for (const secret of [
      'sk-test-abc-1234567890',
      'sk-abcdef1234567890abcdef1234567890',
    ]) {
      const result = applyAssistantDelta('', `Authorization: Bearer ${secret}`);
      assert.equal(result.text.includes(secret), false);
      assert.equal(result.redacted, true);
    }
    assert.deepEqual(visibleDeltaResult(applyAssistantDelta('', 'normal prose')), {
      text: 'normal prose',
      redacted: false,
      truncated: false,
    });
  });

  it('enforces per-delta limits without truncating exact-boundary input', () => {
    const oversized = applyAssistantDelta('', 'word '.repeat(ASSISTANT_MAX_DELTA_CHARS));
    assert.ok(oversized.text.length <= ASSISTANT_MAX_DELTA_CHARS);
    assert.ok(oversized.text.startsWith('\n[…单条 delta 已截断]\n'));
    assert.equal(oversized.truncated, true);

    const overridden = applyAssistantDelta('', 'aaaaaaaa', { maxDeltaChars: 4 });
    assert.equal(overridden.truncated, true);

    const exact = applyAssistantDelta('', 'x'.repeat(ASSISTANT_MAX_DELTA_CHARS));
    assert.equal(exact.text.length, ASSISTANT_MAX_DELTA_CHARS);
    assert.equal(exact.truncated, false);
  });

  it('enforces total limits and keeps truncation monotonic after the cap', () => {
    const big = 'word '.repeat(ASSISTANT_MAX_TOTAL_CHARS / 5 + 100);
    const first = applyAssistantDelta('', big, { maxDeltaChars: big.length });
    assert.ok(first.text.length <= ASSISTANT_MAX_TOTAL_CHARS);
    assert.ok(first.text.endsWith('\n\n[…后续已截断]'));
    assert.equal(first.truncated, true);

    const dropped = applyAssistantDelta(first.text, 'more');
    assert.equal(dropped.text, first.text);
    assert.equal(dropped.truncated, true);

    const overridden = applyAssistantDelta('', 'hello world this is too long', {
      maxTotalChars: 16,
    });
    assert.ok(overridden.text.length <= 16);
    assert.equal(overridden.truncated, true);

    assert.deepEqual(visibleDeltaResult(applyAssistantDelta('hi ', 'world', { maxTotalChars: 8 })), {
      text: 'hi world',
      redacted: false,
      truncated: false,
    });
  });

  it('redacts secrets before oversized deltas are truncated', () => {
    for (const [secret, raw] of [
      [
        'sk-abcdef1234567890abcdef1234567890',
        `leaked sk-abcdef1234567890abcdef1234567890 ${'word '.repeat(ASSISTANT_MAX_DELTA_CHARS)}`,
      ],
      [
        'sk-deadbeef00000000deadbeef00000000',
        `${'lorem ipsum dolor sit amet '.repeat(200)} sk-deadbeef00000000deadbeef00000000`,
      ],
    ] as const) {
      const result = applyAssistantDelta('', raw);
      assert.equal(result.text.includes(secret), false);
      assert.equal(result.redacted, true);
      assert.equal(result.truncated, true);
    }
  });

  it('redacts opaque tokens completed across delta seams', () => {
    const firstHalf = 'a1b2c3d4e5f60718293a4b5c';
    const secondHalf = '6d7e8f9012345678abcdef';
    const first = applyAssistantDelta('', firstHalf);
    assert.equal(first.redacted, false);
    assert.ok(first.redactionState);

    const second = applyAssistantDelta(first.text, secondHalf, {
      redactionState: first.redactionState,
    });
    assert.equal(second.text.includes(firstHalf + secondHalf), false);
    assert.equal(second.redacted, true);

    const completed = applyAssistantDelta('Token: sk-', 'abcdef0123456789abcdef0123456789');
    assert.equal(completed.text.includes('sk-abcdef0123456789abcdef0123456789'), false);
    assert.equal(completed.redacted, true);
  });

  it('never exposes a secret streamed through tiny deltas', () => {
    const secret = 'sk-deadbeef00000000deadbeef00000000';
    let text = '';
    let redacted = false;
    let redactionState: NonNullable<ReturnType<typeof applyAssistantDelta>['redactionState']>
      | undefined;
    for (const delta of `Authorization: Bearer ${secret}`) {
      const result = applyAssistantDelta(text, delta, {
        ...(redactionState === undefined ? {} : { redactionState }),
      });
      text = result.text;
      redacted ||= result.redacted;
      redactionState = result.redactionState;
    }
    assert.equal(text.includes(secret), false);
    assert.equal(redacted, true);
  });

  it('replaces state from complete payloads using only total limits', () => {
    assert.deepEqual(applyAssistantComplete(''), {
      text: '',
      redacted: false,
      truncated: false,
    });

    const underTotal = 'word '.repeat(Math.ceil(ASSISTANT_MAX_DELTA_CHARS / 5) + 20);
    assert.ok(underTotal.length > ASSISTANT_MAX_DELTA_CHARS);
    assert.deepEqual(applyAssistantComplete(underTotal), {
      text: underTotal,
      redacted: false,
      truncated: false,
    });

    const secret = 'sk-abcdef1234567890abcdef1234567890';
    const capped = applyAssistantComplete(`token ${secret} tail that is too long`, {
      maxTotalChars: 24,
    });
    assert.equal(capped.text.includes(secret), false);
    assert.ok(capped.text.endsWith('\n\n[…后续已截断]'));
    assert.equal(capped.redacted, true);
    assert.equal(capped.truncated, true);
  });
});
