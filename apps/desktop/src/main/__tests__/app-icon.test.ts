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
import { open } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { APP_ICONS } from '@maka/core/settings';
import {
  appIconAssetSegments,
  appIconLoadOrder,
  encodeWindowsIco,
  firstReadableAppIconPath,
  pickReadableAppIconPath,
  resolveAppIconPath,
  WINDOWS_TASKBAR_ICON_SIZES,
} from '../app-icon.js';
import { isAppIcon, toAppIconChoice, type AppIconChoice } from '@maka/core/settings';
import { desktopAssetRoot } from '../desktop-assets.js';

const DEV_ROOT = desktopAssetRoot({ isPackaged: false, resourcesPath: '/not-used-in-dev' });

/**
 * The OS is handed these files directly, and Electron reports an unreadable
 * one as an EMPTY image rather than as an error — a dock tile silently goes
 * blank. So the contract every id must meet is checked here, against the
 * bytes: present, a real PNG, and the square master the dock wants rather
 * than a screenshot someone dropped in with the right name.
 */
test('every shipped icon id resolves to a square 1024px PNG master', async () => {
  for (const icon of APP_ICONS) {
    const path = resolveAppIconPath(DEV_ROOT, icon);
    const where = `app icon "${icon}" (${appIconAssetSegments(icon).join('/')})`;
    const file = await open(path, 'r').catch(() => undefined);
    assert.ok(file, `${where} has no artwork in the build`);
    try {
      // PNG signature, then the IHDR width/height at bytes 16..24.
      const header = Buffer.alloc(24);
      await file.read(header, 0, header.length, 0);
      assert.equal(
        header.subarray(0, 8).toString('hex'),
        '89504e470d0a1a0a',
        `${where} is not a PNG`,
      );
      assert.equal(header.readUInt32BE(16), 1024, `${where} is not 1024px wide`);
      assert.equal(header.readUInt32BE(20), 1024, `${where} is not 1024px tall`);
    } finally {
      await file.close();
    }
  }
});

test('a packaged build reads artwork from the copy beside the app', () => {
  // `files` in the builder config does not carry `assets/`, so a packaged app
  // has no repo tree to resolve against; the artwork rides along as an extra
  // resource instead. Resolving the dev path there would hand `setIcon` an
  // empty image and blank the dock tile without raising anything.
  assert.equal(
    resolveAppIconPath(
      desktopAssetRoot({ isPackaged: true, resourcesPath: join('/Apps', 'Maka.app', 'Contents', 'Resources') }),
      'sky',
    ),
    join('/Apps', 'Maka.app', 'Contents', 'Resources', 'assets', 'app-icons', 'sky.png'),
  );
});

test('the default keeps its long-standing path while variants live in their own directory', () => {
  assert.deepEqual(appIconAssetSegments('default'), ['assets', 'icon.png']);
  assert.deepEqual(appIconAssetSegments('mono'), ['assets', 'app-icons', 'mono.png']);
  assert.equal(
    resolveAppIconPath(join('/tmp', 'desktop'), 'mono'),
    join('/tmp', 'desktop', 'assets', 'app-icons', 'mono.png'),
  );
});

test('a variant falls back to the brand mark, and the brand mark has nothing to fall back to', () => {
  // A build that lost assets/app-icons/ — a packaging filter, a half-applied
  // update — should land on the brand mark rather than on the OS placeholder.
  assert.deepEqual(appIconLoadOrder('mono'), ['mono', 'default']);
  // No self-referential retry: if the brand mark itself is unreadable there is
  // nothing left to try, and looping over it twice would only hide that.
  assert.deepEqual(appIconLoadOrder('default'), ['default']);
});

test('a malformed choice cannot become a path outside the asset root', () => {
  const root = join('/app', 'Resources');
  for (const escape of ['../../../../tmp/owned', 'custom:../../etc/passwd', '', 42, null]) {
    const choice = toAppIconChoice(escape);
    // The guard both documents the contract and narrows: nothing malformed
    // survives as anything other than a shipped id.
    assert.ok(isAppIcon(choice), `${String(escape)} should coerce to a shipped id`);
    const resolved = resolveAppIconPath(root, choice);
    assert.ok(
      resolved.startsWith(root + sep),
      `${String(escape)} resolved to ${resolved}, outside ${root}`,
    );
    // And it lands on the brand mark rather than on some other shipped file.
    assert.equal(resolved, join(root, 'assets', 'icon.png'));
  }
});

