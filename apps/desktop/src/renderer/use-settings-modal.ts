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

import { useCallback, useState } from 'react';
import type { ProviderType } from '@maka/core/llm-connections';
import type { SettingsSection } from '@maka/core/settings';
import { safeLocalStorageSet } from './browser-storage';

interface SettingsNavigationRequest {
  readonly section?: SettingsSection;
  readonly profileId?: string;
}

/**
 * Owns the Settings modal surface state (issue #1043): the open flag, the
 * requested section, and the provider-catalog sub-open flag, plus the openers
 * that persist the section to localStorage.
 *
 * `closeSettings` stays in AppShell: on close it re-pulls the onboarding
 * snapshot, the memory-visibility flag, and the default permission mode -
 * cross-slice orchestration that belongs to the shell, not the modal.
 */
export function useSettingsModal() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState<SettingsNavigationRequest>({});
  const [settingsProviderCatalogOpen, setSettingsProviderCatalogOpen] = useState(false);
  const [settingsConnectionDetailSlug, setSettingsConnectionDetailSlug] = useState<string | undefined>(undefined);
  const [settingsCreateProviderType, setSettingsCreateProviderType] = useState<ProviderType | undefined>(undefined);

  const setSettingsProfileId = useCallback((profileId: string | undefined) => {
    setSettingsRequest((current) =>
      current.profileId === profileId ? current : { ...current, profileId },
    );
  }, []);

  function showSettings() {
    // macOS menu commands do not move DOM focus before opening Settings.
    // Settle blur-owned edits before the obscured shell unmounts them.
    if (!settingsOpen && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setSettingsOpen(true);
  }

  function openSettings() {
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsCreateProviderType(undefined);
    showSettings();
  }

  function openSettingsSection(section: SettingsSection) {
    safeLocalStorageSet('maka-settings-section-v1', section);
    setSettingsRequest((current) => ({ ...current, section }));
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsCreateProviderType(undefined);
    showSettings();
  }

  function openProjectSettings(profileId: string) {
    safeLocalStorageSet('maka-settings-section-v1', 'projects');
    setSettingsRequest({ section: 'projects', profileId });
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsCreateProviderType(undefined);
    showSettings();
  }

  function openProviderCatalog() {
    safeLocalStorageSet('maka-settings-section-v1', 'models');
    setSettingsRequest((current) => ({ ...current, section: 'models' }));
    setSettingsProviderCatalogOpen(true);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsCreateProviderType(undefined);
    showSettings();
  }

  /** Open Settings → 模型 with a specific connection's detail sheet expanded. */
  function openConnectionDetail(slug: string) {
    safeLocalStorageSet('maka-settings-section-v1', 'models');
    setSettingsRequest((current) => ({ ...current, section: 'models' }));
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(slug);
    setSettingsCreateProviderType(undefined);
    showSettings();
  }

  /** Open Settings → 模型 with the create-connection dialog for this provider expanded. */
  function openProviderCreate(providerType: ProviderType) {
    safeLocalStorageSet('maka-settings-section-v1', 'models');
    setSettingsRequest((current) => ({ ...current, section: 'models' }));
    setSettingsProviderCatalogOpen(false);
    setSettingsConnectionDetailSlug(undefined);
    setSettingsCreateProviderType(providerType);
    showSettings();
  }

  return {
    settingsOpen,
    settingsRequest,
    settingsProviderCatalogOpen,
    settingsConnectionDetailSlug,
    settingsCreateProviderType,
    setSettingsOpen,
    setSettingsProviderCatalogOpen,
    setSettingsProfileId,
    openSettings,
    openSettingsSection,
    openProjectSettings,
    openProviderCatalog,
    openConnectionDetail,
    openProviderCreate,
  };
}
