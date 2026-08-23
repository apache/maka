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

import { join } from 'node:path';
import type { AppIcon, AppIconChoice } from '@maka/core/settings';

/**
 * Where one icon choice's artwork lives, relative to `apps/desktop`.
 *
 * `default` deliberately keeps pointing at the long-standing
 * `assets/icon.png` instead of moving under `assets/app-icons/`: that path is
 * also what the packaging config and the window `icon` option name, so moving
 * it to make the set look tidy would be a rename with no product value.
 */
export function appIconAssetSegments(icon: AppIcon): readonly string[] {
  return icon === 'default' ? ['assets', 'icon.png'] : ['assets', 'app-icons', `${icon}.png`];
}

export function resolveAppIconPath(desktopRoot: string, icon: AppIcon): string {
  return join(desktopRoot, ...appIconAssetSegments(icon));
}

/**
 * Which artwork to try, in order, for one choice. A build whose optional
 * artwork is missing — a packaging filter that dropped `assets/app-icons/`,
 * a partially applied update — falls back to the brand mark rather than to
 * the OS placeholder, which on macOS is the generic Electron rocket.
 */
export function appIconLoadOrder(icon: AppIconChoice): readonly AppIconChoice[] {
  return icon === 'default' ? ['default'] : [icon, 'default'];
}

/**
 * First path in the fallback order whose artwork actually reads.
 *
 * A path being well-formed says nothing about the file existing: a persisted
 * custom id whose file was deleted resolves to a perfectly valid path that
 * decodes to nothing. Windows and Linux hand that path straight to a new
 * window, so window creation has to walk the same fallback the dock does
 * instead of trusting the first candidate.
 */
export function pickReadableAppIconPath(
  icon: AppIconChoice,
  toPath: (choice: AppIconChoice) => string,
  isReadable: (path: string) => boolean,
): string {
  for (const candidate of appIconLoadOrder(icon)) {
    const path = toPath(candidate);
    if (isReadable(path)) return path;
  }
  return toPath('default');
}
