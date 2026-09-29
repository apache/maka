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
import { normalizeCatalogEntry, type ExecutorCatalogEntry } from '../executor-catalog.js';

const catalog: ExecutorCatalogEntry = {
  id: 'external',
  displayName: 'External',
  readiness: 'ready',
  supportsAttachments: false,
  supportsModelChange: true,
  models: [
    { id: 'opaque-high', name: 'High', providerType: 'google' },
    { id: 'opaque-low', name: 'Low' },
  ],
  modelGroups: [
    {
      id: 'base',
      name: 'Base',
      variants: [
        { modelId: 'opaque-high', level: 'high' },
        { modelId: 'opaque-low', level: 'low' },
      ],
    },
  ],
};
test('structured capabilities survive wire normalization with immutable exact references', () => {
  const output = normalizeCatalogEntry(catalog, 'external');
  assert.deepEqual(output, catalog);
  assert.ok(Object.isFrozen(output.modelGroups![0]!.variants[0]));
  assert.notEqual(output.modelGroups, catalog.modelGroups);
});
for (const readiness of ['restorable', 'restoring', 'restore_failed', 'history_gap'] as const)
  test(`restoration readiness survives executor catalog normalization: ${readiness}`, () => {
    assert.equal(
      normalizeCatalogEntry(
        { ...catalog, readiness, models: [], modelGroups: undefined },
        'external',
      ).readiness,
      readiness,
    );
  });
for (const variants of [
  [
    { modelId: 'invented', level: 'high' },
    { modelId: 'opaque-low', level: 'low' },
  ],
  [
    { modelId: 'opaque-high', level: 'high' },
    { modelId: 'opaque-low', level: 'high' },
  ],
  [
    { modelId: 'opaque-high', level: 'default' },
    { modelId: 'opaque-low', level: 'low' },
  ],
])
  test(`invalid variant capability is rejected: ${JSON.stringify(variants)}`, () => {
    assert.throws(() =>
      normalizeCatalogEntry(
        {
          ...catalog,
          modelGroups: [{ id: 'base', name: 'Base', variants }],
        } as ExecutorCatalogEntry,
        'external',
      ),
    );
  });
