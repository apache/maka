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

/**
 * What the macOS dock should show for this run.
 *
 * Its own module, free of an `electron` import, so the rule can be tested
 * without launching Electron. The branch this replaced lived inside
 * `app.whenReady()` and keyed off a re-derivation of the start-hidden
 * condition that had already drifted from the real one — it missed the
 * `MAKA_E2E_SHOW_WINDOW` escape hatch, so a window a developer explicitly
 * asked to see still launched as an accessory app.
 *
 *  - `hide`: run as an accessory app. No dock tile, no dock bounce, and it
 *    never becomes frontmost, so a capture or E2E run cannot steal focus from
 *    whatever the developer is doing.
 *  - `icon`: dev `npm start` shows Maka's brand mark instead of the generic
 *    Electron icon (PR-GRAY-CARD-LIFT-0, WAWQAQ msg `0eb99429` 2026-06-20).
 *    Packaged builds get this from the .app bundle Info.plist.
 *  - `none`: no dock exists on this platform.
 */
export function resolveDockPresentation(
  platform: NodeJS.Platform,
  startHidden: boolean,
): 'hide' | 'icon' | 'none' {
  if (platform !== 'darwin') return 'none';
  return startHidden ? 'hide' : 'icon';
}
