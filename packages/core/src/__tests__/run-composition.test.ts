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
import {
  createRequestCompositionSnapshot,
  decodeRequestCompositionSnapshot,
  decodeRunCompositionSnapshot,
  REQUEST_COMPOSITION_SCHEMA_VERSION,
  RUN_COMPOSITION_SCHEMA_VERSION,
} from '../run-composition.js';

test('Run Composition snapshots retain the persisted v1 bootstrap shape', () => {
  const valid = {
    schemaVersion: RUN_COMPOSITION_SCHEMA_VERSION,
    composerId: 'maka.interactive',
    composerRevision: '1',
    sourceRevisions: [{ id: 'skill-catalog', revision: 'skills-0' }],
    baseSystemPromptHash: hash('1'),
    toolCatalogHash: hash('2'),
    toolAvailabilityHash: hash('3'),
    baseProviderOptionsHash: hash('4'),
    toolNames: ['Read'],
    contextWindow: null,
  };

  assert.equal(decodeRunCompositionSnapshot(valid).schemaVersion, 1);

  for (const candidate of [
    { ...valid, schemaVersion: 2 },
    { ...valid, baseSystemPromptHash: 'sha256:short' },
    { ...valid, toolNames: ['Write', 'Read'] },
    { ...valid, toolNames: ['Read', 'Read'] },
  ]) {
    assert.throws(() => decodeRunCompositionSnapshot(candidate));
  }
});

test('Request Composition snapshots canonicalize complete model-visible tool surfaces', () => {
  const snapshot = createRequestCompositionSnapshot(
    {
      compositionId: 'composition-1',
      step: 1,
      sourceRevisions: [{ id: 'skill-catalog', revision: 'skills-1' }],
      systemPromptHash: hash('1'),
      toolCatalogHash: hash('2'),
      toolAvailabilityHash: hash('3'),
      providerOptionsHash: hash('4'),
      toolNames: ['Write', 'Read'],
      toolSchemas: [
        { name: 'Write', description: 'write', inputSchema: { type: 'object' } },
        { name: 'Read', description: 'read', inputSchema: { type: 'object' } },
      ],
    },
    'change',
  );
  assert.equal(snapshot.schemaVersion, REQUEST_COMPOSITION_SCHEMA_VERSION);
  assert.deepEqual(snapshot.toolNames, ['Read', 'Write']);
  assert.deepEqual(
    snapshot.toolSchemas.map((schema) => schema.name),
    ['Read', 'Write'],
  );
  assert.throws(() =>
    decodeRequestCompositionSnapshot({ ...snapshot, toolNames: ['Read', 'Read'] }),
  );
});

function hash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}
