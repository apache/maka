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
import { createTurnHeightIndex } from '../turn-height-index.js';

describe('turn height index', () => {
  it('keeps measurements for the current layout and bounds old sessions and turns', () => {
    const index = createTurnHeightIndex(2, 2);
    assert.equal(index.record('s1', 'wide', 'a', 100), true);
    assert.equal(index.record('s1', 'wide', 'a', 100.2), false);
    index.record('s1', 'wide', 'b', 200);
    index.record('s1', 'wide', 'c', 300);
    assert.equal(index.lookup('s1', 'wide')?.has('a'), false);
    index.record('s2', 'wide', 'a', 100);
    index.record('s3', 'wide', 'a', 100);
    assert.equal(index.lookup('s1', 'wide'), undefined);
  });

  it('does not reuse heights after the layout changes', () => {
    const index = createTurnHeightIndex();
    index.record('s1', 'wide', 'a', 100);
    index.record('s1', 'narrow', 'a', 200);
    assert.equal(index.lookup('s1', 'wide'), undefined);
    assert.equal(index.lookup('s1', 'narrow')?.get('a'), 200);
  });
});
