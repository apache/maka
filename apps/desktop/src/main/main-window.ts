import { app, BrowserWindow, dialog, nativeTheme, screen, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppSettings } from '@maka/core/settings';
import { isExternalUrl } from './external-link-guard.js';
import { errorMessage } from './chat-readiness.js';
import { readSavedBounds, writeSavedBounds, SAFE_MIN_HEIGHT, SAFE_MIN_WIDTH, type SavedBounds } from './window-state.js';
import { BrowserViewController } from './browser/controller.js';
import { BrowserViewManager } from './browser/view-manager.js';
import type { E2eFixture } from './e2e-fixture.js';
import { installMainWindowPermissionPolicy } from './main-window-permission-policy.js';
import { isThemePreference, toNativeThemeSource } from './theme-source.js';
import { createWindowRevealGate } from './window-reveal.js';
import {
  parseDesktopSessionResourceKey,
  type DesktopHostRef,
} from '../preload/runtime-host-identity.js';

type SettingsReader = {
  get(): Promise<AppSettings>;
};

export interface MainWindowController {
  createWindow(signal: AbortSignal): Promise<void>;
  send(channel: string, ...args: unknown[]): void;
  // PR-SHOW-AFTER-FIRST-COMMIT: reveal the hidden window after the renderer's
  // first React commit. Idempotent + e2e-fixture-safe (see notifyRendererReady).
  notifyRendererReady(): void;
  setTitlebarControlsVisible(sender: Electron.WebContents, visible: unknown): void;
  setThemeSource(sender: Electron.WebContents, themePref: unknown): void;
  setTitleBarOverlayTheme(sender: Electron.WebContents, theme: unknown): void;
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  showSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue>;
  getBrowserViews(): BrowserViewManager<BrowserViewController>;
  disposeBrowserViews(): Promise<void>;
  hasOpenWindows(): boolean;
  focus(): void;
  /**
   * The app window's screen rect, for surfaces that position themselves
   * against it (the Computer Use mirror anchors to it and follows it, the way
   * Codex's PiP tiles anchor to the Codex window). Undefined when there is no
   * window.
   */
  windowBounds(): Electron.Rectangle | undefined;
  /**
   * The window itself, for surfaces that must become its child window rather
   * than merely position against it. macOS carries a child window with its
   * parent in one window-server transaction and orders it against the parent
   * instead of against the whole desktop, which is what the Computer Use mirror
   * needs and what no amount of repositioning from this side can imitate.
   */
  browserWindow(): BrowserWindow | undefined;
  /** Subscribe to app-window moves and resizes; returns an unsubscribe. */
  onWindowGeometryChanged(cb: () => void): () => void;
  /** Whether the main window currently holds OS focus. False when the
   * window is gone, minimized to the point of losing focus, or another
   * app is in front — used to gate "notify only while unfocused". */
  isFocused(): boolean;
}

interface MainWindowControllerDeps {
  workspaceRoot: string;
  e2eFixture: E2eFixture | null;
  settingsStore: SettingsReader;
  // main.ts computes this from the same isE2e gate that also guards userData
  // and the fake backend, so main-window.ts owns no env policy of its own.
  startHidden: boolean;
  getActiveRuntimeHostRef?: () => DesktopHostRef | undefined;
  onClose?: () => void;
}

let mainWindow: BrowserWindow | null = null;
let browserViews: BrowserViewManager<BrowserViewController> | undefined;

/**
 * Guarded `webContents.send` for `mainWindow`. The `mainWindow?.` optional
 * chain only covers a null reference — it does NOT catch the case where the
 * BrowserWindow has been destroyed (window closed, renderer crashed,
 * teardown raced) while the variable still points at the freed object.
 * Calling `.webContents.send` in that state throws `TypeError: Object has
 * been destroyed`, surfacing as a main-process JS-error dialog.
 *
 * Use this helper anywhere a timer / IPC / menu accelerator might race
 * window teardown. No-op when the window is gone — callers that need
 * delivery confirmation should observe their own state.
 */
export function safeSendToRenderer(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;
  wc.send(channel, ...args);
}

