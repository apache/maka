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

/**
 * The shared pipeline directly, not through `applyAssistantDelta` /
 * `applyThinkingDelta`. Those wrappers only ever exercise one `recovery`
 * direction each, so a change that broke the other direction — or that made
 * the two agree where they must differ — would not fail there first.
 *
 * Markers here are short ASCII stand-ins so every expectation can name the
 * exact resulting string rather than assert a shape.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyStreamComplete,
  applyStreamDelta,
  type StreamDeltaSpec,
} from '../stream-delta.js';

const CHUNK = '[C]';
const TOTAL = '[T]';

function spec(overrides: Partial<StreamDeltaSpec> = {}): StreamDeltaSpec {
  return {
    maxDeltaChars: 1024,
    maxTotalChars: 8,
    recovery: 'head',
    chunkMarker: CHUNK,
    totalMarker: TOTAL,
    ...overrides,
  };
}

describe('applyStreamDelta — the two recovery directions', () => {
  it('head-keeps the prefix and tail-keeps the most recent, from one input', () => {
    const head = applyStreamDelta('', 'abcdefghij', spec({ recovery: 'head' }));
    const tail = applyStreamDelta('', 'abcdefghij', spec({ recovery: 'tail' }));

    // maxTotalChars 8 minus a 3-char marker leaves 5 characters of content.
    assert.equal(head.text, `abcde${TOTAL}`);
    assert.equal(tail.text, `${TOTAL}fghij`);
    assert.equal(head.text.length, 8);
    assert.equal(tail.text.length, 8);
    assert.equal(head.truncated, true);
    assert.equal(tail.truncated, true);
  });

  it('drops the carried state only where head-keep cut the suffix it describes', () => {
    const headCut = applyStreamDelta('', 'abcdefghij', spec({ recovery: 'head' }));
    const tailCut = applyStreamDelta('', 'abcdefghij', spec({ recovery: 'tail' }));
    const headUncut = applyStreamDelta('', 'abc', spec({ recovery: 'head' }));

    assert.equal('redactionState' in headCut, false);
    assert.notEqual(tailCut.redactionState, undefined);
    assert.notEqual(headUncut.redactionState, undefined);
    assert.equal(headUncut.truncated, false);
  });

  it('freezes a full head-kept buffer and keeps a tail-kept window sliding', () => {
    const frozen = `abcde${TOTAL}`;
    const dropped = applyStreamDelta(frozen, 'more', spec({ recovery: 'head' }));
    assert.deepEqual(dropped, { text: frozen, redacted: false, truncated: true });

    const sliding = `${TOTAL}fghij`;
    const advanced = applyStreamDelta(sliding, 'KL', spec({ recovery: 'tail' }));
    assert.equal(advanced.text, `${TOTAL}hijKL`);
    assert.equal(advanced.truncated, true);
  });

  it('caps an oversize single delta the same way in both directions', () => {
    // Well under the total cap, so only the per-delta gate can fire.
    const perDelta = spec({ maxDeltaChars: 6, maxTotalChars: 1024 });
    const expected = `xy${CHUNK}fgh`;

    assert.equal(
      applyStreamDelta('xy', 'abcdefgh', { ...perDelta, recovery: 'head' }).text,
      expected,
    );
    assert.equal(
      applyStreamDelta('xy', 'abcdefgh', { ...perDelta, recovery: 'tail' }).text,
      expected,
    );
  });
});

describe('applyStreamDelta — defensive guard', () => {
  it('drops a non-string delta without claiming redaction, in both directions', () => {
    for (const recovery of ['head', 'tail'] as const) {
      assert.deepEqual(
        applyStreamDelta('so far', undefined as unknown as string, spec({ recovery })),
        { text: 'so far', redacted: false, truncated: false },
      );
    }
    assert.equal(
      applyStreamDelta(undefined as unknown as string, 42 as unknown as string, spec()).text,
      '',
    );
  });

  it('passes the caller state straight back through the guard', () => {
    const seeded = applyStreamDelta('', 'seed', spec({ maxTotalChars: 1024 }));
    const carried = seeded.redactionState;
    assert.notEqual(carried, undefined);

    const guarded = applyStreamDelta('seed', null as unknown as string, {
      ...spec({ maxTotalChars: 1024 }),
      redactionState: carried,
    });
    assert.equal(guarded.redactionState, carried);
  });
});

describe('applyStreamComplete', () => {
  it('applies the total cap in the direction it was given', () => {
    assert.equal(
      applyStreamComplete('abcdefghij', {
        maxTotalChars: 8,
        recovery: 'head',
        totalMarker: TOTAL,
      }).text,
      `abcde${TOTAL}`,
    );
    assert.equal(
      applyStreamComplete('abcdefghij', {
        maxTotalChars: 8,
        recovery: 'tail',
        totalMarker: TOTAL,
      }).text,
      `${TOTAL}fghij`,
    );
  });

  it('redacts before the cap and reports it', () => {
    const result = applyStreamComplete(
      'Authorization: Bearer sk-secret123ABCDEFGHIJKLMNOP',
      { maxTotalChars: 1024, recovery: 'head', totalMarker: TOTAL },
    );
    assert.equal(result.redacted, true);
    assert.equal(result.truncated, false);
    assert.equal(result.text.includes('sk-secret123ABCDEFGHIJKLMNOP'), false);
  });

  it('returns empty for a non-string payload', () => {
    assert.deepEqual(
      applyStreamComplete(undefined as unknown as string, {
        maxTotalChars: 8,
        recovery: 'tail',
        totalMarker: TOTAL,
      }),
      { text: '', redacted: false, truncated: false },
    );
  });
});
