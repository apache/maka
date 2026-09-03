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
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelFactsDocumentOwner } from '../model-facts-store.js';
import { cleanupRuntimePolicyDocumentTemps } from '../runtime-policy/document-io.js';

test('model facts persist and malformed documents fail closed with a bounded diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-facts-'));
  try {
    const owner = new ModelFactsDocumentOwner();
    assert.deepEqual((await owner.readWithDiagnostics(root)).document.overrides, {});
    await writeFile(join(root, 'model-facts.json'), '{not-json}', 'utf8');
    const result = await owner.readWithDiagnostics(root);
    assert.equal(result.diagnostic, 'malformed');
    assert.deepEqual(result.document.overrides, {});
    await writeFile(
      join(root, 'model-facts.json'),
      JSON.stringify({ schemaVersion: 1, overrides: { 'openai:o4-mini': { unknown: true } } }),
      'utf8',
    );
    assert.equal((await owner.readWithDiagnostics(root)).diagnostic, 'malformed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model facts temporary writes are removed by runtime policy recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-facts-recovery-'));
  try {
    await writeFile(
      join(root, 'model-facts.json.00000000-0000-4000-8000-000000000000.tmp'),
      '{}',
      'utf8',
    );
    await cleanupRuntimePolicyDocumentTemps(root);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('future model facts schemas fail closed without rewriting the document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-facts-future-'));
  try {
    const owner = new ModelFactsDocumentOwner();
    const future = JSON.stringify({
      schemaVersion: 2,
      overrides: { 'openai:o4-mini': { contextWindow: 1 } },
    });
    await writeFile(join(root, 'model-facts.json'), future, 'utf8');
    const read = await owner.readWithDiagnostics(root);
    assert.equal(read.diagnostic, 'unsupported_schema');
    assert.equal(await readFile(join(root, 'model-facts.json'), 'utf8'), future);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
