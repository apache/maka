export interface MaximizedRendererSyncWindow<ContentView = unknown> {
  readonly contentView: ContentView;
  readonly webContents: {
    isDestroyed(): boolean;
    invalidate(): void;
  };
  isDestroyed(): boolean;
  isMaximized(): boolean;
  setContentView(view: ContentView): void;
}

interface MaximizedRendererSyncOptions {
  platform?: NodeJS.Platform;
  defer?: (callback: () => void) => void;
}

/**
 * Re-runs Electron's root view layout after a native Windows maximize.
 *
 * Electron's BrowserWindow WebContentsView and the public contentView are
 * siblings under one default-fill root view. Re-applying the same contentView
 * makes Electron invalidate and immediately lay out that root without changing
 * the native window bounds or its restored bounds. The repaint then covers the
 * newly maximized client area.
 */
export function createWindowsMaximizeRendererSync<ContentView>(
  window: MaximizedRendererSyncWindow<ContentView>,
  options: MaximizedRendererSyncOptions = {},
): () => void {
  const platform = options.platform ?? process.platform;
  const defer = options.defer ?? setImmediate;
  let pending = false;

  return () => {
    if (platform !== 'win32' || pending) return;
    if (window.isDestroyed() || !window.isMaximized()) return;
    pending = true;

    defer(() => {
      pending = false;
      if (window.isDestroyed() || !window.isMaximized()) return;
      if (window.webContents.isDestroyed()) return;

      window.setContentView(window.contentView);
      window.webContents.invalidate();
    });
  };
}
