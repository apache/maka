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
  reportError?: (error: unknown) => void;
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
  const reportError = options.reportError ?? ((error: unknown) => {
    console.warn('[desktop] Windows maximize renderer sync failed:', error);
  });
  let pending = false;

  return () => {
    if (platform !== 'win32' || pending) return;
    if (window.isDestroyed() || !window.isMaximized()) return;
    pending = true;

    defer(() => {
      pending = false;
      try {
        if (window.isDestroyed() || !window.isMaximized()) return;
        if (window.webContents.isDestroyed()) return;

        window.setContentView(window.contentView);
        window.webContents.invalidate();
      } catch (error) {
        // A best-effort layout correction must not terminate the main process
        // if Electron tears down the native window between the guards and call.
        reportError(error);
      }
    });
  };
}
