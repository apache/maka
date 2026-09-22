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

import { Menu, type BrowserWindow } from 'electron';
import type { NativeMenuRequest } from '../shared/native-menu.js';

// A Menu collected while its popup is still open crashes the native close
// path, so each popup owns a reference until its callback reports it closed.
const openMenus = new Set<Menu>();

export function popupNativeMenu(window: BrowserWindow, input: unknown): Promise<string | null> {
  const request = input as NativeMenuRequest | undefined;
  if (!request || !Number.isFinite(request.x) || !Number.isFinite(request.y) ||
    !Array.isArray(request.items) || request.items.length === 0 || request.items.length > 32 ||
    request.items.some((item) => !item || typeof item.id !== 'string' || item.id.length > 128 ||
      typeof item.label !== 'string' || item.label.length > 256 ||
      typeof item.checked !== 'boolean' || typeof item.enabled !== 'boolean')) {
    throw new TypeError('Invalid native menu request');
  }
  if (window.isDestroyed()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let selected: string | null = null;
    const menu = Menu.buildFromTemplate(request.items.map((item) => ({
      label: item.label, type: 'checkbox', checked: item.checked, enabled: item.enabled,
      click: () => { selected = item.id; },
    })));
    // Menu coordinates are relative to window content, in DIP rather than CSS pixels.
    const zoom = window.webContents.getZoomFactor();
    openMenus.add(menu);
    try {
      menu.popup({ window, x: Math.round(request.x * zoom), y: Math.round(request.y * zoom),
        callback: () => { openMenus.delete(menu); resolve(selected); } });
    } catch (error) {
      openMenus.delete(menu);
      throw error;
    }
  });
}
