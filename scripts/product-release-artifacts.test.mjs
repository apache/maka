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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertExactArtifactSet,
  stageProductReleaseArtifactGroup,
} from './product-release-artifacts.mjs';

test('product release artifact validation rejects missing and unexpected files', () => {
  assert.deepEqual(assertExactArtifactSet(['b.zip', 'a.dmg'], ['a.dmg', 'b.zip']), [
    'a.dmg',
    'b.zip',
  ]);
  assert.throws(() => assertExactArtifactSet(['a.dmg'], ['a.dmg', 'b.zip']), /missing b\.zip/u);
  assert.throws(
    () => assertExactArtifactSet(['a.dmg', 'debug.log'], ['a.dmg']),
    /unexpected debug\.log/u,
  );
});

test('artifact staging publishes exactly one manifest group', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  await mkdir(sourceDirectory);
  await Promise.all([
    writeFile(join(sourceDirectory, 'a.dmg'), 'dmg'),
    writeFile(join(sourceDirectory, 'a.dmg.sha256'), 'checksum'),
  ]);

  await stageProductReleaseArtifactGroup({
    sourceDirectory,
    targetDirectory,
    expectedNames: ['a.dmg', 'a.dmg.sha256'],
  });

  assert.equal(await readFile(join(targetDirectory, 'a.dmg'), 'utf8'), 'dmg');
  assert.equal(await readFile(join(targetDirectory, 'a.dmg.sha256'), 'utf8'), 'checksum');
});

test('artifact staging refuses to replace an existing target directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-artifacts-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  await Promise.all([mkdir(sourceDirectory), mkdir(targetDirectory)]);
  await Promise.all([
    writeFile(join(sourceDirectory, 'a.dmg'), 'dmg'),
    writeFile(join(targetDirectory, 'keep.txt'), 'keep'),
  ]);

  await assert.rejects(
    stageProductReleaseArtifactGroup({
      sourceDirectory,
      targetDirectory,
      expectedNames: ['a.dmg'],
    }),
    /target directory must be empty/u,
  );
  assert.equal(await readFile(join(targetDirectory, 'keep.txt'), 'utf8'), 'keep');
});
