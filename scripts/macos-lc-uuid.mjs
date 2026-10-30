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

/**
 * Rewrites the LC_UUID load command of the main and helper executables of a
 * packaged macOS app bundle (#6026).
 *
 * electron-builder renames Electron's executable files but never relinks them,
 * so every shipped binary keeps the UUID burned into it by Electron's build:
 * identical across every Electron app of the same version. macOS 15+ local-
 * network privacy (NECP) identifies a program by its main executable's
 * LC_UUID, so Maka shares a privacy identity with every other Electron 43
 * install and never gets an entry of its own.
 *
 * Scope: regular files under `*.app/Contents/MacOS` — the main executable and
 * the helpers, the binaries NECP keys on. `Electron Framework`, the dylibs,
 * `chrome_crashpad_handler` and ShipIt keep Electron's own UUIDs; symbolizing
 * their crash reports keeps working unchanged.
 *
 * The replacement is UUIDv5 (SHA-1, RFC 4122) over the app id, the executable
 * file name, the slice's CPU type and the slice's original UUID. The original
 * UUID is the native-build discriminator (Apple TN3178): two Electron builds
 * of the same version carry different originals, so they stay distinguishable
 * after the rewrite, and repackaging the same Electron dist yields the same
 * identity. The trade-off: Electron's published dSYMs no longer match the
 * rewritten executables, so the hook writes `lc-uuid-map.json` next to the
 * bundle mapping every original UUID to its replacement for crash
 * diagnostics. It runs from the `afterPack` hook, which is before code
 * signing: the signature then covers the rewritten bytes, and notarization
 * sees a self-consistent bundle.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const MH_MAGIC_64 = 0xfeedfacf;
// Fat headers store their magic big-endian, so a little-endian read of
// 0xcafebabe / 0xcafebabf yields the swapped values below.
const FAT_MAGICS = new Map([
  [0xbebafeca, { archEntrySize: 20 }],
  [0xbfbafeca, { archEntrySize: 32 }],
]);
const LC_UUID = 0x1b;
const MACHO_HEADER_64_SIZE = 32;
const LOAD_COMMAND_HEADER_SIZE = 8;
const UUID_SIZE = 16;

// RFC 4122 Appendix C.1 namespace for fully-qualified domain names.
const DNS_NAMESPACE_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
// Derived, not invented: no magic constant here needs to be trusted, only the
// project domain this namespace is pulled from.
const MAKA_UUID_NAMESPACE = uuidv5(DNS_NAMESPACE_UUID, 'maka.apache.org');

// The cputypes that actually appear in an Electron fat binary. arm64e shares
// the ARM64 cputype and differs only in cpusubtype, so it is not
// distinguishable — and not distinguishable is fine, because Electron ships
// no arm64e slices; anything unexpected still gets a stable name via the
// fallback below.
const CPU_TYPE_NAMES = new Map([
  [0x01000007, 'x86_64'],
  [0x0100000c, 'arm64'],
]);

function formatUuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function uuidv5(namespaceUuid, name) {
  const digest = createHash('sha1')
    .update(Buffer.from(namespaceUuid.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = digest.toString('hex', 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function cpuTypeName(cpuType) {
  return CPU_TYPE_NAMES.get(cpuType) ?? `cpu-0x${cpuType.toString(16)}`;
}

/**
 * The deterministic replacement UUID for one executable slice: distinct per
 * app, per executable, per architecture and per native build (via the slice's
 * original UUID), yet stable across rebuilds of the same Electron dist.
 */
export function deterministicExecutableUuid(appId, executableName, cpuType, originalUuid) {
  // '/' cannot appear in a file name or a UUID, so the joined name is
  // unambiguous.
  return uuidv5(
    MAKA_UUID_NAMESPACE,
    `${appId}/${executableName}/${cpuTypeName(cpuType)}/${originalUuid}`,
  );
}

/**
 * Offsets of every LC_UUID payload in a Mach-O buffer (thin 64-bit or fat),
 * each with its slice's CPU type. Thin 32-bit slices cannot appear in an
 * Electron bundle and are rejected rather than misparsed.
 */
