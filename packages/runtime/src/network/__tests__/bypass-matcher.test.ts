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
import { expect } from '../../test-helpers.js';
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
    expect(matchesBypassList('localhost', list)).toBe(true);
    expect(matchesBypassList('api.example.com', list)).toBe(true);
    expect(matchesBypassList('example.com', list)).toBe(false);
    expect(matchesBypassList('192.168.1.1', list)).toBe(true);
    expect(matchesBypassList('10.5.5.5', list)).toBe(true);
    expect(matchesBypassList('11.0.0.0', list)).toBe(false);
  });

  test('is case-insensitive and supports global wildcard', () => {
    expect(matchesBypassList('LocalHost', list)).toBe(true);
    expect(matchesBypassList('anything', ['*'])).toBe(true);
  });
});
