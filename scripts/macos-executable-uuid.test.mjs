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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertMacAppExecutableUuids,
  expectedExecutableUuid,
  machOUuids,
  stampMacAppExecutableUuids,
  stampMachOUuids,
} from './macos-executable-uuid.mjs';

const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;
// Electron 43.4.1's arm64 executable; any app that ships it renamed carries it too.
const STOCK_UUID = '4C4C4470-5555-3144-A124-518576DD11E3';
const APP_ID = 'com.maka.desktop';

// A minimal 64-bit Mach-O slice: header, an unrelated load command, LC_UUID.
function machOSlice(cputype, uuid = STOCK_UUID) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cputype, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(40, 20);
  const other = Buffer.alloc(16);
  other.writeUInt32LE(0x32, 0);
  other.writeUInt32LE(16, 4);
  const uuidCommand = Buffer.alloc(24);
  uuidCommand.writeUInt32LE(0x1b, 0);
  uuidCommand.writeUInt32LE(24, 4);
  Buffer.from(uuid.replaceAll('-', ''), 'hex').copy(uuidCommand, 8);
  return Buffer.concat([header, other, uuidCommand]);
}

function fatBinary(slices) {
  const tableSize = 8 + slices.length * 20;
  const table = Buffer.alloc(tableSize);
  table.writeUInt32BE(0xcafebabe, 0);
  table.writeUInt32BE(slices.length, 4);
  let offset = tableSize;
  slices.forEach((slice, index) => {
    const entry = 8 + index * 20;
    table.writeUInt32BE(slice.readUInt32LE(4), entry);
    table.writeUInt32BE(offset, entry + 8);
    table.writeUInt32BE(slice.length, entry + 12);
    offset += slice.length;
  });
  return Buffer.concat([table, ...slices]);
}

describe('expectedExecutableUuid', () => {
  const base = { appId: APP_ID, executableName: 'Maka', cputype: CPU_TYPE_ARM64 };

  test('is stable across calls, so an update keeps the identity macOS saw', () => {
    assert.equal(expectedExecutableUuid(base), expectedExecutableUuid({ ...base }));
  });

  test('differs by app id, executable and CPU type', () => {
    const uuids = new Set([
      expectedExecutableUuid(base),
      expectedExecutableUuid({ ...base, appId: 'com.example.other' }),
      expectedExecutableUuid({ ...base, executableName: 'Maka Helper' }),
      expectedExecutableUuid({ ...base, cputype: CPU_TYPE_X86_64 }),
    ]);
    assert.equal(uuids.size, 4);
  });

  // The namespace and name format are part of the shipped identity; a refactor
  // that changes this value changes the UUID of every Maka executable.
  test('keeps the shipped UUID of the arm64 main executable', () => {
    assert.equal(expectedExecutableUuid(base), 'E08E3A84-68A1-5189-9663-A4FEC17A5EE5');
  });

  test('is a well-formed version 5 UUID', () => {
    assert.match(
      expectedExecutableUuid(base),
      /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/,
    );
  });
});

