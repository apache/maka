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
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  deterministicExecutableUuid,
  machoLcUuidLocations,
  rewriteBufferUuids,
  rewritePackagedMacosUuids,
  uuidv5,
} from './macos-lc-uuid.mjs';

/**
 * Every packaged Mach-O keeps its byte length and load-command layout; only
 * the 16 bytes under each LC_UUID move. These fixtures are the smallest
 * headers that prove that: one LC_UUID and one unrelated load command whose
 * bytes must survive untouched.
 */
const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;
const LC_SOURCE_VERSION = 0x2a;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// The UUID from the issue: every Electron 43.4.1-based app ships this exact
// Mach-O UUID, which is what makes macOS local-network privacy collide.
const OLD_UUID = Buffer.from('4c4c447055553144a124518576dd11e3', 'hex');

function thinMachO(cpuType, uuid) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(MH_MAGIC_64, 0);
  header.writeUInt32LE(cpuType, 4);
  header.writeUInt32LE(2, 12); // MH_EXECUTE
  header.writeUInt32LE(2, 16); // ncmds
  header.writeUInt32LE(24 + 16, 20); // sizeofcmds
  const uuidCommand = Buffer.alloc(24);
  uuidCommand.writeUInt32LE(LC_UUID, 0);
  uuidCommand.writeUInt32LE(24, 4);
  uuid.copy(uuidCommand, 8);
  const sourceVersion = Buffer.alloc(16);
  sourceVersion.writeUInt32LE(LC_SOURCE_VERSION, 0);
  sourceVersion.writeUInt32LE(16, 4);
  sourceVersion.writeBigUInt64LE(0x1122334455667788n, 8);
  return Buffer.concat([header, uuidCommand, sourceVersion]);
}

function fatMachO(slices) {
  const sliceSize = 4096;
  const tableSize = 8 + slices.length * 20;
  const buffer = Buffer.alloc(tableSize + slices.length * sliceSize);
  buffer.writeUInt32BE(0xcafebabe, 0);
  buffer.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, index) => {
    const arch = 8 + index * 20;
    const offset = tableSize + index * sliceSize;
    buffer.writeUInt32BE(slice.cpuType, arch);
    buffer.writeUInt32BE(offset, arch + 8);
    buffer.writeUInt32BE(slice.data.length, arch + 12);
    buffer.writeUInt32BE(12, arch + 16); // 2^12 slice alignment
    slice.data.copy(buffer, offset);
  });
  return buffer;
}

/** Rewrites `buffer` and asserts everything but the UUID payloads survived. */
function rewrittenLike(original, appId, executableName, uuidFor) {
  const rewritten = Buffer.from(original);
  const expected = Buffer.from(original);
  const locations = machoLcUuidLocations(rewritten);
  assert.ok(locations.length > 0, 'fixture must carry an LC_UUID');
  for (const { offset, cpuType } of locations) {
    const uuid = uuidFor(cpuType);
    rewritten.write(uuid.replaceAll('-', ''), offset, 'hex');
    expected.write(uuid.replaceAll('-', ''), offset, 'hex');
  }
  rewriteBufferUuids(rewritten, appId, executableName);
  assert.equal(rewritten.length, original.length, 'file size must not change');
  assert.deepEqual(rewritten, expected, 'only LC_UUID payloads may move');
  return { rewritten, locations };
}

test('uuidv5 follows RFC 4122', () => {
  // python.org under the DNS namespace is the reference example every
  // conforming implementation agrees on (verified against python's uuid5).
  assert.equal(uuidv5(DNS_NAMESPACE, 'python.org'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  assert.match(uuidv5(DNS_NAMESPACE, 'example.org'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('executable UUIDs are deterministic and distinguish every input', () => {
  const base = deterministicExecutableUuid('com.maka.desktop', 'Maka', CPU_TYPE_ARM64);
  assert.equal(base, deterministicExecutableUuid('com.maka.desktop', 'Maka', CPU_TYPE_ARM64));
  assert.notEqual(base, deterministicExecutableUuid('com.maka.desktop', 'Maka Helper', CPU_TYPE_ARM64));
  assert.notEqual(base, deterministicExecutableUuid('com.maka.desktop', 'Maka', CPU_TYPE_X86_64));
  assert.notEqual(base, deterministicExecutableUuid('com.other.app', 'Maka', CPU_TYPE_ARM64));
});

test('rewriting a thin Mach-O replaces only the LC_UUID payload', () => {
  rewrittenLike(
    thinMachO(CPU_TYPE_ARM64, OLD_UUID),
    'com.maka.desktop',
    'Maka',
    () => deterministicExecutableUuid('com.maka.desktop', 'Maka', CPU_TYPE_ARM64),
  );
});

test('rewriting a fat Mach-O gives each architecture its own UUID', () => {
  const { locations } = rewrittenLike(
    fatMachO([
      { cpuType: CPU_TYPE_X86_64, data: thinMachO(CPU_TYPE_X86_64, OLD_UUID) },
      { cpuType: CPU_TYPE_ARM64, data: thinMachO(CPU_TYPE_ARM64, OLD_UUID) },
    ]),
    'com.maka.desktop',
    'Maka',
    (cpuType) => deterministicExecutableUuid('com.maka.desktop', 'Maka', cpuType),
  );
  assert.equal(locations.length, 2);
  assert.notEqual(
    deterministicExecutableUuid('com.maka.desktop', 'Maka', CPU_TYPE_X86_64),
    deterministicExecutableUuid('com.maka.desktop', 'Maka', CPU_TYPE_ARM64),
    'each slice must carry its own UUID',
  );
});

test('rewriting is idempotent', () => {
  const once = thinMachO(CPU_TYPE_ARM64, OLD_UUID);
  rewriteBufferUuids(once, 'com.maka.desktop', 'Maka');
  const twice = Buffer.from(once);
  rewriteBufferUuids(twice, 'com.maka.desktop', 'Maka');
  assert.deepEqual(twice, once);
});

test('the afterPack hook rewrites the app and every helper executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-lc-uuid-'));
  const bundle = join(root, 'Maka.app');
  const helpers = join(bundle, 'Contents', 'Frameworks');
  const executables = [
    [join(bundle, 'Contents', 'MacOS', 'Maka'), 'Maka'],
    [join(helpers, 'Maka Helper.app', 'Contents', 'MacOS', 'Maka Helper'), 'Maka Helper'],
  ];
  for (const [path] of executables) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, thinMachO(CPU_TYPE_ARM64, OLD_UUID));
  }

  await rewritePackagedMacosUuids({
    electronPlatformName: 'darwin',
    appOutDir: root,
    packager: { appInfo: { id: 'com.maka.desktop', productFilename: 'Maka' } },
  });

  for (const [path, name] of executables) {
    const bytes = await readFile(path);
    const expected = deterministicExecutableUuid('com.maka.desktop', name, CPU_TYPE_ARM64);
    const [location] = machoLcUuidLocations(bytes);
    assert.equal(
      bytes.subarray(location.offset, location.offset + 16).toString('hex'),
      expected.replaceAll('-', ''),
      `${path} must carry the deterministic UUID`,
    );
  }
});

test('the afterPack hook leaves non-macOS targets alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-lc-uuid-'));
  await rewritePackagedMacosUuids({
    electronPlatformName: 'win32',
    appOutDir: root,
    packager: { appInfo: { id: 'com.maka.desktop', productFilename: 'Maka' } },
  });
  assert.equal((await readdir(root)).length, 0, 'nothing may be written for win32');
});
