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

// electron-builder ships Electron's prebuilt executables renamed, not relinked,
// so every app on the same Electron release carries the same Mach-O LC_UUID.
// macOS Local Network Privacy (NECP) identifies a program by its main
// executable's LC_UUID, so a shared UUID lets one app's grant or denial land on
// another. The packaging hook stamps each executable with a UUID of its own
// before signing; the release verifier checks the stamp survived.

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_UUID = 0x1b;
const MACH_HEADER_64_SIZE = 32;
const FAT_ARCH_SIZE = 20;

// Fixed namespace for the UUIDv5 names below. Changing it changes every
// shipped UUID, which macOS treats as a different program.
const MAKA_EXECUTABLE_UUID_NAMESPACE = Buffer.from('4195730630d44e84a842a14db6f67a8f', 'hex');

/**
 * The UUID an executable ships with. Deterministic on purpose: it stays the same
 * from one release to the next, so a user's Local Network decision survives an
 * update, while the app id keeps it distinct from every other Electron app and
 * the CPU type keeps the arm64 and x64 builds apart.
 */
export function expectedExecutableUuid({ appId, executableName, cputype }) {
  const digest = createHash('sha1')
    .update(MAKA_EXECUTABLE_UUID_NAMESPACE)
    .update(`${appId}/${executableName}/${cputype}`)
    .digest();
  const uuid = digest.subarray(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  return formatUuid(uuid);
}

function formatUuid(bytes) {
  const hex = bytes.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sliceOffsets(binary) {
  if (binary.length >= 4 && binary.readUInt32BE(0) === FAT_MAGIC) {
    const count = binary.readUInt32BE(4);
    return Array.from({ length: count }, (_, index) =>
      binary.readUInt32BE(8 + index * FAT_ARCH_SIZE + 8),
    );
  }
  return [0];
}

function uuidCommandOffset(binary, sliceOffset) {
  if (binary.length < sliceOffset + MACH_HEADER_64_SIZE) {
    throw new Error('truncated Mach-O header');
  }
  if (binary.readUInt32LE(sliceOffset) !== MH_MAGIC_64) {
    throw new Error('not a 64-bit Mach-O executable');
  }
  const cputype = binary.readUInt32LE(sliceOffset + 4);
  const commandCount = binary.readUInt32LE(sliceOffset + 16);
  let cursor = sliceOffset + MACH_HEADER_64_SIZE;
  for (let index = 0; index < commandCount; index++) {
    const command = binary.readUInt32LE(cursor);
    const size = binary.readUInt32LE(cursor + 4);
    if (command === LC_UUID) return { cputype, offset: cursor + 8 };
    if (size < 8) throw new Error('malformed Mach-O load command');
    cursor += size;
  }
  throw new Error('Mach-O executable has no LC_UUID load command');
}

/** Every slice's CPU type and LC_UUID, in file order. */
export function machOUuids(binary) {
  return sliceOffsets(binary).map((sliceOffset) => {
    const { cputype, offset } = uuidCommandOffset(binary, sliceOffset);
    return { cputype, uuid: formatUuid(binary.subarray(offset, offset + 16)) };
  });
}

/** A copy of `binary` with each slice's LC_UUID replaced by its expected UUID. */
export function stampMachOUuids(binary, { appId, executableName }) {
  const stamped = Buffer.from(binary);
  for (const sliceOffset of sliceOffsets(stamped)) {
    const { cputype, offset } = uuidCommandOffset(stamped, sliceOffset);
    const uuid = expectedExecutableUuid({ appId, executableName, cputype });
    Buffer.from(uuid.replaceAll('-', ''), 'hex').copy(stamped, offset);
  }
  return stamped;
}

/**
 * The app's main executable and each helper app's, read from the bundle rather
 * than from Electron's naming convention: one file in every `Contents/MacOS`.
 */
export async function macAppExecutables(appPath) {
  const frameworks = join(appPath, 'Contents', 'Frameworks');
  const helpers = (await readdir(frameworks)).filter((name) => name.endsWith('.app')).sort();
  const bundles = [appPath, ...helpers.map((name) => join(frameworks, name))];
  return Promise.all(
    bundles.map(async (bundle) => {
      const directory = join(bundle, 'Contents', 'MacOS');
      const entries = await readdir(directory);
      if (entries.length !== 1) {
        throw new Error(`Expected one executable in ${directory}, found ${entries.length}.`);
      }
      return { name: entries[0], path: join(directory, entries[0]) };
    }),
  );
}

export async function stampMacAppExecutableUuids(appPath, appId) {
  for (const { name, path } of await macAppExecutables(appPath)) {
    await writeFile(path, stampMachOUuids(await readFile(path), { appId, executableName: name }));
  }
}

export async function assertMacAppExecutableUuids(appPath, appId) {
  const executables = await macAppExecutables(appPath);
  if (executables.length < 2) {
    throw new Error(`Expected Maka and its helper executables in ${appPath}.`);
  }
  for (const { name, path } of executables) {
    for (const { cputype, uuid } of machOUuids(await readFile(path))) {
      const expected = expectedExecutableUuid({ appId, executableName: name, cputype });
      if (uuid !== expected) {
        throw new Error(
          `${name} ships LC_UUID ${uuid}, expected ${expected}; the packaging hook did not stamp it.`,
        );
      }
    }
  }
}
