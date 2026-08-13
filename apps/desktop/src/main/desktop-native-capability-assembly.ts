import { app, nativeImage, powerMonitor, screen } from 'electron';
import { resolveSystemUiLocale, resolveUiLocale } from '@maka/core/ui-locale';
import type { AppSettings } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
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

const COMPUTER_USE_WAKE_HOLD = 'computer-use';

export interface DesktopNativeCapabilityAssemblyDeps {
  readonly isComputerUseRealModelE2e: boolean;
  readonly settings: { get(): Promise<AppSettings> };
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

  let uiLocale: UiLocale | undefined;
  const resolveComputerUseLocale = (): UiLocale => {
    const system = resolveSystemUiLocale(app.getPreferredSystemLanguages());
    void deps.settings
      .get()
      .then((settings) => {
        uiLocale = resolveUiLocale(settings.personalization.uiLocale, system);
      })
      .catch(() => undefined);
    return uiLocale ?? system;
  };
  const computerUseStatusItem = createComputerUseStatusItem({
    resolveLocale: resolveComputerUseLocale,
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
