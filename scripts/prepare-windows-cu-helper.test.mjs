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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  inspectWindowsCuArtifact,
  REQUIRED_NATIVE_FILES,
  resolveWindowsCuDistributionReady,
} from './prepare-windows-cu-helper.mjs';

const temporaryDirectories = [];
after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('rejects a tiny artifact before it reaches Desktop resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cu-helper-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'maka-cu-windows.exe'), Buffer.alloc(151_552));
  await assert.rejects(inspectWindowsCuArtifact(directory), /not a native release artifact/);
});

test('accepts the native single-file artifact contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cu-helper-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'maka-cu-windows.exe'), Buffer.alloc(10 * 1024 * 1024));
  const inspected = await inspectWindowsCuArtifact(directory);
  assert.equal(inspected.files.length, REQUIRED_NATIVE_FILES.length + 1);
});

test('local preparation never enables distribution readiness', async () => {
  const artifact = await mkdtemp(join(tmpdir(), 'maka-cu-helper-artifact-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'maka-cu-helper-root-'));
  temporaryDirectories.push(artifact, outputRoot);
  await writeFile(join(artifact, 'maka-cu-windows.exe'), Buffer.alloc(600 * 1024));
  await mkdir(join(outputRoot, 'apps', 'desktop'), { recursive: true });
  await writeFile(join(outputRoot, 'apps', 'desktop', 'bundled-tools.json'), '{}\n');
  const original = process.env.MAKA_CU_WINDOWS_ARTIFACT;
  const originalRoot = process.env.MAKA_CU_WINDOWS_ROOT;
  process.env.MAKA_CU_WINDOWS_ARTIFACT = artifact;
  process.env.MAKA_CU_WINDOWS_ROOT = outputRoot;
  try {
    const module = await import(`./prepare-windows-cu-helper.mjs?test=${Date.now()}`);
    await module.prepareWindowsCuHelper();
  } finally {
    if (original === undefined) delete process.env.MAKA_CU_WINDOWS_ARTIFACT;
    else process.env.MAKA_CU_WINDOWS_ARTIFACT = original;
    if (originalRoot === undefined) delete process.env.MAKA_CU_WINDOWS_ROOT;
    else process.env.MAKA_CU_WINDOWS_ROOT = originalRoot;
  }
  const manifest = JSON.parse(
    await readFile(join(outputRoot, 'apps', 'desktop', 'bundled-tools.json'), 'utf8'),
  );
  assert.equal(manifest.windowsCu.distributionReady, false);
});

test('distribution readiness requires evidence tied to the exact artifact', () => {
  const hash = 'a'.repeat(64);
  const complete = {
    executorCommit: 'b'.repeat(40),
    workflowRun: '4595',
    artifactSha256: hash,
    signature: 'authenticode',
    cleanMachineE2e: true,
    packagedConversationE2e: true,
  };
  assert.equal(resolveWindowsCuDistributionReady(complete, hash), true);
  assert.equal(
    resolveWindowsCuDistributionReady({ ...complete, artifactSha256: 'c'.repeat(64) }, hash),
    false,
  );
  assert.equal(resolveWindowsCuDistributionReady(undefined, hash), false);
});
