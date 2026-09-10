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

import { app, BrowserWindow, nativeImage } from 'electron';
import { join } from 'node:path';
import {
  APP_ICONS,
  CUSTOM_APP_ICON_PREFIX,
  customAppIconId,
  toAppIconChoice,
  type AppIcon,
  type AppIconChoice,
} from '@maka/core/settings';
import {
  customAppIconDirectory,
  listCustomAppIconIds,
  resolveCustomAppIconPath,
} from './custom-app-icon-store.js';
import {
  appIconLoadOrder,
  encodeWindowsIco,
  firstReadableAppIconPath,
  resolveAppIconPath,
  WINDOWS_TASKBAR_ICON_SIZES,
} from './app-icon.js';
import { writeWindowsTaskbarIconCache } from './app-icon-cache.js';
import { desktopAssetRoot } from './desktop-assets.js';

/**
 * One choice's artwork path — shipped art under the asset root, imported art
 * under the directory the app owns. Never throws: a malformed id can only come
 * from a settings file that dodged normalization, and a window being created
 * is no place to raise. The brand mark is the answer to every such question.
 */
export function appIconPath(value: unknown): string {
  // Never a bare cast: an unchecked id is a path fragment, and `../../` in one
  // would resolve outside the directories this app owns and be handed to
  // Electron's native decoder.
  const choice = toAppIconChoice(value);
  const custom = customAppIconId(choice);
  if (custom === undefined) return resolveAppIconPath(currentAssetRoot(), choice as AppIcon);
  try {
    return resolveCustomAppIconPath(app.getPath('userData'), custom);
  } catch {
    return resolveAppIconPath(currentAssetRoot(), 'default');
  }
}

/**
 * The path a window's icon surface should be set from, or `null` when no
 * artwork reads.
 *
 * On Windows this is the rebuilt multi-size ICO file (see
 * `windowsTaskbarIconFile`) because the taskbar needs the small/large HICON a
 * PNG NativeImage does not provide. macOS and Linux take the first 1024px PNG
 * master that actually reads.
 *
 * `null` is the answer a caller *replacing* an icon needs: `setIcon` with a
 * path that decodes to nothing blanks the icon a window already has, so
 * "nothing reads" has to be sayable rather than turned into a path.
 */
export function appIconSurfacePath(value: unknown): string | null {
  const icon = toAppIconChoice(value);
  if (process.platform === 'win32') {
    const icoPath = windowsTaskbarIconFile(icon);
    if (icoPath !== null) return icoPath;
  }
  return firstReadableAppIconPath(icon, appIconPath, readsAsArtwork) ?? null;
}

/**
 * The path a window should be born with: the same fallback `applyAppIcon`
 * walks, so a window created after the artwork went missing gets the brand
 * mark rather than a path that decodes to nothing.
 *
 * The `string` form of `appIconSurfacePath`, for the callers that have to name
 * a path: a window being created cannot report an error.
 */
export function readableAppIconPath(value: unknown): string {
  return appIconSurfacePath(value) ?? appIconPath('default');
}

/** `nativeImage` reports a missing or undecodable file as an EMPTY image. */
function readsAsArtwork(path: string): boolean {
  return !nativeImage.createFromPath(path).isEmpty();
}

/**
 * The Windows taskbar icon, as the `.ico` file path Electron wants.
 *
 * `BrowserWindow`'s `icon` option and `setIcon` take either a NativeImage or
 * a file path, and on Windows a path to an `.ico` is what reaches the small
 * and large HICONs `WM_SETICON` asks for. A NativeImage built from the 1024px
 * PNG master does not: Chromium keeps the packaged `.exe` tile, so the picker
 * and the taskbar disagree.
 *
 * The rebuilt ICO cannot be handed to Windows as bytes either — `nativeImage`
 * only decodes PNG/JPG, so `createFromBuffer` of an ICO returns an EMPTY
 * image. So the artwork is written to the app-owned cache and its path is
 * returned. Every failure — unreadable art, an encode or write error — returns
 * null so the caller falls back to the PNG master rather than to a path that
 * decodes to nothing.
 */
export function windowsTaskbarIconFile(value: unknown): string | null {
  const image = loadAppIcon(toAppIconChoice(value));
  if (!image) return null;
  const frames = WINDOWS_TASKBAR_ICON_SIZES.flatMap((size) => {
    const png = image.resize({ width: size, height: size, quality: 'better' }).toPNG();
    return png.byteLength > 0 ? [{ size, png: Buffer.from(png) }] : [];
  });
  if (frames.length === 0) return null;
  return writeWindowsTaskbarIconCache(app.getPath('userData'), encodeWindowsIco(frames));
}

