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

import type { ProviderType } from '@maka/core/llm-connections';
import type { SettingsSection } from '@maka/core/settings';
import type { OverlaySearchThread } from '../ports.js';
import type { SearchScrollTarget } from './search-scroll-target.js';
import type { SettingsSurface } from './settings-surface.js';

/** What the shell and the overlay layer may ask the overlays to do. */
export interface OverlaysCommands {
  openHelp(): void;
  closeHelp(): void;
  openPalette(): void;
  closePalette(): void;
  openSearch(): void;
  closeSearch(): void;
  searchThread: OverlaySearchThread;
  setSearchScrollTarget(target: SearchScrollTarget | null): void;
  consumeSearchScrollTarget(nonce: number): void;
  openSettings(): void;
  openSettingsSection(section: SettingsSection): void;
  openProjectSettings(profileId: string): void;
  openProviderCatalog(): void;
  openConnectionDetail(slug: string): void;
  openProviderCreate(providerType: ProviderType): void;
  setSettingsProfileId(profileId: string | undefined): void;
  closeSettings(): void;
}

/** What is showing. */
export interface OverlaysSelectors {
  readonly helpOpen: boolean;
  readonly paletteOpen: boolean;
  readonly searchOpen: boolean;
  /** Help, palette, or search: the modals that make the shell inert. */
  readonly anyModalOpen: boolean;
  readonly settings: SettingsSurface;
  readonly searchScrollTarget: SearchScrollTarget | null;
}

export interface OverlaysShellProjection {
  readonly commands: OverlaysCommands;
  readonly selectors: OverlaysSelectors;
}
