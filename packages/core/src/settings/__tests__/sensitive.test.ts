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
import { expect } from '../../__tests__/test-helpers.js';
import { applySensitivePatch, maskSensitive } from '../network-settings.js';

describe('applySensitivePatch', () => {
  test('handles plaintext, placeholder, empty string, and undefined', () => {
    expect(applySensitivePatch('old', 'new')).toBe('new');
    expect(applySensitivePatch('old', '••••••••')).toBe('old');
    expect(applySensitivePatch('old', '')).toBeUndefined();
    expect(applySensitivePatch('old', undefined)).toBe('old');
  });
});

describe('maskSensitive', () => {
  test('masks only non-empty values', () => {
    expect(maskSensitive('secret')).toBe('••••••••');
    expect(maskSensitive('')).toBeUndefined();
    expect(maskSensitive(undefined)).toBeUndefined();
  });
});