/**
 * Where this process reads icon artwork from. Exported so the window `icon`
 * option resolves the same root the dock does — one of them guessing wrong
 * would ship a build whose windows and dock disagree.
 */
export function currentAssetRoot(): string {
  return desktopAssetRoot({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
}

/** Edge length of the picker thumbnails handed to the renderer. */
const PREVIEW_SIZE = 128;

export interface AppIconPreview {
  readonly id: AppIconChoice;
  /** Imported art can be deleted; the shipped set cannot. */
  readonly removable?: boolean;
  /** PNG data URL, sized for the Settings picker tile. */
  readonly dataUrl: string;
}

let shippedPreviews: readonly AppIconPreview[] | undefined;

/**
 * Point the OS at one of the shipped icons.
 *
 * macOS draws one tile for the whole app, so the dock owns the icon there and
 * per-window icons are ignored. Windows and Linux draw it per window instead,
 * which is why every open window is updated: the `icon` option in
 * `createWindow` only covers windows opened *after* the choice was persisted.
 *
 * Windows is handed a path to the rebuilt `.ico` (see `appIconSurfacePath`):
 * a PNG NativeImage leaves the taskbar on the packaged `.exe` tile.
 *
 * Nothing readable means nothing is set. `setIcon` with a path that decodes to
 * nothing blanks the icon the window already has, so a missing set of artwork
 * has to leave the running icon alone and say so instead.
 */
export function applyAppIcon(value: unknown, onIconError: (error: unknown) => void): void {
  const icon = toAppIconChoice(value);
  try {
    if (app.dock) {
      const image = loadAppIcon(icon);
      if (!image) {
        onIconError(new Error(`no readable artwork for app icon "${icon}"`));
        return;
      }
      app.dock.setIcon(image);
      return;
    }
    const surface = appIconSurfacePath(icon);
    if (surface === null) {
      onIconError(new Error(`no readable artwork for app icon "${icon}"`));
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(surface);
  } catch (error) {
    onIconError(error);
  }
}

/**
 * Thumbnails for the Settings picker. The renderer never learns a path — it
 * asks for the set and gets ids plus artwork — so the icon files stay outside
 * the renderer bundle (they are 1024px masters) and outside its reach.
 *
 * Computed once: the artwork ships with the build and cannot change while the
 * app runs, and decoding a 1024px PNG per picker visit is pure waste.
 */
export async function listAppIconPreviews(): Promise<readonly AppIconPreview[]> {
  if (!shippedPreviews) {
    const built: AppIconPreview[] = [];
    for (const id of APP_ICONS) {
      const image = loadAppIcon(id);
      if (image) built.push({ id, dataUrl: thumbnail(image) });
    }
    shippedPreviews = built;
  }

  // Imported art is read fresh: unlike the shipped set it changes while the
  // app runs, and it is NOT loaded through the fallback chain — art that has
  // gone missing must drop out of the picker rather than list a second copy
  // of the brand mark under someone's imported id.
  const imported: AppIconPreview[] = [];
  for (const id of await listCustomAppIconIds(app.getPath('userData'))) {
    const image = nativeImage.createFromPath(
      join(customAppIconDirectory(app.getPath('userData')), `${id}.png`),
    );
    if (image.isEmpty()) continue;
    imported.push({
      id: `${CUSTOM_APP_ICON_PREFIX}${id}` as AppIconChoice,
      dataUrl: thumbnail(image),
      removable: true,
    });
  }
  return [...shippedPreviews, ...imported];
}

function thumbnail(image: Electron.NativeImage): string {
  return image
    .resize({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, quality: 'better' })
    .toDataURL();
}

/**
 * `nativeImage.createFromPath` reports a missing or undecodable file as an
 * EMPTY image rather than throwing, and handing an empty image to `setIcon`
 * blanks the dock tile instead of leaving the previous one alone. So emptiness
 * is the read failure, and it is what advances the fallback chain.
 */
function loadAppIcon(icon: AppIconChoice): Electron.NativeImage | undefined {
  for (const candidate of appIconLoadOrder(icon)) {
    const image = nativeImage.createFromPath(appIconPath(candidate));
    if (!image.isEmpty()) return image;
  }
  return undefined;
}
