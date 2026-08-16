/**
 * Electron binding for the drag-to-grant overlay.
 *
 * The lifecycle lives in `permission-overlay-controller.ts` (pure and
 * tested); this module is the thin layer that gives it a real window, a
 * real cursor, and the real TCC reads — plus the IPC surface.
 *
 * Four window options are load-bearing together, and dropping any one
 * breaks the gesture rather than merely looking worse:
 *
 *   focusable: false        the card never takes key focus
 *   type: 'panel'           NSPanel — does not claim the frontmost app slot
 *   alwaysOnTop 'screen-saver'   floats above System Settings
 *   showInactive()          shown without activating our app
 *
 * If the card steals focus, System Settings stops being the key window and
 * drops its drop-target highlight mid-drag — the user is left dragging
 * into a window that no longer looks like it will accept anything.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UiLocale } from '@maka/core/ui-locale';
import { resolveOverlayAssetDir } from '../overlay-assets.js';
import { openSystemPermissionPane, requestPermissionAccess } from '../permissions-actions.js';
import { loadNativeBundleIcon, resolveAppBundle } from './app-bundle.js';
import { getPermissionOverlayCopy } from './permission-overlay-copy.js';
import {
  createPermissionOverlayController,
  startScreenRecordingOnboarding,
  type DragGrantPermissionId,
  type PermissionOverlayController,
  type PermissionOverlayWindowLike,
} from './permission-overlay-controller.js';

const requireElectron = createRequire(import.meta.url);
/**
 * Card geometry, in DIP: a wide, short bar rather than a dialog.
 *
 * 530x109 matches the reference implementation, and the proportion is the
 * point — the card has to sit over the width of the System Settings
 * content pane and read as belonging to the list it is pointing at. A
 * squarer card reads as a floating dialog that happens to be nearby.
 */
const CARD = { width: 530, height: 109 };

type Electron = typeof import('electron');

export interface PermissionOverlayMainDeps {
  /**
   * Resolved UI locale, so the card speaks the same language as the app.
   * Async because it comes from the settings store; the controller needs
   * it synchronously when the page loads, so `start()` refreshes a cached
   * value first (see the wrapper at the bottom of this factory).
   */
  resolveLocale(): Promise<UiLocale>;
}