// The close button's centre sits on the same vertical line as the sidebar's
// icon column, so the window's top-left reads as one column rather than two
// near-misses. Contract: centre = x + 7 (the disc measures 14pt, not the 12pt
// it is often quoted as), and the icon column centres on 24 (item edge 8 +
// half of the 32pt icon slot) — so x = 24 - 7 = 17. Both numbers were read off
// a screenshot of the running window, not derived. Move the sidebar's left
// padding or icon slot and this has to move with it.
const MAIN_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 17, y: 14 } as const;
const HIDDEN_TRAFFIC_LIGHT_POSITION = { x: -100, y: -100 } as const;

// PR-SHOW-AFTER-FIRST-COMMIT: fallback reveal delay for a renderer that never
// signals its first painted frame (window:notifyRendererReady). main.tsx's
// onboarding prefetch bails at 2500ms; the remainder is headroom for React +
// first paint. The timer is armed only after loadURL/loadFile resolves, so
// Vite compilation and document loading do not consume this budget, while a
// wedged renderer still cannot leave the window invisible forever.
const SHOW_FALLBACK_TIMEOUT_MS = 4000;

// PR-WINDOW-TITLEBAR-0: the titleBarOverlay height matches the renderer
// `--h-titlebar: 36px` token so the native control strip and the in-app top
// chrome share a baseline; `app-region-hygiene-contract.test.ts` fails if the
// two numbers drift. The overlay color/symbolColor are reused both at window
// creation (to avoid a first-frame flash against the window `backgroundColor`)
// and on runtime mode/palette changes via `setTitleBarOverlayTheme` — Windows
// only, which is why macOS passes the height alone.
const TITLEBAR_OVERLAY_HEIGHT = 36;
const titleBarOverlayOptions = (
  isDark: boolean,
  color = isDark ? '#1c1d21' : '#ffffff',
): { color: string; symbolColor: string; height: number } => ({
  // The light overlay color must match the renderer's `--background`
  // (maka-tokens.css :root, oklch(1 0 0) == #ffffff) so the top-right
  // action buttons sit on the same surface as the OS-drawn window control
  // strip — otherwise a visible color seam splits the titlebar. The dark
  // value mirrors the dark-mode `--background` anchor.
  color,
  symbolColor: isDark ? '#e6e6e8' : '#1c1d21',
  height: TITLEBAR_OVERLAY_HEIGHT,
});

