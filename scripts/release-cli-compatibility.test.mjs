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
  assertMakaReleaseIdentity,
  assertRuntimeHostCompatibilityEpoch,
  readRuntimeHostCompatibilityEpoch,
  resolveMakaReleaseIdentity,
} from './release-cli-compatibility.mjs';

const sourceCommit = 'a'.repeat(40);

test('accepts matching Runtime Host compatibility epochs in TypeScript and JavaScript', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-release-compatibility-'));
  try {
    const sourcePath = join(root, 'source.ts');
    const packagedPath = join(root, 'packaged.js');
    writeFileSync(sourcePath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 25 as const;\n');
    writeFileSync(packagedPath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 25;\n');

    assert.equal(readRuntimeHostCompatibilityEpoch(sourcePath), 25);
    assert.deepEqual(assertRuntimeHostCompatibilityEpoch({ sourcePath, packagedPath }), {
      sourceEpoch: 25,
      packagedEpoch: 25,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a packaged Runtime Host compatibility epoch from an older release', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-release-compatibility-'));
  try {
    const sourcePath = join(root, 'source.ts');
    const packagedPath = join(root, 'packaged.js');
    writeFileSync(sourcePath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 25 as const;\n');
    writeFileSync(packagedPath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 24;\n');

    assert.throws(
      () => assertRuntimeHostCompatibilityEpoch({ sourcePath, packagedPath }),
      (error) => {
        assert.match(error.message, /compatibility epoch mismatch/u);
        assert.match(error.message, /source 25/u);
        assert.match(error.message, /packaged 24/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing or duplicate Runtime Host compatibility epoch declarations', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-release-compatibility-'));
  try {
    const missingPath = join(root, 'missing.js');
    const duplicatePath = join(root, 'duplicate.js');
    writeFileSync(missingPath, 'export const RUNTIME_HOST_PROTOCOL_VERSION = 0;\n');
    writeFileSync(
      duplicatePath,
      [
        'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 25;',
        'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 26;',
      ].join('\n'),
    );

    assert.throws(() => readRuntimeHostCompatibilityEpoch(missingPath), /not unique/u);
    assert.throws(() => readRuntimeHostCompatibilityEpoch(duplicatePath), /not unique/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires Desktop and CLI release artifacts to carry the same source identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-release-identity-'));
  try {
    const sourcePath = join(root, 'source.ts');
    writeFileSync(sourcePath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 25 as const;\n');
    const expected = resolveMakaReleaseIdentity({
      version: '0.2.0',
      sourceCommit,
      sourcePath,
    });

    assertMakaReleaseIdentity({ expected, actual: { ...expected } });
    assert.throws(
      () =>
        assertMakaReleaseIdentity({
          expected,
          actual: { ...expected, sourceCommit: 'b'.repeat(40) },
        }),
      /mismatch for sourceCommit/u,
    );
    assert.throws(
      () =>
        assertMakaReleaseIdentity({
          expected,
          actual: { ...expected, compatibilityEpoch: 24 },
        }),
      /mismatch for compatibilityEpoch/u,
    );
    assert.throws(
      () =>
        assertMakaReleaseIdentity({
          expected,
          actual: { ...expected, unexpected: true },
        }),
      /unexpected shape/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
