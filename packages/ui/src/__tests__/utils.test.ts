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
import { test } from 'node:test';
import { isAppleShortcutPlatform, preferredShortcutPlatform } from '../utils.js';

test('detects Apple platforms from navigator.platform values', () => {
  assert.equal(isAppleShortcutPlatform('MacIntel'), true);
  assert.equal(isAppleShortcutPlatform('Macintosh'), true);
  assert.equal(isAppleShortcutPlatform('macOS'), true);
  assert.equal(isAppleShortcutPlatform('iPhone'), true);
  assert.equal(isAppleShortcutPlatform('iPad'), true);
});

test('rejects non-Apple platforms and unknown input (#3876)', () => {
  assert.equal(isAppleShortcutPlatform('Win32'), false);
  assert.equal(isAppleShortcutPlatform('Linux x86_64'), false);
  assert.equal(isAppleShortcutPlatform(''), false);
  assert.equal(isAppleShortcutPlatform(null), false);
  assert.equal(isAppleShortcutPlatform(undefined), false);
});

test('prefers userAgentData.platform and falls back only when it is blank', () => {
  assert.equal(preferredShortcutPlatform('macOS', 'Win32'), 'macOS');
  assert.equal(preferredShortcutPlatform('Windows', 'MacIntel'), 'Windows');
  assert.equal(preferredShortcutPlatform('  ', 'MacIntel'), 'MacIntel');
  assert.equal(preferredShortcutPlatform(undefined, 'Linux x86_64'), 'Linux x86_64');
  assert.equal(preferredShortcutPlatform(undefined, undefined), '');
});