export function machoLcUuidLocations(buffer) {
  const magic = buffer.readUInt32LE(0);
  const fat = FAT_MAGICS.get(magic);
  if (!fat) return thinLcUuidLocations(buffer, 0);
  const locations = [];
  const sliceCount = buffer.readUInt32BE(4);
  for (let index = 0; index < sliceCount; index += 1) {
    const entry = 8 + index * fat.archEntrySize;
    const sliceOffset = Number(
      fat.archEntrySize === 32 ? buffer.readBigUInt64BE(entry + 8) : buffer.readUInt32BE(entry + 8),
    );
    locations.push(...thinLcUuidLocations(buffer, sliceOffset));
  }
  return locations;
}

function thinLcUuidLocations(buffer, base) {
  const magic = buffer.readUInt32LE(base);
  if (magic !== MH_MAGIC_64) {
    throw new Error(`unsupported Mach-O magic 0x${magic.toString(16)} at offset ${base}`);
  }
  const cpuType = buffer.readUInt32LE(base + 4);
  const commandCount = buffer.readUInt32LE(base + 16);
  const locations = [];
  let cursor = base + MACHO_HEADER_64_SIZE;
  for (let index = 0; index < commandCount; index += 1) {
    const commandSize = buffer.readUInt32LE(cursor + 4);
    if (commandSize < LOAD_COMMAND_HEADER_SIZE) {
      throw new Error(`corrupt load command size ${commandSize} at offset ${cursor}`);
    }
    if (buffer.readUInt32LE(cursor) === LC_UUID) {
      locations.push({ offset: cursor + LOAD_COMMAND_HEADER_SIZE, cpuType });
    }
    cursor += commandSize;
  }
  return locations;
}

/**
 * Replaces every LC_UUID payload in `buffer` in place; the buffer length and
 * all other bytes are left exactly as they were. Returns one record per
 * rewritten payload, keyed by CPU type, with the original and replacement
 * UUIDs.
 */
export function rewriteBufferUuids(buffer, appId, executableName) {
  const mapping = [];
  for (const { offset, cpuType } of machoLcUuidLocations(buffer)) {
    const original = formatUuid(buffer.subarray(offset, offset + UUID_SIZE));
    const rewritten = deterministicExecutableUuid(appId, executableName, cpuType, original);
    Buffer.from(rewritten.replaceAll('-', ''), 'hex').copy(buffer, offset);
    mapping.push({ cpuType: cpuTypeName(cpuType), original, rewritten });
  }
  return mapping;
}

async function rewriteExecutableFile(path, appId) {
  const buffer = await readFile(path);
  if (machoLcUuidLocations(buffer).length === 0) {
    throw new Error(`no LC_UUID load command in packaged executable ${path}`);
  }
  const mapping = rewriteBufferUuids(buffer, appId, basename(path));
  await writeFile(path, buffer);
  return mapping;
}

async function findAppBundleExecutables(directory) {
  const executables = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.endsWith('.app')) {
      const macOS = join(path, 'Contents', 'MacOS');
      for (const file of await readdir(macOS, { withFileTypes: true })) {
        if (file.isFile()) executables.push(join(macOS, file.name));
      }
    }
    // Helper bundles are nested inside the main one
    // (`Maka.app/Contents/Frameworks/*.app`), so the walk has to descend
    // through found bundles to reach them.
    executables.push(...(await findAppBundleExecutables(path)));
  }
  return executables;
}

/**
 * The electron-builder `afterPack` hook: rewrites the main executable and
 * every helper executable of the packaged macOS app and writes the
 * original-to-rewritten UUID map next to the bundle for crash diagnostics.
 * Runs before signing, so the new UUIDs are covered by the signature. Other
 * platforms have no Mach-O to fix and are untouched.
 */
export async function rewritePackagedMacosUuids(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appId = context.packager.appInfo.id;
  const executables = await findAppBundleExecutables(context.appOutDir);
  if (executables.length === 0) {
    throw new Error(`no .app bundle found under ${context.appOutDir}`);
  }
  const map = {};
  for (const executable of executables) {
    map[executable] = await rewriteExecutableFile(executable, appId);
  }
  const mapPath = join(context.appOutDir, 'lc-uuid-map.json');
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  return map;
}
