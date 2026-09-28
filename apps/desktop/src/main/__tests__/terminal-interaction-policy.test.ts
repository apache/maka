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
import {
  terminalWebUrl,
} from '../../renderer/features/workbar/testing.js';

describe('terminalWebUrl', () => {
  it('accepts only explicit HTTP(S) URLs', () => {
    assert.equal(terminalWebUrl('https://example.com/a?q=1'), 'https://example.com/a?q=1');
    assert.equal(terminalWebUrl('http://localhost:3000'), 'http://localhost:3000/');
  });

  it('rejects non-http(s) and malformed values', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:a@b.com',
      '/tmp/a',
      'invalid',
    ]) {
      assert.equal(terminalWebUrl(url), null);
    }
  });
});
