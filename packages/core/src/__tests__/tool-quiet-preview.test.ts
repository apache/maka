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
import { formatAsKeyValueLines, formatQuietJsonValue } from '../tool-quiet-preview.js';

describe('tool quiet preview', () => {
  it('redacts secrets in values and embedded keys', () => {
    const value = formatQuietJsonValue({ password: 'correct-horse', ok: true }, 'en').body;
    assert.doesNotMatch(value, /correct-horse/);
    assert.match(value, /redacted/i);
    const key = formatAsKeyValueLines({ 'password=secret': true }, 0, 'en');
    assert.doesNotMatch(key, /secret/);
    assert.match(key, /redacted/i);
  });
});
