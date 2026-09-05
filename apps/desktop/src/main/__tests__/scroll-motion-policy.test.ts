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
import test from 'node:test';
import { resolveScrollMotionBehavior } from '../../renderer/scroll-motion-policy.js';

const base = {
  reducedMotionAttr: false,
  e2eFixtureAttr: false,
  prefersReducedMotion: false,
};

test('captures collapse scroll motion, and a fixture can ask for it back', () => {
  assert.equal(resolveScrollMotionBehavior(base), 'smooth');
  assert.equal(
    resolveScrollMotionBehavior({ ...base, e2eFixtureAttr: true }),
    'auto',
    'a capture is deterministic by default',
  );
  assert.equal(
    resolveScrollMotionBehavior({ ...base, e2eFixtureAttr: true, scrollMotionAttr: 'smooth' }),
    'smooth',
    'a fixture whose subject is scrolling opts back in',
  );
});

test('no fixture request outranks a preference for less motion', () => {
  for (const reduced of [
    { reducedMotionAttr: true },
    { prefersReducedMotion: true },
  ] as const) {
    assert.equal(
      resolveScrollMotionBehavior({
        ...base,
        ...reduced,
        e2eFixtureAttr: true,
        scrollMotionAttr: 'smooth',
      }),
      'auto',
    );
  }
});

test('a fixture can also ask for no motion outside a capture', () => {
  assert.equal(resolveScrollMotionBehavior({ ...base, scrollMotionAttr: 'auto' }), 'auto');
});
