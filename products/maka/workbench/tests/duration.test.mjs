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
import { formatDuration } from '../app/duration.ts';

test('duration display carries seconds into minutes and hours', () => {
  for (const [ms, expected] of [
    [0, '0s'],
    [59_999, '59s'],
    [60_000, '1m 0s'],
    [3_599_999, '59m 59s'],
    [3_600_000, '1h 0m 0s'],
    [3_873_000, '1h 4m 33s'],
    [17_056_000, '4h 44m 16s'],
    [90_061_000, '25h 1m 1s'],
  ])
    assert.equal(formatDuration(ms), expected);
});

test('sub-minute precision carries into the next minute without displaying 60 seconds', () => {
  for (const [ms, expected] of [
    [0, '0.0s'],
    [1_234, '1.2s'],
    [59_949, '59.9s'],
    [59_950, '1m 0s'],
    [60_000, '1m 0s'],
    [3_600_000, '1h 0m 0s'],
  ])
    assert.equal(formatDuration(ms, true), expected);
});
