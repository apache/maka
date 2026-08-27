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
import { describe, test } from 'node:test';
import { defineUiCatalog, formatUiCopy } from '../ui-locale.js';

describe('UI catalog helpers', () => {
  test('retains a complete typed catalog', () => {
    const catalog = defineUiCatalog<{ label: string }>()({
      zh: { label: '标签' },
      en: { label: 'Label' },
    });

    assert.deepEqual(catalog, {
      zh: { label: '标签' },
      en: { label: 'Label' },
    });
  });

  test('formats named values and fails closed when one is absent', () => {
    assert.equal(formatUiCopy('Update {version}', { version: '1.2.3' }), 'Update 1.2.3');
    assert.throws(
      () => formatUiCopy('Update {version}', {}),
      /Missing UI copy placeholder version/u,
    );
  });
});
