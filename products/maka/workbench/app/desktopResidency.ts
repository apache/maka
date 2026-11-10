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

import { effect, host } from 'nsh';
import { Tray, currentWindow } from 'nsh/desktop';
import { appearance } from './appearance';
import { tr } from './locale';
import { trayIconArtwork } from './trayIcon';

/** Closing the main window hides it; the engine and its Host client stay. */
export function keepDesktopResident() {
  const window = currentWindow();
  if (!window) return;
  window.set({ closeOnPress: false });
  window.on('closePress', () => window.hide());
  const open = () => window.focus();
  effect(() =>
    Tray.set({
      icon: trayIconArtwork[appearance.trayIcon()],
      tooltip: 'Maka',
      onClick: open,
      menu: [
        { label: tr('Open Maka'), onSelect: open },
        { type: 'separator' },
        { label: tr('Quit Maka'), onSelect: () => host.post('terminal.exit') },
      ],
    }),
  );
}
