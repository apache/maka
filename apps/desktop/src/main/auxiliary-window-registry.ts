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

import { createRequire } from 'node:module';
import type { BrowserWindow, BrowserWindowConstructorOptions, View, WebContents } from 'electron';
import { focusWindow, showWindowInactive, type WindowRevealMode } from './window-reveal.js';

function loadElectron(): typeof import('electron') {
  try {
    return (0, eval)('require')('electron') as typeof import('electron');
  } catch {
    return createRequire(process.execPath)('electron') as typeof import('electron');
  }
}

const declarations = {
  'permission-overlay': {
    size: {},
    reveal: showWindowInactive,
  },
  workhub: {
    size: {},
    reveal: showWindowInactive,
  },
  'cursor-overlay': {
    size: {},
    reveal: showWindowInactive,
  },
  pip: {
    size: {},
    reveal: showWindowInactive,
  },
} as const;

export type AuxiliaryWindowId = keyof typeof declarations;

export function createAuxiliaryWindowRegistry(
  electron: () => typeof import('electron') = loadElectron,
) {
  const rendererParents = new Map<WebContents, View>();

  return {
    create(id: AuxiliaryWindowId, options: BrowserWindowConstructorOptions): BrowserWindow {
      const declaration = declarations[id];
      const window = new (electron().BrowserWindow)({
        ...declaration.size,
        ...options,
        show: false,
      });
      return window;
    },
    show(id: AuxiliaryWindowId, window: BrowserWindow | undefined, mode: WindowRevealMode): void {
      declarations[id].reveal(window ?? null, mode);
    },
    focus(window: BrowserWindow | undefined, mode: WindowRevealMode): void {
      focusWindow(window ?? null, mode);
    },
    destroy(window: BrowserWindow | undefined): void {
      if (window && !window.isDestroyed()) window.destroy();
    },
    registerRenderer(contents: WebContents, parent: View): () => void {
      if (contents.isDestroyed()) return () => undefined;
      rendererParents.set(contents, parent);
      const release = (): void => {
        rendererParents.delete(contents);
        contents.removeListener('destroyed', release);
      };
      contents.once('destroyed', release);
      return release;
    },
    rendererParent(contents: WebContents): View | undefined {
      return contents.isDestroyed() ? undefined : rendererParents.get(contents);
    },
    renderers(): IterableIterator<WebContents> {
      return rendererParents.keys();
    },
  };
}

export const auxiliaryWindowRegistry = createAuxiliaryWindowRegistry();
