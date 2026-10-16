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
import { describe, it } from 'node:test';
import { SHELL_WINDOW_MIN_WIDTH } from '../../shared/shell-layout-contract.js';
import {
  SAFE_MIN_HEIGHT,
  SAFE_MIN_WIDTH,
  sanitizeBounds,
} from '../window-state.js';

const defaults = { width: 1440, height: 900 };

describe('sanitizeBounds', () => {
  it('locks the restore floor to the shared window minimum', () => {
    assert.equal(SAFE_MIN_WIDTH, SHELL_WINDOW_MIN_WIDTH);
  });

  it('clamps a size saved below the floor instead of discarding the bounds', () => {
    assert.deepEqual(
      sanitizeBounds(
        { x: 10, y: 20, width: 520, height: 300, isMaximized: true },
        defaults,
      ),
      { x: 10, y: 20, width: SAFE_MIN_WIDTH, height: SAFE_MIN_HEIGHT, isMaximized: true },
    );
  });

  it('passes well-formed bounds through', () => {
    assert.deepEqual(
      sanitizeBounds({ x: 100, y: 50, width: 1280, height: 800, isMaximized: false }, defaults),
      { x: 100, y: 50, width: 1280, height: 800, isMaximized: false },
    );
  });

  it('returns the defaults for a missing or corrupt record', () => {
    assert.deepEqual(sanitizeBounds(null, defaults), defaults);
    assert.deepEqual(sanitizeBounds('bounds', defaults), defaults);
    assert.deepEqual(sanitizeBounds({ width: 0, height: 800 }, defaults), defaults);
    assert.deepEqual(sanitizeBounds({ width: 1280, height: -1 }, defaults), defaults);
    assert.deepEqual(sanitizeBounds({ width: '1280', height: 800 }, defaults), defaults);
  });

  it('drops a malformed position without dropping the size', () => {
    assert.deepEqual(
      sanitizeBounds({ x: 'left', y: 20, width: 1280, height: 800 }, defaults),
      { width: 1280, height: 800 },
    );
  });
});
