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
import { truncateUtf16Safe } from '../text-sanitize.js';

describe('truncateUtf16Safe', () => {
  it('returns text under the budget unchanged', () => {
    assert.equal(truncateUtf16Safe('abc', 3), 'abc');
    assert.equal(truncateUtf16Safe('', 5), '');
  });

  it('cuts at the budget when the boundary is clean', () => {
    assert.equal(truncateUtf16Safe('abcdef', 4), 'abcd');
    // A whole pair that fits exactly is kept.
    assert.equal(truncateUtf16Safe('ab\u{1f98a}cd', 4), 'ab\u{1f98a}');
  });

  it('drops a dangling high surrogate when the cut splits a pair', () => {
    // 🦊 is U+1F98A: two code units, so a budget of 3 lands mid-pair.
    assert.equal(truncateUtf16Safe('ab\u{1f98a}cd', 3), 'ab');
    // Astral-only input: every odd budget lands mid-pair.
    const foxes = '\u{1f98a}'.repeat(4);
    assert.equal(truncateUtf16Safe(foxes, 5), '\u{1f98a}\u{1f98a}');
    assert.doesNotMatch(
      truncateUtf16Safe(foxes, 5),
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it('treats a zero or negative budget as empty', () => {
    assert.equal(truncateUtf16Safe('abc', 0), '');
    assert.equal(truncateUtf16Safe('abc', -1), '');
  });

  it('leaves a lone surrogate already inside the budget alone', () => {
    // Pre-existing malformed input is the caller's concern; only the cut
    // boundary is guaranteed.
    assert.equal(truncateUtf16Safe('ab\uD83Dcd', 10), 'ab\uD83Dcd');
  });
});