describe('stampMachOUuids', () => {
  test('replaces the stock UUID of a thin executable without touching the input', () => {
    const original = machOSlice(CPU_TYPE_ARM64);
    const stamped = stampMachOUuids(original, { appId: APP_ID, executableName: 'Maka' });

    assert.deepEqual(machOUuids(original), [{ cputype: CPU_TYPE_ARM64, uuid: STOCK_UUID }]);
    assert.deepEqual(machOUuids(stamped), [
      {
        cputype: CPU_TYPE_ARM64,
        uuid: expectedExecutableUuid({
          appId: APP_ID,
          executableName: 'Maka',
          cputype: CPU_TYPE_ARM64,
        }),
      },
    ]);
    assert.equal(stamped.length, original.length);
  });

  test('is idempotent', () => {
    const once = stampMachOUuids(machOSlice(CPU_TYPE_ARM64), {
      appId: APP_ID,
      executableName: 'Maka',
    });
    assert.deepEqual(stampMachOUuids(once, { appId: APP_ID, executableName: 'Maka' }), once);
  });

  test('gives each slice of a universal executable its own UUID', () => {
    const stamped = stampMachOUuids(
      fatBinary([machOSlice(CPU_TYPE_X86_64), machOSlice(CPU_TYPE_ARM64)]),
      { appId: APP_ID, executableName: 'Maka' },
    );
    const [x64, arm64] = machOUuids(stamped);
    assert.equal(x64.cputype, CPU_TYPE_X86_64);
    assert.equal(arm64.cputype, CPU_TYPE_ARM64);
    assert.notEqual(x64.uuid, arm64.uuid);
    assert.notEqual(x64.uuid, STOCK_UUID);
    assert.notEqual(arm64.uuid, STOCK_UUID);
  });

  test('refuses a file that is not a 64-bit Mach-O executable', () => {
    assert.throws(
      () =>
        stampMachOUuids(Buffer.from('#!/bin/sh\necho hi\n'.padEnd(64)), {
          appId: APP_ID,
          executableName: 'Maka',
        }),
      /not a 64-bit Mach-O executable/,
    );
  });

  test('refuses a universal executable with no slices', () => {
    assert.throws(() => machOUuids(Buffer.from('cafebabe00000000', 'hex')), /has no slices/);
  });

  test('refuses a universal slice that extends past the file', () => {
    const fat = fatBinary([machOSlice(CPU_TYPE_ARM64)]);
    fat.writeUInt32BE(fat.length, 8 + 12);
    assert.throws(() => machOUuids(fat), /extends past the file/);
  });

  test('refuses an LC_UUID command of the wrong size', () => {
    const slice = machOSlice(CPU_TYPE_ARM64);
    slice.writeUInt32LE(8, 48 + 4);
    assert.throws(
      () => stampMachOUuids(slice, { appId: APP_ID, executableName: 'Maka' }),
      /malformed LC_UUID/,
    );
  });

  test('refuses load commands that extend past the slice', () => {
    const slice = machOSlice(CPU_TYPE_ARM64);
    slice.writeUInt32LE(4096, 20);
    assert.throws(() => machOUuids(slice), /extend past the slice/);
  });

  test('refuses an executable without an LC_UUID load command', () => {
    const slice = machOSlice(CPU_TYPE_ARM64);
    slice.writeUInt32LE(1, 16);
    assert.throws(() => machOUuids(slice), /no LC_UUID load command/);
  });

  test("rewrites the UUID of Electron's own executable", {
    skip: process.platform !== 'darwin' && 'Electron ships a Mach-O executable only on macOS',
  }, async () => {
    const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
    const executable = join(
      dirname(require.resolve('electron/package.json')),
      'dist/Electron.app/Contents/MacOS/Electron',
    );
    const original = await readFile(executable);
    const stamped = stampMachOUuids(original, { appId: APP_ID, executableName: 'Maka' });
    const before = machOUuids(original);
    const after = machOUuids(stamped);

    assert.equal(after.length, before.length);
    for (const [index, { cputype, uuid }] of after.entries()) {
      assert.notEqual(uuid, before[index].uuid);
      assert.equal(
        uuid,
        expectedExecutableUuid({ appId: APP_ID, executableName: 'Maka', cputype }),
      );
    }
  });
});

describe('Maka.app executables', () => {
  const executables = ['Maka', 'Maka Helper', 'Maka Helper (GPU)', 'Maka Helper (Renderer)'];

  async function makeApp(t) {
    const root = await mkdtemp(join(tmpdir(), 'maka-uuid-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = join(root, 'Maka.app');
    for (const name of executables) {
      const bundle = name === 'Maka' ? app : join(app, 'Contents', 'Frameworks', `${name}.app`);
      await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true });
      await writeFile(join(bundle, 'Contents', 'MacOS', name), machOSlice(CPU_TYPE_ARM64));
    }
    // A framework is not a helper app and is left alone.
    await mkdir(join(app, 'Contents', 'Frameworks', 'Electron Framework.framework'));
    return app;
  }

  test('the release check rejects executables that still carry the stock UUID', async (t) => {
    const app = await makeApp(t);
    await assert.rejects(
      assertMacAppExecutableUuids(app, APP_ID),
      new RegExp(`Maka ships LC_UUID ${STOCK_UUID}`),
    );
  });

  test('stamping gives every executable a distinct UUID the release check accepts', async (t) => {
    const app = await makeApp(t);
    await stampMacAppExecutableUuids(app, APP_ID);
    await assertMacAppExecutableUuids(app, APP_ID);

    const uuids = await Promise.all(
      executables.map(async (name) => {
        const bundle = name === 'Maka' ? app : join(app, 'Contents', 'Frameworks', `${name}.app`);
        return machOUuids(await readFile(join(bundle, 'Contents', 'MacOS', name)))[0].uuid;
      }),
    );
    assert.equal(new Set(uuids).size, executables.length);
    assert.ok(!uuids.includes(STOCK_UUID));
  });

  test('the release check rejects an app stamped for another app id', async (t) => {
    const app = await makeApp(t);
    await stampMacAppExecutableUuids(app, 'com.example.other');
    await assert.rejects(assertMacAppExecutableUuids(app, APP_ID), /did not stamp it/);
  });
});
