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
import { redactSecrets } from '../redact.js';
import { applyAssistantComplete, applyAssistantDelta } from '../assistant-stream.js';
import { applyThinkingComplete, applyThinkingDelta } from '../thinking-stream.js';
import { applyLiveTurnEvent } from '../live-turn-projection.js';
import {
  appendStreamingDisplayRedaction,
  createStreamingDisplayRedactionState,
} from '../streaming-display-redaction.js';

function streamBySizes(input: string, sizes: readonly number[]): void {
  let projection: ReturnType<typeof applyLiveTurnEvent> | undefined;
  let source = '';
  let offset = 0;
  let sizeIndex = 0;
  while (offset < input.length) {
    const size = sizes[sizeIndex++ % sizes.length] ?? 1;
    const delta = input.slice(offset, offset + size);
    offset += delta.length;
    source += delta;
    projection = applyLiveTurnEvent(projection, {
      type: 'text_delta',
      id: `event-${offset}`,
      turnId: 'turn-1',
      messageId: 'message-1',
      ts: offset,
      text: delta,
    });
    const displayed = projection.steps[0]?.text?.text ?? '';
    assert.equal(
      displayed,
      redactSecrets(source),
      `prefix ${source.length}, sizes ${sizes}, source ${JSON.stringify(source)}`,
    );
  }
}

function partitions(length: number): number[][] {
  if (length === 0) return [[]];
  const result: number[][] = [];
  for (let mask = 0; mask < 2 ** (length - 1); mask += 1) {
    const sizes: number[] = [];
    let size = 1;
    for (let index = 0; index < length - 1; index += 1) {
      if ((mask & (1 << index)) === 0) size += 1;
      else {
        sizes.push(size);
        size = 1;
      }
    }
    sizes.push(size);
    result.push(sizes);
  }
  return result;
}

