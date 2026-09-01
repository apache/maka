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
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectWindowsCuArtifact, REQUIRED_NATIVE_FILES } from './prepare-windows-cu-helper.mjs';

const exec = promisify(execFile);

const temporaryDirectories = [];
after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('rejects a framework-dependent apphost before it reaches Desktop resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cu-helper-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'maka-cu-windows.exe'), Buffer.alloc(151_552));
  await assert.rejects(inspectWindowsCuArtifact(directory), /not a self-contained single-file/);
});

test('rejects a partial single-file publish without Windows Desktop companions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cu-helper-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'maka-cu-windows.exe'), Buffer.alloc(10 * 1024 * 1024));
  await assert.rejects(inspectWindowsCuArtifact(directory), /missing native runtime files/);
});

test('accepts the declared single-file plus native companion contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cu-helper-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'maka-cu-windows.exe'), Buffer.alloc(10 * 1024 * 1024));
  await Promise.all(
    REQUIRED_NATIVE_FILES.map((name) => writeFile(join(directory, name), 'native')),
  );
  const inspected = await inspectWindowsCuArtifact(directory);
  assert.equal(
    inspected.files.some((file) => file.name === 'maka-cu-windows.exe'),
    true,
  );
  assert.equal(inspected.files.length, REQUIRED_NATIVE_FILES.length + 1);
});

test('direct CLI execution copies the closed artifact and writes its manifest', async () => {
  const artifact = await mkdtemp(join(tmpdir(), 'maka-cu-helper-artifact-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'maka-cu-helper-root-'));
  temporaryDirectories.push(artifact, outputRoot);
  await writeFile(join(artifact, 'maka-cu-windows.exe'), Buffer.alloc(10 * 1024 * 1024));
  await Promise.all(REQUIRED_NATIVE_FILES.map((name) => writeFile(join(artifact, name), 'native')));
  await mkdir(join(outputRoot, 'apps', 'desktop'), { recursive: true });
  await writeFile(join(outputRoot, 'apps', 'desktop', 'bundled-tools.json'), '{}\n');

  const script = fileURLToPath(new URL('./prepare-windows-cu-helper.mjs', import.meta.url));
  await exec(process.execPath, [script], {
    env: {
      ...process.env,
      MAKA_CU_WINDOWS_ARTIFACT: artifact,
      MAKA_CU_WINDOWS_ROOT: outputRoot,
    },
  });
  const manifest = JSON.parse(
    await readFile(join(outputRoot, 'apps', 'desktop', 'bundled-tools.json'), 'utf8'),
  );
  assert.equal(manifest.windowsCu.binarySizeBytes, 10 * 1024 * 1024);
  assert.equal(manifest.windowsCu.files.length, REQUIRED_NATIVE_FILES.length + 1);
  await assert.doesNotReject(
    inspectWindowsCuArtifact(
      join(outputRoot, 'apps', 'desktop', 'resources', 'bin', 'maka-cu-windows'),
    ),
  );
});
