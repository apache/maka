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

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from '@astryxdesign/core/hooks';
import type {
  OverlaysCommands,
  OverlaysSelectors,
  OverlaysShellProjection,
} from '../model/overlays-projection.js';
import {
  consumeSearchScrollTarget,
  type SearchScrollTarget,
} from '../model/search-scroll-target.js';
import {
  CLOSED_SETTINGS_SURFACE,
  closeSettingsSurface,
  openSettingsSurface,
  settingsIntentSection,
  withSettingsProfileId,
  type SettingsSurfaceIntent,
} from '../model/settings-surface.js';
import { useOverlaysServices } from '../services-context.js';

export type OverlaysController = OverlaysShellProjection;

/**
 * Owns the shell's overlay surfaces: the keyboard help, the Command Palette,
 * the Search modal and its scroll target, and the Settings modal with what it
 * was asked to show. The global shortcuts live here too, so opening any of
 * them re-renders this owner and whatever reads it, never the shell's inputs.
 *
 * Bare `?` keeps typing itself into inputs: `useHotkeys` skips typing surfaces
 * by default, and only the modified combos opt back in. `mod+k` opts in
 * because the palette's point is being reachable mid-sentence.
 */
export function useOverlaysController(): OverlaysController {
  const services = useOverlaysServices();
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchScrollTarget, setSearchScrollTarget] = useState<SearchScrollTarget | null>(null);
  const [settings, setSettings] = useState(CLOSED_SETTINGS_SURFACE);

  useHotkeys([
    { keys: 'mod+/', allowInInputs: true, onPress: () => setHelpOpen((previous) => !previous) },
    { keys: 'mod+?', allowInInputs: true, onPress: () => setHelpOpen((previous) => !previous) },
    { keys: '?', onPress: () => setHelpOpen(true) },
    { keys: 'mod+k', allowInInputs: true, onPress: () => setPaletteOpen((previous) => !previous) },
  ]);

  // The openers are stable for the palette's memoized command pipeline; they
  // read whether Settings is already showing through the latest committed
  // value, since only a closed-to-open transition may move focus.
  const settingsOpenRef = useRef(settings.open);
  useLayoutEffect(() => {
    settingsOpenRef.current = settings.open;
  });
  const openSettingsWith = useCallback(
    (intent: SettingsSurfaceIntent) => {
      const section = settingsIntentSection(intent);
      if (section) services.settingsSection.persist(section);
      if (!settingsOpenRef.current) services.focus.blurActiveElement();
      setSettings((current) => openSettingsSurface(current, intent));
    },
    [services],
  );

  const commands = useMemo<OverlaysCommands>(
    () => ({
      openHelp: () => setHelpOpen(true),
      closeHelp: () => setHelpOpen(false),
      openPalette: () => setPaletteOpen(true),
      closePalette: () => setPaletteOpen(false),
      openSearch: () => setSearchOpen(true),
      closeSearch: () => setSearchOpen(false),
      searchThread: (request) => services.search.thread(request),
      setSearchScrollTarget,
      consumeSearchScrollTarget: (nonce) =>
        setSearchScrollTarget((current) => consumeSearchScrollTarget(current, nonce)),
      openSettings: () => openSettingsWith({ kind: 'settings' }),
      openSettingsSection: (section) => openSettingsWith({ kind: 'section', section }),
      openProjectSettings: (profileId) => openSettingsWith({ kind: 'project', profileId }),
      openProviderCatalog: () => openSettingsWith({ kind: 'provider-catalog' }),
      openConnectionDetail: (slug) => openSettingsWith({ kind: 'connection-detail', slug }),
      openProviderCreate: (providerType) =>
        openSettingsWith({ kind: 'provider-create', providerType }),
      setSettingsProfileId: (profileId) =>
        setSettings((current) => withSettingsProfileId(current, profileId)),
      closeSettings: () => setSettings(closeSettingsSurface),
    }),
    [openSettingsWith, services],
  );

  const selectors = useMemo<OverlaysSelectors>(
    () => ({
      helpOpen,
      paletteOpen,
      searchOpen,
      anyModalOpen: helpOpen || paletteOpen || searchOpen,
      settings,
      searchScrollTarget,
    }),
    [helpOpen, paletteOpen, searchOpen, settings, searchScrollTarget],
  );

  return useMemo(() => ({ commands, selectors }), [commands, selectors]);
}
