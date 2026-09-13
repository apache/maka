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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUserSessionName } from '../session-name.js';

describe('normalizeUserSessionName', () => {
  it('strips the deprecated Cf bidi-adjacent controls U+206A-206F (#3823)', () => {
    // The session-name surface shares one sanitizer with foreign-session, so a
    // gap in the character class reaches user-visible names too: two names
    // differing only by one of these render identically but compare unequal.
    for (let cp = 0x206a; cp <= 0x206f; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const result = normalizeUserSessionName(`alice${ch}bob`);
      assert.equal(result.ok, true, `U+${cp.toString(16).toUpperCase()} must normalize`);
      if (!result.ok) continue;
      assert.equal(
        result.value.includes(ch),
        false,
        `must strip U+${cp.toString(16).toUpperCase()} from a session name`,
      );
    }
  });

  it('leaves ordinary names untouched', () => {
    const result = normalizeUserSessionName('release triage');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 'release triage');
  });
});
