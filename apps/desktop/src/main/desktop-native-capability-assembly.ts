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

import { app, nativeImage, powerMonitor, screen } from 'electron';
import { createComputerUseOverlayHook } from '@maka/computer-use';
import { buildBrowserTools } from './browser/browser-tools.js';
import {
  createComputerUseHost,
  createDesktopPhysicalInputGuard,
} from './computer-use-host.js';
import { createCursorOverlayController } from './computer-use/cursor-overlay-window.js';
import {
  createComputerUsePipController,
  withComputerUsePip,
} from './computer-use/pip-window.js';
import {
  createComputerUseStatusItem,
  withComputerUseStatusItem,
} from './computer-use/status-item.js';
import {
  createComputerUseScreenLockGuard,
  withComputerUseScreenLock,
} from './computer-use/screen-lock.js';
import {
  applyComputerUseRealModelPolicy,
  parseComputerUseRealModelPolicy,
} from './computer-use-real-model-policy.js';
import type { DesktopLocaleAuthority } from './desktop-locale-authority.js';

const COMPUTER_USE_WAKE_HOLD = 'computer-use';

export interface DesktopNativeCapabilityAssemblyDeps {
  readonly isComputerUseRealModelE2e: boolean;
  readonly locale: Pick<DesktopLocaleAuthority, 'current' | 'subscribe'>;
  readonly keepSystemAwake?: { hold(reason: string): void; release(reason: string): void };
  readonly mainWindow?: {
    windowBounds(): { x: number; y: number; width: number; height: number } | undefined;
    onWindowGeometryChanged(cb: () => void): () => void;
    browserWindow(): { isDestroyed(): boolean } | undefined;
  };
}

/** Assemble the Desktop-owned capabilities that a Host may call. */
export function assembleDesktopNativeCapabilities(
  deps: DesktopNativeCapabilityAssemblyDeps,
) {
  const browserTools = buildBrowserTools();
  const computerUseOverlay = createCursorOverlayController();
  const computerUsePip = createComputerUsePipController(
    deps.mainWindow
      ? {
          resolveAnchorRect: () => deps.mainWindow?.windowBounds(),
          subscribeAnchorChanges: (cb) => deps.mainWindow?.onWindowGeometryChanged(cb) ?? (() => {}),
          resolveParentWindow: () => deps.mainWindow?.browserWindow(),
          cursorPoint: () => screen.getCursorScreenPoint(),
          workAreaFor: (rect) => screen.getDisplayMatching(rect).workArea,
        }
      : {},
  );

  const computerUseStatusItem = createComputerUseStatusItem({
    resolveLocale: () => deps.locale.current(),
    subscribeLocaleChanges: (listener) => deps.locale.subscribe(listener),
    onLiveChanged: (live) => {
      if (live) deps.keepSystemAwake?.hold(COMPUTER_USE_WAKE_HOLD);
      else deps.keepSystemAwake?.release(COMPUTER_USE_WAKE_HOLD);
    },
  });
  const computerUseScreenLock = createComputerUseScreenLockGuard();
  const computerUseHost = createComputerUseHost({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    compressFrame: (base64) => {
      try {
        const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
        return image.isEmpty()
          ? { base64, mimeType: 'image/png' }
          : {
              base64: image.toJPEG(82).toString('base64'),
              mimeType: 'image/jpeg',
            };
      } catch {
        return { base64, mimeType: 'image/png' };
      }
    },
    physicalInputRecentlyActive: createDesktopPhysicalInputGuard(
      () => powerMonitor.getSystemIdleTime(),
    ),
    screenLocked: ({ sessionId }) => {
      if (!computerUseScreenLock.locked()) return false;
      computerUseScreenLock.noteSessionActive(sessionId);
      return true;
    },
    ...(deps.isComputerUseRealModelE2e
      ? {
          onTrace: (event) => {
            const tracePath = process.env.MAKA_CU_REAL_MODEL_TRACE;
            if (!tracePath) return;
            void import('node:fs/promises')
              .then(({ appendFile }) =>
                appendFile(tracePath, `${JSON.stringify(event)}\n`, {
                  encoding: 'utf8',
                  mode: 0o600,
                }),
              )
              .catch(() => undefined);
          },
        }
      : {}),
    overlay: withComputerUseStatusItem(
      withComputerUseScreenLock(
        withComputerUsePip(createComputerUseOverlayHook(computerUseOverlay), computerUsePip),
        computerUseScreenLock,
      ),
      computerUseStatusItem,
    ),
  });
  const computerUse = computerUseHost.selected;
  computerUseScreenLock.setSessionEvents(computerUse.tools.sessionEvents);
  const computerUseTools = applyComputerUseRealModelPolicy(
    computerUse.tools,
    deps.isComputerUseRealModelE2e
      ? parseComputerUseRealModelPolicy(process.env.MAKA_CU_REAL_MODEL_POLICY)
      : undefined,
  );

  return {
    browserTools,
    computerUse,
    computerUseOverlay,
    computerUsePip,
    computerUseStatusItem,
    computerUseScreenLock,
    computerUseTools,
  };
}