export function createMainWindowController(deps: MainWindowControllerDeps): MainWindowController {
  const { workspaceRoot, e2eFixture, settingsStore, startHidden } = deps;

  // PR-SHOW-AFTER-FIRST-COMMIT: windows launched hidden (startHidden covers
  // e2e-fixture capture and E2E — see main.ts) must never be revealed;
  // e2e-fixture captures run on the hidden window and E2E drives it headless.
  // `!app.isPackaged` mirrors the original creation-time gate so a packaged
  // build ignores a stray startHidden flag. The fallback timer, the
  // renderer-ready IPC, and focus() all route their show() through this
  // predicate via the reveal gate below.
  const keepHiddenForE2eFixture = !app.isPackaged && startHidden;
  // ChatGPT Pro review P2: focus() (second-instance / activate) used to call
  // mainWindow.show() directly, bypassing the reveal gate — re-launching or
  // clicking the dock icon during the pre-commit window would flash the
  // skeleton anyway. The gate defers those focus requests until markReady.
  const revealGate = createWindowRevealGate(keepHiddenForE2eFixture);
  let showFallbackTimer: NodeJS.Timeout | undefined;
  const clearShowFallbackTimer = (): void => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = undefined;
    }
  };

  function getBrowserViews(): BrowserViewManager<BrowserViewController> {
    if (!browserViews) {
      browserViews = new BrowserViewManager<BrowserViewController>({
        create: (sessionId) => {
          if (!mainWindow) throw new Error('Embedded browser used before the window is ready.');
          return new BrowserViewController(mainWindow, sessionId, (sid, state) => {
            const ref = parseDesktopSessionResourceKey(sid);
            safeSendToRenderer(
              'browser:state',
              { hostId: ref.hostId, targetEpoch: ref.targetEpoch },
              { sessionId: ref.sessionId, state },
            );
          });
        },
        onLiveChange: (sessionIds) => {
          const activeHost = deps.getActiveRuntimeHostRef?.();
          if (!activeHost) return;
          const activeSessionIds = sessionIds.flatMap((sessionId) => {
            const ref = parseDesktopSessionResourceKey(sessionId);
            return ref.hostId === activeHost.hostId &&
              ref.targetEpoch === activeHost.targetEpoch
              ? [ref.sessionId]
              : [];
          });
          safeSendToRenderer('browser:live', activeHost, { sessionIds: activeSessionIds });
        },
      });
    }
    return browserViews;
  }

  async function disposeBrowserViews(): Promise<void> {
    await browserViews?.disposeAll();
  }

  async function createWindow(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await mkdir(workspaceRoot, { recursive: true });
    // Restore previously-saved bounds when available; first launch and
    // legacy installs both fall back to the default 1240x820 frame. After
    // load, validate the saved x/y against the current display layout — if
    // the previous external monitor is gone, drop x/y so Electron centers
    // the window on the primary display instead of opening it off-screen.
    const defaults = e2eFixtureWindowBounds(e2eFixture, { width: 1240, height: 820 });
    const savedBounds = e2eFixture
      ? defaults
      : await readSavedBounds(workspaceRoot, defaults);
    const bounds = clampBoundsToVisibleDisplay(savedBounds);

    // @kenji PR103 follow-up: complete the FOUC fix at the window-chrome layer.
    // The renderer applies `.dark` synchronously before React mounts (PR103),
    // but the BrowserWindow's `backgroundColor` shows during the first frame
    // before the renderer paints. Pick the right initial bg by reading the
    // persisted theme + system preference.
    // PR-IR-01b: e2e-fixture theme override wins over the persisted user
    // pref. This guarantees the BrowserWindow backgroundColor matches the
    // theme variant we're about to screenshot, so the very first frame
    // doesn't capture a light-on-dark or dark-on-light flash.
    const persistedTheme = (await settingsStore.get()).appearance?.theme ?? 'auto';
    // Quit cleanup permanently closes process-scoped stores. Re-check after
    // asynchronous preparation so an in-flight request cannot attach a new
    // renderer to resources that teardown has already started closing.
    if (signal.aborted) return;
    const themePref = e2eFixture?.theme ?? persistedTheme;
    const isDark =
      themePref === 'dark' ||
      (themePref === 'auto' && nativeTheme.shouldUseDarkColors);
    const initialBg = isDark ? '#1c1d21' : '#ffffff';
    // Astro-Han review (#493): sync nativeTheme here too, not only via the
    // renderer's later setThemeSource() IPC call -- otherwise the vibrancy
    // material behind the sidebar can still flash the *system* theme's tint
    // for the first frame or two on a cold start where the OS appearance
    // disagrees with the persisted in-app preference.
    nativeTheme.themeSource = toNativeThemeSource(themePref);

    const rendererEntryPath = join(
      import.meta.dirname,
      '..',
      '..',
      'dist-renderer',
      'index.html',
    );
    const rendererEntryUrl = process.env.VITE_DEV_SERVER_URL
      ?? pathToFileURL(rendererEntryPath).href;

    // Re-arm the reveal gate for this window's lifecycle (macOS keeps the app
    // alive after close-all; the next createWindow starts hidden again and a
    // stale ready/pending-focus state must not reveal it early).
    revealGate.reset();
    mainWindow = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      title: 'Maka',
      // PR-GRAY-CARD-LIFT-0 (WAWQAQ msg `0eb99429` 2026-06-20): the
      // app icon ships as a 1024px PNG under apps/desktop/assets/icon.png.
      // BrowserWindow accepts a PNG path directly on macOS for the dock
      // / window title bar; .icns / .ico packaging will come with the
      // installer build pass. The asset path resolves from the built
      // dist/main/main.js (two levels up to apps/desktop, then assets).
      icon: join(import.meta.dirname, '..', '..', 'assets', 'icon.png'),
      // PR-WINDOW-TITLEBAR-0: hide the native title bar so the renderer
      // chrome can extend to the top edge on every platform. macOS keeps
      // `hiddenInset` + traffic-light buttons (top-left); Windows uses
      // `hidden` + `titleBarOverlay` so the OS draws native min/max/close
      // buttons flush against the top-right corner. The overlay color is
      // seeded from the initial window background to avoid a first-frame
      // flash; `setTitleBarOverlayTheme` re-syncs it when the theme
      // changes at runtime. Linux falls back to the default frame (no
      // overlay support is wired up yet).
      //
      // `titleBarOverlay` on macOS is NOT about drawing an overlay — the OS
      // draws the traffic lights either way. It enables the Window Controls
      // Overlay CSS environment variables, which is how the renderer learns
      // where the native controls end instead of hard-coding a hand-measured
      // gutter. Measured on this Electron (43.1.1, macOS): without it,
      // `env(titlebar-area-x)` is unsupported and every fallback applies; with
      // `{ height }` it reports the traffic lights' safe-area edge (83px) and
      // keeps tracking window resizes. Only `height` is supported on macOS, so
      // the color pair stays on the Windows path. The object form matters: the
      // documented `titleBarOverlay: true` shorthand crashes this Electron on
      // macOS (ERR_FAILED on first load, then SIGTRAP).
      ...(process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: MAIN_WINDOW_TRAFFIC_LIGHT_POSITION,
            titleBarOverlay: { height: TITLEBAR_OVERLAY_HEIGHT },
          }
        : process.platform === 'win32'
          ? {
              titleBarStyle: 'hidden' as const,
              titleBarOverlay: titleBarOverlayOptions(isDark),
            }
          : {}),
      // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v5 (WAWQAQ msg `5b85fdb1`,
      // xuan `eea556cd`): explicit `resizable: true` so a future
      // patch can't silently disable window edge resize. Default is
      // already `true`, but pinning it here removes the ambiguity
      // and makes the intent obvious to reviewers; CSS-level fixes
      // (see `app-region-hygiene-contract.test.ts`) cover the
      // renderer side of the same gate.
      resizable: true,
      // #824: enforce the sanitizeBounds restore floor at runtime resize too,
      // so the both-present dvh layout fix can't be defeated by dragging the
      // window shorter than the 320px restore minimum. Shares SAFE_MIN_HEIGHT
      // with sanitizeBounds so the resize floor and the restore floor can't
      // drift apart (locked by app-region-hygiene-contract.test.ts).
      minHeight: SAFE_MIN_HEIGHT,
      backgroundColor: initialBg,
      // PR-SHOW-AFTER-FIRST-COMMIT: create hidden on every run so the OS never
      // flashes the index.html `.maka-preload` skeleton before React paints.
      // The renderer signals `window:notifyRendererReady` after its first
      // commit (app.tsx) and a fallback timer below reveals the window if that
      // signal never arrives; the reveal gate (showWindowOnceReady) keeps the
      // window hidden until the first real content can paint, so the app
      // never flashes the `.maka-preload` skeleton past it.
      show: false,
      // Native sidebar vibrancy lets the CSS-side sidebar render
      // transparent and inherit the system's blurred window material
      // (Big Sur+). Renderer CSS gates the transparency on
      // `[data-vibrancy="active"]` so non-macOS builds (where vibrancy is
      // a no-op) keep their opaque chrome.
      // Skip vibrancy under MAKA_E2E_FIXTURE — fixture / E2E
      // environments can't paint native window material reliably.
      ...(process.platform === 'darwin' && !process.env.MAKA_E2E_FIXTURE
        ? { vibrancy: 'sidebar' as const }
        : {}),
      webPreferences: {
        preload: join(import.meta.dirname, '..', 'preload', 'preload.cjs'),
        // Defense-in-depth flags (@kenji PR96 review). The external-link guard
        // is the perimeter; these settings keep a hostile page from reaching
        // Node primitives even if it somehow loaded inside the BrowserWindow:
        contextIsolation: true,    // window.maka via contextBridge only
        nodeIntegration: false,    // no `require` in renderer
        sandbox: true,             // preload runs in the renderer sandbox
        webSecurity: true,         // enforce CSP / same-origin policy
        allowRunningInsecureContent: false,
      },
    });
    installMainWindowPermissionPolicy(mainWindow.webContents, rendererEntryUrl);

    // Two-layer external-link hygiene: assistant markdown often emits `<a href>`
    // links to docs / GitHub / provider sign-up pages. Without these guards
    // clicking such a link would either replace the renderer view with the
    // remote page (breaking the app) or open a new BrowserWindow with full
    // Node integration.
    //
    // 1. `setWindowOpenHandler` intercepts `target="_blank"` and JS `window.open`,
    //    hands the URL to the OS, denies the in-app open.
    // 2. `will-navigate` blocks plain `<a>` clicks that would replace the
    //    renderer location with a non-file:// URL, opening externally instead.
    //
    // Both are gated on the URL using `http(s):` or `mailto:` — everything else
    // (file://, electron internal, etc.) is allowed/denied per Electron defaults.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      // The initial Vite dev-server / packaged file:// load is allowed through
      // (current URL equals navigation target while the renderer is settling).
      // Every subsequent navigation is blocked: external URLs (http/https/
      // mailto) get handed off to the OS, internal/file:// (including dropped
      // files attempting to navigate to `file:///…`) are dropped entirely so
      // the renderer never loses its React tree.
      const current = mainWindow?.webContents.getURL() ?? '';
      if (current === url) return;
      event.preventDefault();
      if (isExternalUrl(url)) {
        void shell.openExternal(url);
      }
    });

    // Block in-window file drops. Without this, dropping a file onto the
    // BrowserWindow tries to navigate to its `file://` URL; the `will-navigate`
    // handler above stops the navigation, but the visual flash + dropEffect
    // ambiguity is still confusing. Suppressing dragover/drop at the document
    // level keeps the chat surface immutable to accidental drops.
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.executeJavaScript(`
        (() => {
          const block = (e) => {
            const target = e.target instanceof Element ? e.target : e.target?.parentElement;
            if (target?.closest('[data-maka-file-drop-target="true"]')) return;
            e.preventDefault();
            e.stopPropagation();
          };
          window.addEventListener('dragover', block, true);
          window.addEventListener('drop', block, true);
        })();
      `).catch(() => { /* renderer may not be ready; ignore */ });
    });

    // Restore maximized state after construction (BrowserWindow constructor
    // doesn't accept it directly). ChatGPT Pro review P2 (round 2): a direct
    // maximize() here reveals the still-hidden window (verified on macOS),
    // bypassing the reveal gate — defer it so markReady applies it right
    // before the reveal and the first visible frame is already maximized.
    if (bounds.isMaximized) {
      revealGate.requestMaximize(mainWindow);
    }

    // Persist bounds across launches. Debounce so a continuous resize drag
    // doesn't write the file on every frame; flush on close.
    let saveTimer: NodeJS.Timeout | undefined;
    const scheduleSave = () => {
      if (!mainWindow) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!mainWindow) return;
        const next: SavedBounds = mainWindow.isMaximized()
          ? { ...mainWindow.getNormalBounds(), isMaximized: true }
          : { ...mainWindow.getBounds(), isMaximized: false };
        void writeSavedBounds(workspaceRoot, next);
      }, 400);
    };
    mainWindow.on('resize', scheduleSave);
    mainWindow.on('move', scheduleSave);
    mainWindow.on('maximize', scheduleSave);
    mainWindow.on('unmaximize', scheduleSave);
    mainWindow.on('close', () => {
      clearShowFallbackTimer();
      deps.onClose?.();
      if (saveTimer) clearTimeout(saveTimer);
      // The window owns the embedded-browser views (children of its contentView);
      // tear them down so their WebContents close with it instead of leaking.
      void browserViews?.disposeAll();
      if (!mainWindow) return;
      const final: SavedBounds = mainWindow.isMaximized()
        ? { ...mainWindow.getNormalBounds(), isMaximized: true }
        : { ...mainWindow.getBounds(), isMaximized: false };
      void writeSavedBounds(workspaceRoot, final);
    });

    if (process.env.VITE_DEV_SERVER_URL) {
      await mainWindow.loadURL(rendererEntryUrl);
    } else {
      await mainWindow.loadFile(rendererEntryPath);
    }

    // PR-SHOW-AFTER-FIRST-COMMIT: reveal fallback. Start this budget only once
    // the renderer document has loaded. Starting it before loadURL/loadFile
    // let a cold Vite transform or slow disk consume the whole timeout and
    // reveal index.html's preload skeleton before React had a chance to paint.
    // If renderer-ready arrived while loadURL/loadFile was resolving, the
    // window is already visible and no timer is needed. E2e-fixture windows
    // remain hidden for their whole lifecycle.
    if (!keepHiddenForE2eFixture && !mainWindow.isVisible()) {
      showFallbackTimer = setTimeout(() => {
        showFallbackTimer = undefined;
        revealGate.markReady(mainWindow);
      }, SHOW_FALLBACK_TIMEOUT_MS);
    }
    if (process.env.MAKA_REAL_WINDOW_SMOKE === '1') {
      emitRealWindowSmokeDiagnostic('after-load');
      setTimeout(() => emitRealWindowSmokeDiagnostic('settled-1000ms'), 1000);
    }
  }

  return {
    createWindow,
    send: safeSendToRenderer,
    notifyRendererReady() {
      // PR-SHOW-AFTER-FIRST-COMMIT: the renderer finished its first React
      // commit. Cancel the fallback timer and reveal the window through the
      // shared gate — idempotent, so an HMR reload re-firing this signal (or a
      // timer racing it) never re-shows or steals focus, and suppressed for
      // e2e-fixture windows. markReady also flushes a focus request that
      // arrived while the window was still hidden (second-instance/activate).
      clearShowFallbackTimer();
      revealGate.markReady(mainWindow);
    },
    setTitlebarControlsVisible(sender, visible) {
      const target = BrowserWindow.fromWebContents(sender);
      if (!target || target !== mainWindow || process.platform !== 'darwin') return;
      const shouldShow = visible === true;
      target.setWindowButtonVisibility(shouldShow);
      target.setWindowButtonPosition(
        shouldShow ? MAIN_WINDOW_TRAFFIC_LIGHT_POSITION : HIDDEN_TRAFFIC_LIGHT_POSITION,
      );
    },
    setThemeSource(sender, themePref) {
      const target = BrowserWindow.fromWebContents(sender);
      if (!target || target !== mainWindow) return;
      if (!isThemePreference(themePref)) return;
      nativeTheme.themeSource = toNativeThemeSource(themePref);
    },
    setTitleBarOverlayTheme(sender, theme) {
      const target = BrowserWindow.fromWebContents(sender);
      if (!target || target !== mainWindow || process.platform !== 'win32') return;
      if (!isTitleBarOverlayTheme(theme)) return;
      mainWindow.setTitleBarOverlay(titleBarOverlayOptions(theme.isDark, theme.backgroundColor));
    },
    showOpenDialog(options) {
      return mainWindow
        ? dialog.showOpenDialog(mainWindow, options)
        : dialog.showOpenDialog(options);
    },
    showSaveDialog(options) {
      return mainWindow
        ? dialog.showSaveDialog(mainWindow, options)
        : dialog.showSaveDialog(options);
    },
    getBrowserViews,
    disposeBrowserViews,
    hasOpenWindows() {
      return mainWindow !== null && !mainWindow.isDestroyed();
    },
    windowBounds() {
      return mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : undefined;
    },
    browserWindow() {
      return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    },
    onWindowGeometryChanged(cb: () => void) {
      const listeners: Array<() => void> = [];
      const attach = (): void => {
        const w = mainWindow;
        if (!w || w.isDestroyed()) return;
        // 'move' and 'resize' both fire continuously during a drag. Consumers
        // are expected to ignore the ones the window server already handled for
        // them — the Computer Use mirror is a child window, so it is carried
        // along by a move and only has to react to a resize.
        w.on('move', cb);
        w.on('resize', cb);
        listeners.push(() => {
          if (!w.isDestroyed()) {
            w.off('move', cb);
            w.off('resize', cb);
          }
        });
      };
      attach();
      return () => {
        for (const off of listeners) off();
        listeners.length = 0;
      };
    },
    focus() {
      // ChatGPT Pro review P2: second-instance / activate must not show() the
      // still-hidden window ahead of the renderer's first commit — that would
      // flash the `.maka-preload` skeleton past the reveal gate. The gate
      // defers the request and flushes it (restore+show+focus) on markReady;
      // after that, focus behaves exactly as before.
      revealGate.requestFocus(mainWindow);
    },
    isFocused() {
      return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
    },
  };
}

