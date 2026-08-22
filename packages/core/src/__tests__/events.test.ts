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

import { test } from 'node:test';
import { expect } from './test-helpers.js';
import { aggregateMessageContents } from '../events.js';

test('aggregates inline references against the combined display text', () => {
  expect(
    aggregateMessageContents([
      {
        text: '<skill>Alpha</skill>\n\nFirst',
        displayText: '/skill:alpha First',
        inlineReferences: [{ kind: 'skill', value: '/skill:alpha', label: 'Alpha', start: 0 }],
      },
      {
        text: '<skill>Beta</skill>\n\nSecond',
        displayText: '/skill:beta Second',
        inlineReferences: [{ kind: 'skill', value: '/skill:beta', label: 'Beta', start: 0 }],
      },
    ]),
  ).toEqual({
    text: '<skill>Alpha</skill>\n\nFirst\n\n<skill>Beta</skill>\n\nSecond',
    displayText: '/skill:alpha First\n\n/skill:beta Second',
    inlineReferences: [
      { kind: 'skill', value: '/skill:alpha', label: 'Alpha', start: 0 },
      { kind: 'skill', value: '/skill:beta', label: 'Beta', start: 20 },
    ],
  });
});

test('preserves an explicit empty inline-reference marker while aggregating', () => {
  expect(aggregateMessageContents([{ text: 'plain', inlineReferences: [] }])).toEqual({
    text: 'plain',
    inlineReferences: [],
  });
});