export function createPermissionOverlayMain(
  deps: PermissionOverlayMainDeps,
): PermissionOverlayController {
  const overlayAssetDir = resolveOverlayAssetDir(import.meta.url);
  let locale: UiLocale = 'en';
  let iconDataUrl: string | null = null;
  const electron = requireElectron('electron') as Electron;
  const { BrowserWindow, app, screen, systemPreferences } = electron;

  function isGranted(id: DragGrantPermissionId): boolean {
    if (process.platform !== 'darwin') return false;
    // The non-prompting read: passing `true` would pop the system dialog
    // on every poll tick.
    if (id === 'accessibility') return systemPreferences.isTrustedAccessibilityClient(false);
    return systemPreferences.getMediaAccessStatus('screen') === 'granted';
  }

  async function resolveAppIconDataUrl(bundlePath: string | null): Promise<string | null> {
    if (!bundlePath) return null;
    const icon = await loadNativeBundleIcon(app.isPackaged, () =>
      app.getFileIcon(bundlePath, { size: 'large' }),
    );
    if (!icon || icon.isEmpty()) return null;
    // nativeImage.createFromPath does not decode .icns reliably. Asking
    // macOS for the bundle icon returns the same image Finder and the TCC
    // list display for packaged Maka builds.
    return icon.resize({ width: 64, height: 64 }).toDataURL();
  }

  const controller = createPermissionOverlayController({
    platform: process.platform,
    cardSize: CARD,
    getAnchor: () => {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      return { x: point.x, y: point.y, workArea: display.workArea };
    },
    openSystemSettings: async (id) => {
      const result = await openSystemPermissionPane(id);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
    isGranted,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    buildCardPayload: (id) => {
      const bundle = resolveAppBundle({
        executablePath: app.getPath('exe'),
        platform: process.platform,
        exists: existsSync,
      });
      const bundlePath = bundle.ok ? bundle.bundlePath : null;
      return {
        permission: id,
        appName: app.getName(),
        iconDataUrl,
        draggable: bundlePath !== null,
        copy: serializeCopy(locale, id, app.getName()),
      };
    },
    log: (message) => console.warn(message),
    createWindow: (bounds) => {
      const win = new BrowserWindow({
        ...bounds,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: true,
        roundedCorners: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // See the header: these two plus showInactive() are what keep
        // System Settings the key window during the drag.
        focusable: false,
        type: process.platform === 'darwin' ? 'panel' : undefined,
        webPreferences: {
          preload: join(overlayAssetDir, 'permission-overlay-preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          // Matches the cursor overlay. The preload only needs
          // contextBridge + ipcRenderer, both of which work sandboxed —
          // there is nothing here worth weakening the sandbox for.
          sandbox: true,
        },
      });
      // The card's three gestures are bound to THIS window's webContents,
      // not to global ipcMain. A global `ipcMain.on` would let any
      // renderer in the app trigger a native drag of the .app bundle or
      // pop Finder; scoping them means only the overlay page can, which
      // is the same containment the cursor overlay uses.
      attachCardGestures(win);
      win.setAlwaysOnTop(true, 'screen-saver');
      // Survives Space switches and Settings going fullscreen; without it
      // the card is hidden with our other windows when Settings activates.
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      void win.loadFile(join(overlayAssetDir, 'permission-overlay.html'));

      const like: PermissionOverlayWindowLike = {
        setBounds: (next) => { if (!win.isDestroyed()) win.setBounds(next); },
        showInactive: () => { if (!win.isDestroyed()) win.showInactive(); },
        isDestroyed: () => win.isDestroyed(),
        destroy: () => { if (!win.isDestroyed()) win.destroy(); },
        send: (channel, payload) => { if (!win.isDestroyed()) win.webContents.send(channel, payload); },
        onReady: (cb) => { win.webContents.once('did-finish-load', cb); },
        onGone: (cb) => {
          win.once('closed', cb);
          win.webContents.once('render-process-gone', cb);
        },
      };
      return like;
    },
  });

  // Refresh the locale before each run so a language change between the
  // app starting and the card opening is reflected. Failing to read it is
  // not a reason to block the flow — the last known value still renders.
  return {
    ...controller,
    async start(id: unknown) {
      try {
        locale = await deps.resolveLocale();
      } catch (error) {
        console.warn('[permission-overlay] locale lookup failed, keeping', locale, error);
      }
      const bundle = resolveAppBundle({
        executablePath: app.getPath('exe'),
        platform: process.platform,
        exists: existsSync,
      });
      iconDataUrl = await resolveAppIconDataUrl(bundle.ok ? bundle.bundlePath : null);
      return controller.start(id);
    },
  };
}

function serializeCopy(locale: UiLocale, id: DragGrantPermissionId, appName: string) {
  const copy = getPermissionOverlayCopy(locale, id);
  return {
    headline: copy.headline(appName),
    fallback: copy.fallback,
    granted: copy.granted,
    dismiss: copy.dismiss,
    dragHint: copy.dragHint,
    restartHint: copy.restartHint ?? null,
    noBundle: copy.noBundle,
  };
}

/**
 * Bind the card's gestures to one window.
 *
 * Deliberately `webContents.on('ipc-message')` rather than global
 * `ipcMain.on`: these three channels start a native drag of the app
 * bundle, close the card, and pop Finder. On global ipcMain any renderer
 * in the app could reach them; scoped here, only the overlay page can.
 * Same containment the cursor overlay uses, and the listeners die with
 * the window rather than accumulating one set per card opened.
 */
function attachCardGestures(win: import('electron').BrowserWindow): void {
  const electron = requireElectron('electron') as Electron;
  const { app, nativeImage, shell } = electron;

  const bundle = (): ReturnType<typeof resolveAppBundle> =>
    resolveAppBundle({
      executablePath: app.getPath('exe'),
      platform: process.platform,
      exists: existsSync,
    });

  win.webContents.on('ipc-message', async (_event, channel, payload: unknown) => {
    if (channel === 'permission-overlay:dismiss') {
      if (!win.isDestroyed()) win.close();
      return;
    }

    if (channel === 'permission-overlay:reveal-bundle') {
      // Dev-mode / unpacked fallback: if we cannot hand the bundle over by
      // drag, at least put the user in front of it in Finder instead of
      // leaving the gesture silently dead.
      const resolved = bundle();
      shell.showItemInFolder(resolved.ok ? resolved.bundlePath : resolved.executablePath);
      return;
    }

    if (channel !== 'permission-overlay:start-drag') return;
    if (process.platform !== 'darwin') return;

    // `webContents.startDrag` is the only way to hand a file to *another*
    // process: it writes a `kUTTypeFileURL` onto NSPasteboard, which is
    // what makes the drop legible to System Settings. An HTML5 dragstart
    // stays inside our process and System Settings never sees it.
    //
    // The path is resolved HERE, never taken from the payload — the card
    // may choose the drag image and nothing else.
    const resolved = bundle();
    if (!resolved.ok) {
      console.warn(`[permission-overlay] no .app bundle to drag (exe: ${resolved.executablePath})`);
      return;
    }

    const iconDataUrl =
      payload && typeof payload === 'object' && 'iconDataUrl' in payload
        ? (payload as { iconDataUrl?: unknown }).iconDataUrl
        : null;
    let icon = nativeImage.createEmpty();
    if (typeof iconDataUrl === 'string' && iconDataUrl.startsWith('data:image/')) {
      const fromRenderer = nativeImage.createFromDataURL(iconDataUrl);
      if (!fromRenderer.isEmpty()) icon = fromRenderer;
    }
    if (icon.isEmpty()) {
      const fallback = await loadNativeBundleIcon(app.isPackaged, () =>
        app.getFileIcon(resolved.bundlePath, { size: 'large' }),
      );
      if (fallback && !fallback.isEmpty()) icon = fallback.resize({ width: 64, height: 64 });
      // The file drag still works without a decorative drag image.
    }

    if (!win.isDestroyed()) win.webContents.startDrag({ file: resolved.bundlePath, icon });
  });
}

export interface PermissionOverlayIpcDeps {
  controller: PermissionOverlayController;
  ipcMain: Pick<typeof import('electron').ipcMain, 'handle'>;
}

/**
 * The renderer-facing surface: one invoke channel. The card's own
 * gestures are bound per-window in `attachCardGestures`, and the card
 * closes itself (its × button, the grant, or the give-up timeout), so
 * the app never needs to reach in and dismiss it.
 */
export function registerPermissionOverlayIpc(deps: PermissionOverlayIpcDeps): void {
  const electron = requireElectron('electron') as Electron;
  const { systemPreferences } = electron;

  deps.ipcMain.handle('permissions:startDragOnboarding', async (_event, id: unknown) => {
    if (id === 'screen_recording') {
      return startScreenRecordingOnboarding({
        requestAccess: () => requestPermissionAccess(id),
        isGranted: () => systemPreferences.getMediaAccessStatus('screen') === 'granted',
        // A real capture request engages TCC, but macOS may still require the
        // bundle in System Settings. Preserve the drag-card second half.
        startDrag: () => deps.controller.start(id),
      });
    }
    return deps.controller.start(id);
  });
}
