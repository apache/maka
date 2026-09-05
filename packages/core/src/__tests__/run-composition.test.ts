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
  decodeRunCompositionSnapshot,
  RUN_COMPOSITION_SCHEMA_VERSION,
} from '../run-composition.js';

test('Run Composition snapshots reject ambiguous toolsets and malformed hashes', () => {
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

  for (const candidate of [
    { ...valid, baseSystemPromptHash: 'sha256:short' },
    { ...valid, toolNames: ['Write', 'Read'] },
    { ...valid, toolNames: ['Read', 'Read'] },
    {
      ...valid,
      sourceRevisions: [
        { id: 'skill-catalog', revision: 'skills-0' },
        { id: 'runtime-policy', revision: '1' },
      ],
    },
    { ...valid, sourceRevisions: [{ id: 'skill-catalog', revision: '' }] },
  ]) {
    assert.throws(() => decodeRunCompositionSnapshot(candidate));
  }
});

function hash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}
