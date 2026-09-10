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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where the rebuilt Windows taskbar icon is cached, under the user data
 * directory the app owns.
 *
 * A `.ico` cannot travel as bytes: `nativeImage` decodes PNG/JPG only, so
 * `createFromBuffer` of an ICO returns an EMPTY image. The artwork is written
 * to this file instead and Windows is handed the path — which makes this name
 * part of the fix rather than an implementation detail, so it stays put.
 *
 * The root is a parameter, not `app.getPath('userData')`, so the cache can be
 * exercised without an Electron process.
 */
export function windowsTaskbarIconCachePath(userDataRoot: string): string {
  return join(userDataRoot, 'app-icon-cache', 'taskbar.ico');
}

/**
 * Writes the rebuilt ICO and returns the path to hand Windows, or `null` when
 * the cache cannot be written.
 *
 * `null` rather than a throw: the caller's fallback is the PNG master, and a
 * taskbar that keeps showing the packaged tile is a smaller loss than an icon
 * that decodes to nothing. The failure is reported here because a silent
 * `null` would leave "the taskbar is wrong" with no evidence of why.
 */
export function writeWindowsTaskbarIconCache(
  userDataRoot: string,
  bytes: Uint8Array,
): string | null {
  const path = windowsTaskbarIconCachePath(userDataRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  } catch (error) {
    console.error('[icon] failed to cache the Windows taskbar icon:', error);
    return null;
  }
}
