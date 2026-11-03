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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDetailsOptions, BaseWindow, NativeImage } from 'electron';

/** Must stay aligned with electron-builder's appId and installed shortcut. */
export const WINDOWS_APP_USER_MODEL_ID = 'com.maka.desktop';

const TASKBAR_ICON_SIZE = 256;

/**
 * Windows accepts a PNG image inside an ICO directory entry. Keeping this
 * tiny encoder here avoids adding a native image-conversion dependency merely
 * to give the taskbar property store a resource it can consume.
 */
export function encodePngAsIco(png: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(0, 6); // 0 means 256 pixels
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8); // palette size: true colour
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

/**
 * Persist the selected artwork as a content-addressed ICO. Explorer may read
 * the relaunch icon after this process exits, so a temporary file is not a
 * valid taskbar resource. Content addressing also makes rapid changes
 * last-write-wins without an older async conversion overwriting a newer one.
 */
export function persistWindowsTaskbarIcon(userData: string, image: NativeImage): string {
  const png = image.resize({
    width: TASKBAR_ICON_SIZE,
    height: TASKBAR_ICON_SIZE,
    quality: 'better',
  }).toPNG();
  const digest = createHash('sha256').update(png).digest('hex');
  const directory = join(userData, 'taskbar-icons');
  const destination = join(directory, `${digest}.ico`);
  if (existsSync(destination)) return destination;

  mkdirSync(directory, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, encodePngAsIco(png));
  try {
    renameSync(temporary, destination);
  } catch (error) {
    // Another window in this process may have materialized the same digest.
    // Keep that complete file and discard only our private temporary file.
    if (!existsSync(destination)) throw error;
    rmSync(temporary, { force: true });
  }
  return destination;
}

export function windowsTaskbarAppDetails(
  userData: string,
  image: NativeImage,
): AppDetailsOptions {
  return {
    appId: WINDOWS_APP_USER_MODEL_ID,
    appIconPath: persistWindowsTaskbarIcon(userData, image),
    appIconIndex: 0,
  };
}

export function applyWindowsTaskbarAppDetails(
  window: Pick<BaseWindow, 'setAppDetails'>,
  userData: string,
  image: NativeImage,
): void {
  window.setAppDetails(windowsTaskbarAppDetails(userData, image));
}
