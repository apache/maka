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
import { splitQuotes } from '../app/quotedPassages.ts';

test('passages quoted at the start are split from the question', () => {
  assert.deepEqual(splitQuotes('> first line\n> second line\n\nWhy is that?'), {
    quotes: ['first line\nsecond line'],
    body: 'Why is that?',
  });
  assert.deepEqual(splitQuotes('> one\n\n> two\n\nCompare them.\n> not a leading quote'), {
    quotes: ['one', 'two'],
    body: 'Compare them.\n> not a leading quote',
  });
});

test('a message with only passages has no body, and one without keeps its text', () => {
  assert.deepEqual(splitQuotes('> only this\n\n'), { quotes: ['only this'], body: '' });
  assert.deepEqual(splitQuotes('plain\n> later'), { quotes: [], body: 'plain\n> later' });
});
