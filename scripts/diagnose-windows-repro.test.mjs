/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPackageWithOptions } from '@electron/asar';
import { comparePe, diagnose, inspectAsar } from './diagnose-windows-repro.mjs';

function pe(sample, timestamp) {
  const bytes = Buffer.alloc(0x800);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(2, 0x86);
  bytes.writeUInt32LE(timestamp, 0x88);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(0x2000, 0x98 + 112 + 48);
  bytes.writeUInt32LE(28, 0x98 + 112 + 52);
  for (const [index, name, rva, offset] of [
    [0, '.text', 0x1000, 0x200],
    [1, '.rdata', 0x2000, 0x400],
  ]) {
    const section = 0x98 + 240 + index * 40;
    bytes.write(name, section);
    bytes.writeUInt32LE(rva, section + 12);
    bytes.writeUInt32LE(0x200, section + 16);
    bytes.writeUInt32LE(offset, section + 20);
  }
  bytes.write('unchanged instructions', 0x200);
  bytes.writeUInt32LE(timestamp, 0x404);
  bytes.writeUInt32LE(2, 0x40c);
  bytes.writeUInt32LE(80, 0x410);
  bytes.writeUInt32LE(0x440, 0x418);
  bytes.write('RSDS', 0x440);
  bytes.fill(timestamp, 0x444, 0x454);
  bytes.writeUInt32LE(1, 0x454);
  bytes.write(`D:\\sample-${sample}\\module.pdb\0`, 0x458);
  return bytes;
}

test('isolates PE timestamps and CodeView data without changing the original bytes', () => {
  const a = pe('a', 1);
  const b = pe('b', 2);
  const before = Buffer.from(a);
  const result = comparePe(a, b);
  assert.equal(result.pathOnlyEqual, false);
  assert.equal(result.metadataAndPathsEqual, true);
  assert.equal(result.sections.find((section) => section.name === '.text').rawEqual, true);
  assert.deepEqual(a, before);
  assert.deepEqual(result.timestamps, [1, 2]);
  assert.match(result.debug[1][0].pdb, /sample-b/u);
});

test('does not hide differing machine instructions behind PE metadata normalization', () => {
  const a = pe('a', 1);
  const b = pe('b', 2);
  b[0x210] ^= 1;
  const result = comparePe(a, b);
  assert.equal(result.metadataAndPathsEqual, false);
  assert.equal(result.metadataPathsAndAsarIntegrityEqual, false);
  assert.equal(result.sections.find((section) => section.name === '.text').rawEqual, false);
});

test('identifies an exact embedded ASAR hash difference separately from other metadata', () => {
  const a = pe('a', 1);
  const b = pe('b', 2);
  const hashes = ['a'.repeat(64), 'b'.repeat(64)];
  a.write(hashes[0], 0x580);
  b.write(hashes[1], 0x580);
  const result = comparePe(a, b, hashes);
  assert.equal(result.metadataAndPathsEqual, false);
  assert.equal(result.metadataPathsAndAsarIntegrityEqual, true);
  assert.deepEqual(result.integrityReplacements, [1, 1]);
});

test('hashes actual packed and unpacked ASAR file contents using Electron archives', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'windows-repro-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  mkdirSync(input);
  writeFileSync(join(input, 'main.js'), 'same javascript');
  writeFileSync(join(input, 'native.node'), 'native a');
  const a = join(root, 'a.asar');
  await createPackageWithOptions(input, a, { unpack: '*.node' });
  writeFileSync(join(input, 'native.node'), 'native b');
  const b = join(root, 'b.asar');
  await createPackageWithOptions(input, b, { unpack: '*.node' });
  const [left, right] = [a, b].map(inspectAsar);
  assert.equal(
    left.files.get('main.js').sha256,
    createHash('sha256').update('same javascript').digest('hex'),
  );
  assert.equal(left.files.get('main.js').sha256, right.files.get('main.js').sha256);
  assert.equal(left.files.get('native.node').unpacked, true);
  assert.notEqual(left.files.get('native.node').sha256, right.files.get('native.node').sha256);
  assert.equal(left.dataHash, right.dataHash);
  assert.notEqual(left.headerHash, right.headerHash);
});

test('reports an omitted builder icon but still rejects a missing or corrupted shipped file', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'windows-repro-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  mkdirSync(input);
  writeFileSync(join(input, 'main.js'), 'same javascript');
  for (const sample of ['a', 'b']) {
    const evidence = join(root, `windows-repro-evidence-${sample}`);
    const payload = join(root, `windows-repro-payload-${sample}`);
    mkdirSync(evidence);
    mkdirSync(join(payload, 'win-unpacked/resources'), { recursive: true });
    const archive = join(payload, 'win-unpacked/resources/app.asar');
    await createPackageWithOptions(input, archive, {});
    const bytes = readFileSync(archive);
    writeFileSync(
      join(evidence, 'environment.json'),
      JSON.stringify({ sourceCommit: '48b0408003edcf9594c38e2cb1bfc79beb4283b5' }),
    );
    writeFileSync(
      join(evidence, 'files.json'),
      JSON.stringify([
        { path: '.icon-ico/icon.ico', size: 1, sha256: 'unavailable' },
        {
          path: 'win-unpacked/resources/app.asar',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ]),
    );
  }
  const result = diagnose(root);
  assert.equal(result.verifiedAvailableManifestHashes, true);
  assert.deepEqual(
    result.unavailableArtifactFiles.map((file) => file.path),
    ['.icon-ico/icon.ico', '.icon-ico/icon.ico'],
  );
  assert.equal(result.differingPaths, 0);
  const archive = join(root, 'windows-repro-payload-a/win-unpacked/resources/app.asar');
  const corrupted = readFileSync(archive);
  corrupted[corrupted.length - 1] ^= 1;
  writeFileSync(archive, corrupted);
  assert.throws(() => diagnose(root), /Artifact hash mismatch/u);
  rmSync(archive);
  assert.throws(() => diagnose(root), /ENOENT/u);
});
