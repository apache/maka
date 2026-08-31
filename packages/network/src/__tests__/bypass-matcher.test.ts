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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesBypassList } from '../bypass-matcher.js';

describe('matchesBypassList', () => {
  const list = [
    'localhost',
    '*.local',
    '*.example.com',
    '192.168.*',
    '10.0.0.0/8',
    '127.0.0.1',
    '::1',
  ];

  test('matches exact, wildcard, and CIDR entries', () => {
    assert.equal(matchesBypassList('localhost', list), true);
    assert.equal(matchesBypassList('api.example.com', list), true);
    assert.equal(matchesBypassList('example.com', list), false);
    assert.equal(matchesBypassList('192.168.1.1', list), true);
    assert.equal(matchesBypassList('10.5.5.5', list), true);
    assert.equal(matchesBypassList('11.0.0.0', list), false);
  });

  test('is case-insensitive and supports global wildcard', () => {
    assert.equal(matchesBypassList('LocalHost', list), true);
    assert.equal(matchesBypassList('anything', ['*']), true);
  });

  test('rejects malformed CIDR entries', () => {
    assert.equal(matchesBypassList('10.0.0.1', ['10.0.0.0/24.5']), false);
    assert.equal(matchesBypassList('10.0.0.1', ['10.0.0.0/24/ignored']), false);
    assert.equal(matchesBypassList('10.0.0.1', ['10.0.0.0/']), false);
    assert.equal(matchesBypassList('10.0.0.1', ['1e1.0.0.0/8']), false);
  });
});