function isTitleBarOverlayTheme(value: unknown): value is { isDark: boolean; backgroundColor: string } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { isDark?: unknown; backgroundColor?: unknown };
  return (typeof candidate.isDark === 'boolean' &&
  typeof candidate.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(candidate.backgroundColor));
}

/**
 * Guard against saved x/y referencing a display that no longer exists
 * (laptop docked → undocked, external monitor unplugged). Walks the
 * current display workAreas; if no display contains a meaningful
 * overlap with the saved bounds, strip x/y so Electron centers the
 * window on the primary display.
 *
 * "Meaningful overlap" = at least a 100×100 corner of the saved
 * rectangle lies inside some display's workArea. Tighter than "any
 * pixel intersects" so a 1px sliver still flagged-as-off-screen
 * doesn't leave a tiny visible nub the user has to grab.
 */
function clampBoundsToVisibleDisplay(bounds: SavedBounds): SavedBounds {
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return { width: bounds.width, height: bounds.height };
  const visible = displays.some((display) => {
    const wa = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x! + bounds.width, wa.x + wa.width) - Math.max(bounds.x!, wa.x));
    const overlapY = Math.max(0, Math.min(bounds.y! + bounds.height, wa.y + wa.height) - Math.max(bounds.y!, wa.y));
    return overlapX >= 100 && overlapY >= 100;
  });
  if (visible) return bounds;
  // Off-screen: keep the size but drop the position so Electron centers.
  return { width: bounds.width, height: bounds.height, isMaximized: bounds.isMaximized };
}

