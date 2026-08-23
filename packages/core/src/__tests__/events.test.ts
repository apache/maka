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
import {
  aggregateMessageContents,
  decodeToolStepProgress,
  encodeToolStepProgress,
} from '../events.js';

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

test('round-trips bounded tool step progress through the shared wire codec', () => {
  const encoded = encodeToolStepProgress({ current: 1, total: 2 });

  expect(encoded).toBe('steps:1/2');
  expect(decodeToolStepProgress(encoded!)).toEqual({ current: 1, total: 2 });
  expect(
    decodeToolStepProgress(
      encodeToolStepProgress({
        current: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
      })!,
    ),
  ).toEqual({
    current: Number.MAX_SAFE_INTEGER,
    total: Number.MAX_SAFE_INTEGER,
  });
});

test('rejects invalid tool step progress at both codec boundaries', () => {
  for (const progress of [
    { current: -1, total: 2 },
    { current: 1, total: 0 },
    { current: 3, total: 2 },
    { current: 0.5, total: 2 },
    { current: Number.MAX_SAFE_INTEGER + 1, total: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(encodeToolStepProgress(progress)).toBe(undefined);
  }

  for (const chunk of [
    'working',
    'steps:-1/2',
    'steps:1/0',
    'steps:3/2',
    'steps:0.5/2',
    'steps:9007199254740992/9007199254740992',
  ]) {
    expect(decodeToolStepProgress(chunk)).toBe(undefined);
  }
  expect(decodeToolStepProgress({ kind: 'stdout', text: 'steps:1/2' })).toBe(undefined);
});
