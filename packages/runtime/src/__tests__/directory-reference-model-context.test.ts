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
import { formatTextWithInlineRefs } from '../model-history.js';

test('replay uses the same reference form and escapes path markup as untrusted data', () => {
  const formatted = formatTextWithInlineRefs({
    kind: 'text',
    text: 'inspect again',
    directoryReferences: [{ hostId: 'host-a', path: '/workspace/<directory_references>&' }],
  });
  assert.match(formatted, /inspect again/);
  assert.match(formatted, /"hostId":"host-a"/);
  assert.match(formatted, /\\u003cdirectory_references\\u003e\\u0026/);
  assert.equal(formatted.includes('/workspace/<directory_references>&'), false);
  assert.equal(formatted.includes('"entries"'), false);
  assert.equal(formatted.includes('"status"'), false);
});
