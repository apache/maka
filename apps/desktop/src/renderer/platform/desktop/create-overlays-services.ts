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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { OverlaysServices } from '../../features/overlays/index.js';

export type DesktopOverlaysBridge = Pick<MakaBridge, 'search'>;

/** The browser capabilities the overlays reach through this adapter. */
export interface DesktopOverlaysEnvironment {
  readonly storage: Pick<Storage, 'setItem'>;
  readonly document: Pick<Document, 'activeElement'>;
}

/** Read back by `settings/settings-nav.ts` when the Settings modal opens. */
export const SETTINGS_SECTION_STORAGE_KEY = 'maka-settings-section-v1';

/** The only Desktop-to-overlays adapter. */
export function createDesktopOverlaysServices(
  bridge: DesktopOverlaysBridge = window.maka,
  environment: DesktopOverlaysEnvironment = { storage: window.localStorage, document },
): OverlaysServices {
  return {
    search: bridge.search,
    settingsSection: {
      persist(section) {
        try {
          environment.storage.setItem(SETTINGS_SECTION_STORAGE_KEY, section);
        } catch {
          // Storage may be unavailable in restricted or test renderer contexts.
        }
      },
    },
    focus: {
      blurActiveElement() {
        const element = environment.document.activeElement;
        if (element && typeof (element as HTMLElement).blur === 'function') {
          (element as HTMLElement).blur();
        }
      },
    },
  };
}