describe('streaming display redaction', () => {
  it('matches the whole-text oracle for every chunking of short inputs', () => {
    for (const input of ['api_key=x/y', 'token=abc', 'deadbeef/path']) {
      for (const sizes of partitions(input.length)) streamBySizes(input, sizes);
    }
  });

  it('covers separators, JWTs, opaque tokens, hashes, whitespace, and newlines', () => {
    const cases = [
      'api_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY tail',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature== tail',
      'x-api-key: opaque_value-with/slashes.and=padding tail',
      'opaque 0123456789abcdef0123456789abcdef01234567 tail',
      `commit ${'deadbeef'.repeat(5)}path/to/thing`,
      `Authorization:${' '.repeat(2_048)}Bearer arbitrary-secret-value tail`,
      'Authorization:\n\nBearer newline-secret-value tail',
      'x-api-key\n:\nnewline-api-key-value tail',
    ];
    for (const input of cases) {
      for (const sizes of [[1], [3], [7], [20], [64], [1, 31, 2, 127, 5]]) {
        streamBySizes(input, sizes);
      }
    }
  });

  it('matches randomized prefixes under deterministic arbitrary chunking', () => {
    let seed = 0x2990;
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const atoms = [
      'plain ', '\n', '/', '.', '=', '_', '-', '&', '?',
      'Authorization: Bearer ', 'api_key=', 'x-api-key: ',
      'sk-abcdef0123456789abcdef0123456789',
      '0123456789abcdef0123456789abcdef01234567',
      'deadbeefpath/to/thing',
    ];
    for (let run = 0; run < 250; run += 1) {
      let input = '';
      const atomCount = 3 + Math.floor(random() * 10);
      for (let index = 0; index < atomCount; index += 1) {
        input += atoms[Math.floor(random() * atoms.length)];
      }
      const sizes = Array.from(
        { length: 8 },
        () => 1 + Math.floor(random() * 37),
      );
      streamBySizes(input, sizes);
    }
  });

  it('settles completed lines while retaining only the mutable suffix', () => {
    const first = appendStreamingDisplayRedaction(
      '',
      `${'safe line\n'.repeat(2_000)}tail`,
      createStreamingDisplayRedactionState(),
    );
    assert.ok(first.state.settledChars > 10_000);
    assert.equal(first.state.pendingChars, 'tail'.length);

    const pending = appendStreamingDisplayRedaction(
      '',
      'Authorization:\n\n',
      createStreamingDisplayRedactionState(),
    );
    assert.equal(pending.state.settledChars, 0);
    assert.equal(pending.state.pendingChars, 'Authorization:\n\n'.length);
    assert.deepEqual(Object.keys(pending.state).sort(), ['pendingChars', 'settledChars']);
  });

  it('fails closed when a stateless bootstrap follows a redaction marker', () => {
    const source = `ghp_${'a'.repeat(40)}`;
    const previousText = redactSecrets(source);
    const continued = appendStreamingDisplayRedaction(previousText, 'suffix');
    assert.equal(continued.text, previousText);
    assert.equal(continued.redacted, true);

    const terminated = appendStreamingDisplayRedaction(
      continued.text,
      ' done',
      continued.state,
    );
    assert.equal(terminated.text, redactSecrets(`${source}suffix done`));
  });

  it('redacts cross-delta secrets before per-delta and total truncation', () => {
    for (const apply of [applyAssistantDelta, applyThinkingDelta]) {
      const initialState = createStreamingDisplayRedactionState();
      const opener = apply('', 'Authorization:', {
        maxDeltaChars: 128,
        maxTotalChars: 512,
        redactionState: initialState,
      });
      const secret = `Bearer ${'s'.repeat(5_000)}`;
      const truncated = apply(opener.text, secret, {
        maxDeltaChars: 128,
        maxTotalChars: 512,
        redactionState: opener.redactionState,
      });
      assert.equal(truncated.text.includes('s'.repeat(32)), false);
      assert.equal(truncated.truncated, true);
      assert.ok(
        (truncated.redactionState?.settledChars ?? 0)
          + (truncated.redactionState?.pendingChars ?? 0)
        <= 512,
      );

      const total = apply('', 'safe '.repeat(200), {
        maxDeltaChars: 2_000,
        maxTotalChars: 128,
        redactionState: createStreamingDisplayRedactionState(),
      });
      assert.equal(total.truncated, true);
      if (apply === applyAssistantDelta) {
        assert.equal(total.redactionState, undefined);
      } else {
        assert.ok(total.redactionState);
      }
    }
  });

  it('does not expose a secret continuation after an oversized contextual delta', () => {
    let projection = applyLiveTurnEvent(undefined, {
      type: 'text_delta', id: 'text-1', turnId: 'turn-1', messageId: 'message-1', ts: 1,
      text: 'Authorization: Bearer ',
    });
    projection = applyLiveTurnEvent(projection, {
      type: 'text_delta', id: 'text-2', turnId: 'turn-1', messageId: 'message-1', ts: 2,
      text: 's'.repeat(5_000),
    });
    const redactedPrefix = projection.steps[0]?.text?.text;
    projection = applyLiveTurnEvent(projection, {
      type: 'text_delta', id: 'text-3', turnId: 'turn-1', messageId: 'message-1', ts: 3,
      text: 'SECRET_CONTINUATION',
    });
    assert.equal(projection.steps[0]?.text?.text.includes('SECRET_CONTINUATION'), false);
    assert.equal(projection.steps[0]?.text?.text, redactedPrefix);
  });

  it('preserves an unfinished opener when production truncates a reseed delta', () => {
    for (const opener of [
      'Authorization: Bearer ',
      'x-api-key: ',
      'https://example.test/?access_token=',
    ]) {
      let projection = applyLiveTurnEvent(undefined, {
        type: 'text_delta', id: 'text-1', turnId: 'turn-1', messageId: 'message-1', ts: 1,
        text: `${'safe '.repeat(1_000)}${opener}`,
      });
      assert.equal(projection.steps[0]?.text?.truncated, true);

      const secret = 'secret-value-arriving-after-reseed';
      projection = applyLiveTurnEvent(projection, {
        type: 'text_delta', id: 'text-2', turnId: 'turn-1', messageId: 'message-1', ts: 2,
        text: secret,
      });
      const displayed = projection.steps[0]?.text?.text ?? '';
      assert.equal(displayed.includes(secret), false, opener);
      assert.match(displayed, /<redacted>$/u, opener);
    }
  });

  it('keeps contextual redaction bounded without changing the visible total cap', () => {
    for (const input of [
      `Authorization: Bearer ${'s'.repeat(2_000)}`,
      `https://example.test/?access_token=${'q'.repeat(2_000)}`,
      `x-api-key: ${'k'.repeat(2_000)}`,
    ]) {
      const result = applyAssistantDelta('', input, {
        maxDeltaChars: input.length,
        maxTotalChars: 256,
        redactionState: createStreamingDisplayRedactionState(),
        locale: 'en',
      });
      assert.equal(result.text, redactSecrets(input));
      assert.equal(result.truncated, false);
      assert.ok(
        (result.redactionState?.settledChars ?? 0)
          + (result.redactionState?.pendingChars ?? 0)
        <= 256,
      );
    }
  });

  it('settles prior redacted values so the complete retained raw suffix stays bounded', () => {
    const maxTotalChars = 256;
    const firstSecret = 'a'.repeat(5_000);
    const secondSecret = 'b'.repeat(5_000);
    const input = `Authorization: Bearer ${firstSecret} safe Authorization: Bearer ${secondSecret}`;
    const result = applyAssistantDelta('', input, {
      maxDeltaChars: input.length,
      maxTotalChars,
      locale: 'en',
    });

    assert.equal(result.text, redactSecrets(input));
    assert.ok(result.redactionState);
    assert.ok(result.redactionState.pendingChars <= maxTotalChars + 1);
    assert.equal(result.redactionState.settledChars <= result.text.length, true);
  });

  it('bounds reversible provider and opaque tokens, then recovers existing cap semantics', () => {
    const maxTotalChars = 64;
    const maxRecoveryChars = maxTotalChars + 1;
    const representativeTokenChars = 128;
    for (const [apply, complete] of [
      [applyAssistantDelta, applyAssistantComplete],
      [applyThinkingDelta, applyThinkingComplete],
    ] as const) {
      for (const input of [
        'a'.repeat(1_000),
        `sk-${'a'.repeat(1_000)}`,
        `ghp_${'a'.repeat(1_000)}`,
      ]) {
        const compacted = apply('', input, {
          maxDeltaChars: 2_000,
          maxTotalChars,
          locale: 'en',
        });
        assert.equal(compacted.text, redactSecrets(input));
        assert.ok(compacted.redactionState);
        assert.ok(
          compacted.redactionState.pendingChars
            + compacted.redactionState.settledChars
          <= 2 * maxRecoveryChars + representativeTokenChars,
        );

        const invalidatingCharacter = input.startsWith('ghp_') ? '_' : 'g';
        const invalidated = apply(compacted.text, invalidatingCharacter, {
          maxDeltaChars: 2_000,
          maxTotalChars,
          redactionState: compacted.redactionState,
          locale: 'en',
        });
        assert.equal(
          invalidated.text,
          complete(input + invalidatingCharacter, { maxTotalChars, locale: 'en' }).text,
        );
      }
    }
  });

  it('recovers reversible token invalidation after thinking tail truncation', () => {
    const maxTotalChars = 64;
    const source = `${'safe-prefix '.repeat(20)}ghp_${'a'.repeat(1_000)}`;
    const first = applyThinkingDelta('', source, {
      maxDeltaChars: source.length,
      maxTotalChars,
      locale: 'en',
    });
    assert.equal(first.truncated, true);
    assert.ok(first.redactionState);

    const invalidated = applyThinkingDelta(first.text, '_', {
      maxDeltaChars: source.length,
      maxTotalChars,
      redactionState: first.redactionState,
      locale: 'en',
    });
    assert.equal(
      invalidated.text,
      applyThinkingComplete(`${source}_`, { maxTotalChars, locale: 'en' }).text,
    );
  });

  it('continues thinking after a per-delta truncation below the total cap', () => {
    let projection = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta', id: 'thinking-1', turnId: 'turn-2',
      messageId: 'message-2', ts: 1, text: 'x'.repeat(5_000),
    });
    projection = applyLiveTurnEvent(projection, {
      type: 'thinking_delta', id: 'thinking-2', turnId: 'turn-2',
      messageId: 'message-2', ts: 2, text: 'VISIBLE_NEXT',
    });
    assert.equal(projection.steps[0]?.thinking?.text.includes('VISIBLE_NEXT'), true);
  });

  it('continues tail-kept thinking after the total cap without leaking an active secret', () => {
    const first = applyThinkingDelta(
      '',
      `${'safe '.repeat(40)}Authorization: Bearer ${'s'.repeat(1_000)}`,
      {
        maxDeltaChars: 2_000,
        maxTotalChars: 128,
        redactionState: createStreamingDisplayRedactionState(),
        locale: 'en',
      },
    );
    assert.equal(first.truncated, true);
    assert.ok(first.redactionState);

    const continuation = applyThinkingDelta(first.text, 'SECRET_CONTINUATION', {
      maxDeltaChars: 2_000,
      maxTotalChars: 128,
      redactionState: first.redactionState,
      locale: 'en',
    });
    assert.equal(continuation.text.includes('SECRET_CONTINUATION'), false);

    const terminated = applyThinkingDelta(continuation.text, ' done', {
      maxDeltaChars: 2_000,
      maxTotalChars: 128,
      redactionState: continuation.redactionState,
      locale: 'en',
    });
    assert.equal(terminated.text.endsWith(' done'), true);
  });

  it('recovers a contextual opener hidden by thinking tail truncation', () => {
    const maxTotalChars = 64;
    const source = `${'safe '.repeat(20)}Authorization:${' '.repeat(40)}`;
    const first = applyThinkingDelta('', source, {
      maxDeltaChars: source.length,
      maxTotalChars,
      locale: 'en',
    });
    assert.equal(first.truncated, true);
    assert.ok(first.redactionState);

    const continuation = 'Bearer secret-value done';
    const resumed = applyThinkingDelta(first.text, continuation, {
      maxDeltaChars: source.length,
      maxTotalChars,
      redactionState: first.redactionState,
      locale: 'en',
    });
    assert.equal(
      resumed.text,
      applyThinkingComplete(source + continuation, { maxTotalChars, locale: 'en' }).text,
    );
    assert.equal(resumed.text.endsWith(' done'), true);

    const overlongSource = `${'safe '.repeat(20)}Authorization:${' '.repeat(100)}`;
    const overlong = applyThinkingDelta('', overlongSource, {
      maxDeltaChars: overlongSource.length,
      maxTotalChars,
      locale: 'en',
    });
    assert.ok(overlong.redactionState);
    assert.ok(overlong.redactionState.pendingChars <= maxTotalChars + 1);
    const hiddenSecret = applyThinkingDelta(overlong.text, 'Bearer hidden-secret', {
      maxDeltaChars: overlongSource.length,
      maxTotalChars,
      redactionState: overlong.redactionState,
      locale: 'en',
    });
    assert.equal(hiddenSecret.text.includes('hidden-secret'), false);
    const afterLine = applyThinkingDelta(hiddenSecret.text, '\nVISIBLE', {
      maxDeltaChars: overlongSource.length,
      maxTotalChars,
      redactionState: hiddenSecret.redactionState,
      locale: 'en',
    });
    assert.equal(afterLine.text.endsWith('\nVISIBLE'), true);
  });
});
