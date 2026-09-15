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

import type { Menu, MenuItemConstructorOptions, Tray } from 'electron';
import type { UiCatalog } from '@maka/core/ui-locale';
import type { DesktopLocaleAuthority } from './desktop-locale-authority.js';

type TraySurface = Pick<Tray, 'setToolTip' | 'setContextMenu' | 'on' | 'destroy' | 'isDestroyed'>;
interface WindowsAppTrayDeps {
  platform: NodeJS.Platform;
  enabled: boolean;
  locale: Pick<DesktopLocaleAuthority, 'current' | 'subscribe'>;
  createTray(): TraySurface;
  createMenu(template: MenuItemConstructorOptions[]): Menu;
  openMain(): void | Promise<void>;
  openWorkHub(): void | Promise<void>;
  quit(): void;
  onError(error: unknown): void;
}

interface WindowsAppTrayCopy {
  readonly open: string;
  readonly workHub: string;
  readonly quit: string;
}

const copy = {
  en: { open: 'Open Maka', workHub: 'Open WorkHub', quit: 'Quit Maka' },
  'zh-CN': { open: '打开 Maka', workHub: '打开 WorkHub', quit: '退出 Maka' },
  'zh-TW': { open: '開啟 Maka', workHub: '開啟 WorkHub', quit: '結束 Maka' },
} satisfies UiCatalog<WindowsAppTrayCopy>;

/** Windows needs a visible way back after the last product window closes. */
export function createWindowsAppTray(deps: WindowsAppTrayDeps) {
  let tray: TraySurface | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  const invoke = (action: () => void | Promise<void>) => () => {
    if (!disposed) void Promise.resolve().then(action).catch(deps.onError);
  };
  const menu = () => {
    const labels = copy[deps.locale.current()];
    return deps.createMenu([
      { label: labels.open, click: invoke(deps.openMain) },
      { label: labels.workHub, click: invoke(deps.openWorkHub) },
      { type: 'separator' },
      { label: labels.quit, click: invoke(deps.quit) },
    ]);
  };
  const hasTray = () => !!tray && !tray.isDestroyed();
  return {
    hasTray,
    start(): boolean {
      if (disposed || !deps.enabled || deps.platform !== 'win32') return false;
      if (hasTray()) return true;
      let candidate: TraySurface | undefined;
      try {
        candidate = deps.createTray();
        candidate.setToolTip('Maka');
        candidate.setContextMenu(menu());
        candidate.on('double-click', invoke(deps.openMain));
        unsubscribe = deps.locale.subscribe(() => {
          try { if (hasTray()) tray!.setContextMenu(menu()); }
          catch (error) { deps.onError(error); }
        });
        tray = candidate;
        return true;
      } catch (error) {
        unsubscribe?.();
        unsubscribe = undefined;
        candidate?.destroy();
        deps.onError(error);
        return false;
      }
    },
    dispose(): void {
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      if (hasTray()) tray!.destroy();
      tray = undefined;
    },
  };
}
