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

import type { SettingsSection } from '@maka/core/settings';
import type { SearchModal } from '@maka/ui';

/** The thread search the Search modal runs; the type is the modal's own. */
export type OverlaySearchThread = NonNullable<
  Parameters<typeof SearchModal>[0]['deps']
>['searchThread'];

/** The minimum environment capabilities the overlays need. */
export interface OverlaySearchService {
  thread: OverlaySearchThread;
}

export interface OverlaySettingsSectionStore {
  /** Remembers the Settings section an opener landed on, for the next open. */
  persist(section: SettingsSection): void;
}

export interface OverlayFocusService {
  /**
   * Settles blur-owned edits before Settings obscures the shell: macOS menu
   * commands open Settings without moving DOM focus first.
   */
  blurActiveElement(): void;
}

export interface OverlaysServices {
  search: OverlaySearchService;
  settingsSection: OverlaySettingsSectionStore;
  focus: OverlayFocusService;
}
