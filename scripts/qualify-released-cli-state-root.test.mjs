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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertExpectedEpochRelation,
  parseQualificationArgs,
  sha256File,
} from './qualify-released-cli-state-root.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

test('parses two exact artifacts and an epoch relation', () => {
  assert.deepEqual(
    parseQualificationArgs([
      '--source',
      '/tmp/source.tgz',
      '--source-sha256',
      SHA_A,
      '--target',
      '/tmp/target.tgz',
      '--target-sha256',
      SHA_B,
      '--expect-epoch-relation',
      'same',
    ]),
    {
      source: '/tmp/source.tgz',
      sourceSha256: SHA_A,
      target: '/tmp/target.tgz',
      targetSha256: SHA_B,
      expectedEpochRelation: 'same',
    },
  );
});

test('rejects ambiguous artifact identity and unknown arguments', () => {
  assert.throws(
    () =>
      parseQualificationArgs([
        '--source',
        'source.tgz',
        '--source-sha256',
        SHA_A,
        '--target',
        '/tmp/target.tgz',
        '--target-sha256',
        SHA_B,
        '--expect-epoch-relation',
        'any',
      ]),
    /source must be an absolute path/u,
  );
  assert.throws(
    () =>
      parseQualificationArgs([
        '--source',
        '/tmp/source.tgz',
        '--source-sha256',
        SHA_A,
        '--target',
        '/tmp/target.tgz',
        '--target-sha256',
        SHA_B,
        '--extra',
        'value',
      ]),
    /Unknown qualification argument/u,
  );
});

test('classifies and fences the expected epoch relationship', () => {
  assert.equal(assertExpectedEpochRelation(74, 76, 'different'), 'different');
  assert.equal(assertExpectedEpochRelation(76, 76, 'same'), 'same');
  assert.equal(assertExpectedEpochRelation(76, 78, 'any'), 'different');
  assert.throws(
    () => assertExpectedEpochRelation(76, 78, 'same'),
    /Expected same compatibility epochs/u,
  );
});

test('computes the exact artifact SHA-256', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-release-digest-'));
  try {
    const path = join(root, 'artifact.tgz');
    writeFileSync(path, 'released bytes');
    assert.equal(
      sha256File(path),
      '2f9e0acbd320f87ceff2b9d259c99ec87830fc87d99bf914cef87394294a6682',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
