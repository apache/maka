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
import { resolveE2eFixture } from '../e2e-fixture.js';

test('preserves both canonical Chinese locale fixture flags', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    const fixture = resolveE2eFixture(
      'settings-general',
      false,
      undefined,
      undefined,
      locale,
    );
    assert.equal(fixture?.locale, locale);
  }
});

test('normalizes locale fixture flag casing without widening the contract', () => {
  assert.equal(
    resolveE2eFixture('settings-general', false, undefined, undefined, 'ZH-tw')?.locale,
    'zh-TW',
  );
  assert.equal(
    resolveE2eFixture('settings-general', false, undefined, undefined, 'zh-Hant')?.locale,
    null,
  );
});