function e2eFixtureWindowBounds(
  e2eFixture: E2eFixture | null,
  defaults: SavedBounds,
): SavedBounds {
  if (!e2eFixture) return defaults;
  const width = Number(process.env.MAKA_E2E_FIXTURE_WIDTH);
  const height = Number(process.env.MAKA_E2E_FIXTURE_HEIGHT);
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= SAFE_MIN_WIDTH &&
    height >= SAFE_MIN_HEIGHT
  ) {
    return { width: Math.floor(width), height: Math.floor(height) };
  }
  return defaults;
}

function emitRealWindowSmokeDiagnostic(stage: string): void {
  const target = mainWindow;
  if (!target) {
    console.log(`[real-window-smoke] diagnostic ${JSON.stringify({ stage, windowExists: false })}`);
    return;
  }
  const windowState = {
    stage,
    windowExists: true,
    title: target.getTitle(),
    bounds: target.getBounds(),
    normalBounds: target.getNormalBounds(),
    isVisible: target.isVisible(),
    isFocused: target.isFocused(),
    isMinimized: target.isMinimized(),
    isMaximized: target.isMaximized(),
    isResizable: target.isResizable(),
    isMovable: target.isMovable(),
    isModal: target.isModal(),
    // A hidden dock icon makes the run an accessory app: the window still
    // takes clicks and keyboard focus, but it has no Dock tile and no
    // Cmd+Tab entry, so a reviewer who switches away cannot switch back.
    // null on platforms without a dock.
    dockVisible: process.platform === 'darwin' ? (app.dock?.isVisible() ?? null) : null,
    webContentsUrl: target.webContents.getURL(),
  };
  target.webContents
    .executeJavaScript(
      `(() => ({
        readyState: document.readyState,
        title: document.title,
        appFramePresent: Boolean(document.querySelector('.appFrame')),
        searchModalPresent: Boolean(document.querySelector('[data-maka-contract="search-modal"]')),
        searchModalOpen: Boolean(document.querySelector('dialog[data-maka-contract="search-modal"][open]')),
        errorBoundaryPresent: Boolean(document.querySelector('.maka-error-surface')),
        bodyTextLength: document.body?.innerText?.trim().length ?? 0,
        bodyTextSample: document.body?.innerText?.trim().slice(0, 240) ?? '',
        stylesheetCount: document.styleSheets.length,
        rootChildren: document.getElementById('root')?.children.length ?? 0,
        elements: ['body', '#root', '.appFrame', '.app', '.maka-panel-detail', '.mainColumn', '.maka-onboarding-loading'].map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, present: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            selector,
            present: true,
            textLength: (element.textContent ?? '').trim().length,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            color: style.color,
            backgroundColor: style.backgroundColor,
          };
        }),
        centerElement: (() => {
          const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
          if (!element) return null;
          const style = getComputedStyle(element);
          return {
            tagName: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            text: (element.textContent ?? '').trim().slice(0, 120),
            color: style.color,
            backgroundColor: style.backgroundColor,
          };
        })(),
        activeElementInSearchModal: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-maka-contract="search-modal"]')),
        activeElement: document.activeElement ? {
          tagName: document.activeElement.tagName,
          className: typeof document.activeElement.className === 'string' ? document.activeElement.className : '',
          ariaLabel: document.activeElement.getAttribute('aria-label'),
        } : null,
      }))()`,
      true,
    )
    .then((rendererState) => {
      console.log(`[real-window-smoke] diagnostic ${JSON.stringify({ ...windowState, renderer: rendererState })}`);
    })
    .catch((err: unknown) => {
      console.log(`[real-window-smoke] diagnostic ${JSON.stringify({ ...windowState, rendererError: errorMessage(err) })}`);
    });
}