test('a persisted custom id whose file disappeared falls back to the brand mark', () => {
  const root = join('/app', 'Resources');
  const gone = `custom:${'d'.repeat(32)}` as const;
  const toPath = (choice: AppIconChoice) =>
    choice.startsWith('custom:')
      ? join('/user-data', 'app-icons', `${choice.slice(7)}.png`)
      : resolveAppIconPath(root, choice as never);

  // Only the brand mark reads; the imported file was deleted behind the app.
  const resolved = pickReadableAppIconPath(gone, toPath, (path) =>
    path === join(root, 'assets', 'icon.png'),
  );
  assert.equal(resolved, join(root, 'assets', 'icon.png'));

  // And when it does read, the choice is honoured rather than always falling back.
  assert.equal(
    pickReadableAppIconPath(gone, toPath, () => true),
    join('/user-data', 'app-icons', `${'d'.repeat(32)}.png`),
  );
});

test('artwork that is gone resolves to nothing rather than to a dead path', () => {
  // The contract the icon *replacement* path depends on: `undefined` is what
  // leaves a window's existing icon alone, where a path that decodes to
  // nothing would blank it.
  const gone = `custom:${'e'.repeat(32)}` as const;
  const toPath = (choice: AppIconChoice) => join('/user-data', 'app-icons', `${choice.slice(7)}.png`);

  assert.equal(
    firstReadableAppIconPath(gone, toPath, () => false),
    undefined,
    'no candidate reads, so there is no path to hand Windows or Linux',
  );

  // And a readable candidate still wins, so the answer is not just "none".
  const readable = toPath(gone);
  assert.equal(
    firstReadableAppIconPath(gone, toPath, (path) => path === readable),
    readable,
  );
});

/**
 * CRC-32 over one chunk's type and data, as PNG defines it. The frames below
 * are built here rather than faked with a string, because a container test
 * cannot say whether the bytes Windows would decode are actually an image.
 */
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * An 8-bit RGBA PNG of one flat colour, `size` by `size`.
 *
 * Real bytes, at the size the directory entry declares: that is what the
 * Windows loader reads, and a frame whose own header disagrees with its entry
 * is invisible to a test that only walks the container.
 */
function pngOfSize(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // colour type: RGBA, the 32bpp the entries declare
  // Bytes 10..12 stay 0: the one compression, filter and interlace method.
  const row = Buffer.alloc(1 + size * 4); // filter byte, then RGBA pixels
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('the Windows ICO carries every taskbar size as a PNG frame', () => {
  const frames = WINDOWS_TASKBAR_ICON_SIZES.map((size) => ({ size, png: pngOfSize(size) }));
  const encoded = encodeWindowsIco(frames);
  assert.equal(encoded.readUInt16LE(0), 0);
  assert.equal(encoded.readUInt16LE(2), 1);
  assert.equal(encoded.readUInt16LE(4), frames.length);

  let cursor = 6;
  for (const frame of frames) {
    // 256 is stored as 0: the size field is one byte wide.
    const storedSize = frame.size >= 256 ? 0 : frame.size;
    assert.equal(encoded.readUInt8(cursor), storedSize);
    assert.equal(encoded.readUInt8(cursor + 1), storedSize);
    assert.equal(encoded.readUInt16LE(cursor + 4), 1);
    assert.equal(encoded.readUInt16LE(cursor + 6), 32);
    assert.equal(encoded.readUInt32LE(cursor + 8), frame.png.byteLength);
    const offset = encoded.readUInt32LE(cursor + 12);
    const payload = encoded.subarray(offset, offset + frame.png.byteLength);
    // The entry has to land on this frame's own bytes — an offset that is
    // merely in range leaves Windows decoding a neighbour's data.
    assert.deepEqual(Buffer.from(payload), frame.png);
    // ...and those bytes have to be a PNG of the size the entry promises.
    assert.equal(payload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(payload.readUInt32BE(16), frame.size, 'the frame is not the size the entry declares');
    assert.equal(payload.readUInt32BE(20), frame.size, 'the frame is not the size the entry declares');
    cursor += 16;
  }

  // Header plus frames and nothing more: an offset past the end of the file
  // would still be readable as a number here.
  assert.equal(
    encoded.byteLength,
    6 + 16 * frames.length + frames.reduce((total, frame) => total + frame.png.byteLength, 0),
  );

  assert.deepEqual(
    [...WINDOWS_TASKBAR_ICON_SIZES],
    [16, 24, 32, 48, 64, 256],
    'Windows needs a 16px and 32px frame; dropping either leaves the taskbar on the packaged sky icon',
  );
});
