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

import { cleanup, effect, host, platform } from 'nsh';
import { isAvailable, Tray, Window } from 'nsh/desktop';
import { appearance } from './appearance';
import { tr } from './locale';

/** The Bootstrap owner outlives replaceable UI contributions. */
export function nativeDesktop() {
  if (!isAvailable || !platform.desktop || platform.idiom === 'terminal') return;
  const main = Window.get('main');
  if (!main) return;

  main.set({ closeOnPress: false });
  cleanup(main.on('closePress', () => main.hide()));
  cleanup(() => Tray.set(null));
  effect(() => {
    Tray.set({
      icon: `asset:/maka/tray-${appearance.trayIcon()}.svg`,
      tooltip: 'Maka',
      onClick: () => main.focus(),
      menu: [
        { label: tr('Open Maka'), onSelect: () => main.focus() },
        { type: 'separator' },
        { label: tr('Quit Maka'), onSelect: () => host.post('terminal.exit') },
      ],
    });
  });
}
