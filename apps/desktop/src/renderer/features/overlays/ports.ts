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

import type { ConnectionTestResult } from '@maka/core/llm-connections';
import type { SettingsSection, SettingsTestResult } from '@maka/core/settings';
import type { SearchModal } from '@maka/ui';

/** The recall search the Search modal runs; the type is the modal's own. */
export type OverlaySearchRecall = NonNullable<
  Parameters<typeof SearchModal>[0]['deps']
>['searchRecall'];

/** The minimum environment capabilities the overlays need. */
export interface OverlaySearchService {
  recall: OverlaySearchRecall;
  cancelRecall(requestId: string): Promise<void>;
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

/** The Runtime Host a palette row runs on; the row builder resolves the default one. */
export interface OverlayPaletteHost {
  readonly profileId: string;
  readonly hostId: string;
}

export type OverlayConversationSaveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'canceled' | 'write_failed' | 'invalid_input' };

/**
 * The Desktop operations behind the command palette's own rows. The rows keep
 * their toasts and default-Host resolution; these only reach Desktop, with
 * the arguments the rows always sent.
 */
export interface OverlayPaletteActions {
  /** Tests a connection named by its slug, as the palette row lists it. */
  testConnection(slug: string, host: OverlayPaletteHost): Promise<ConnectionTestResult>;
  setDefaultConnection(slug: string, host: OverlayPaletteHost): Promise<void>;
  /** Tests the persisted network proxy settings. */
  testNetworkProxy(host: OverlayPaletteHost): Promise<SettingsTestResult>;
  openLocalMemoryFile(
    host: OverlayPaletteHost,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  /** Asks where to save, then writes the rendered conversation. */
  saveConversationToFile(input: {
    readonly markdown: string;
    readonly defaultName: string;
  }): Promise<OverlayConversationSaveResult>;
}

export interface OverlaysServices {
  search: OverlaySearchService;
  settingsSection: OverlaySettingsSectionStore;
  focus: OverlayFocusService;
  palette: OverlayPaletteActions;
}
