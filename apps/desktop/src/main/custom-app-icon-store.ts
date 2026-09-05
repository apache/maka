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

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CustomAppIcon } from '@maka/core/settings';

/** Edge length every imported icon is normalized to before it is stored. */
export const CUSTOM_ICON_EDGE = 1024;

/** Below this the art has nothing to say at 1024 and reads as a mistake. */
export const CUSTOM_ICON_MIN_EDGE = 128;

/**
 * Above this the source is not an icon, and decoding it would allocate a
 * bitmap far past anything the 1024 target needs — 4096² is already 67 MB.
 */
export const CUSTOM_ICON_MAX_EDGE = 4096;

/** A decode cap, not a quality bar: 16 MB is far past any real icon. */
export const CUSTOM_ICON_MAX_INPUT_BYTES = 16 * 1024 * 1024;

const ID_PATTERN = /^[0-9a-f]{32}$/;

export type CustomAppIconImportReason =
  | 'cancelled'
  | 'too_large'
  | 'too_many_pixels'
  | 'unsupported_format'
  | 'unreadable'
  | 'too_small'
  | 'write_failed';


export class CustomAppIconError extends Error {
  readonly reason: Exclude<CustomAppIconImportReason, 'cancelled'>;

  constructor(reason: Exclude<CustomAppIconImportReason, 'cancelled'>, message: string) {
    super(message);
    this.name = 'CustomAppIconError';
    this.reason = reason;
  }
}

/** Where imported artwork lives. Owned by the app, never named by the renderer. */
export function customAppIconDirectory(userDataPath: string): string {
  return join(userDataPath, 'app-icons');
}

/**
 * The id is the entire file name, so an id that is not 32 hex characters must
 * never reach `join`: `..` would walk straight out of the directory the app
 * owns. Core validates the same shape when it normalizes the setting; this is
 * the second gate, at the boundary that actually touches the disk.
 */
export function resolveCustomAppIconPath(userDataPath: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new CustomAppIconError('unreadable', `bad custom icon id`);
  return join(customAppIconDirectory(userDataPath), `${id}.png`);
}

/** Ids of every imported icon, oldest first, skipping anything unrecognised. */
export async function listCustomAppIconIds(userDataPath: string): Promise<readonly string[]> {
  const entries = await readdir(customAppIconDirectory(userDataPath)).catch(() => []);
  return entries
    .filter((name) => name.endsWith('.png') && ID_PATTERN.test(name.slice(0, -4)))
    .map((name) => name.slice(0, -4))
    .sort();
}

/** Deleting art that is not there is success: the caller wanted it gone. */
export async function removeCustomAppIcon(input: {
  readonly id: string;
  readonly userDataPath: string;
}): Promise<void> {
  await rm(resolveCustomAppIconPath(input.userDataPath, input.id), { force: true });
}
