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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NativeImage } from 'electron';
import {
  applyWindowsTaskbarAppDetails,
  encodePngAsIco,
  persistWindowsTaskbarIcon,
  windowsTaskbarAppDetails,
  WINDOWS_APP_USER_MODEL_ID,
} from '../windows-taskbar-icon.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('wraps the selected PNG in one valid 256px ICO directory entry', () => {
  const ico = encodePngAsIco(PNG);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico.readUInt8(6), 0);
  assert.equal(ico.readUInt8(7), 0);
  assert.equal(ico.readUInt16LE(10), 1);
  assert.equal(ico.readUInt16LE(12), 32);
  assert.equal(ico.readUInt32LE(14), PNG.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.deepEqual(ico.subarray(22), PNG);
});

test('persists a stable content-addressed taskbar resource under userData', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-taskbar-icon-'));
  const userData = join(root, 'Maka, Profile 中文');
  const resizeCalls: unknown[] = [];
  const image = {
    resize(options: unknown) {
      resizeCalls.push(options);
      return { toPNG: () => PNG };
    },
  } as unknown as NativeImage;
  try {
    const first = persistWindowsTaskbarIcon(userData, image);
    const second = persistWindowsTaskbarIcon(userData, image);
    assert.equal(first, second);
    assert.equal(resizeCalls.length, 2);
    assert.match(first, /taskbar-icons[/\\][a-f0-9]{64}\.ico$/);
    assert.deepEqual(readFileSync(first), encodePngAsIco(PNG));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses the installed application identity with the persisted ICO resource', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-taskbar-details-'));
  const image = {
    resize: () => ({ toPNG: () => PNG }),
  } as unknown as NativeImage;
  try {
    const details = windowsTaskbarAppDetails(root, image);
    assert.equal(details.appId, WINDOWS_APP_USER_MODEL_ID);
    assert.equal(details.appIconIndex, 0);
    assert.match(details.appIconPath ?? '', /\.ico$/);
    assert.ok(readFileSync(details.appIconPath ?? '').length > PNG.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes the taskbar details through the window property store boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-taskbar-window-'));
  const image = {
    resize: () => ({ toPNG: () => PNG }),
  } as unknown as NativeImage;
  const calls: unknown[] = [];
  try {
    applyWindowsTaskbarAppDetails(
      { setAppDetails: (details) => calls.push(details) },
      root,
      image,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], windowsTaskbarAppDetails(root, image));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
