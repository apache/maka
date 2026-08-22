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

import { lazy, Suspense } from 'react';
import type { ChatDefaultPermissionMode, SettingsSection, ThemePalette, ThemePreference } from '@maka/core/settings';
import type { ProviderType } from '@maka/core/llm-connections';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';
import type { UiLocalePreference } from '@maka/core/ui-locale';
import { Spinner } from '@astryxdesign/core/Spinner';
import { useHotkeys } from '@astryxdesign/core/hooks';
import { SearchModal, useUiLocale } from '@maka/ui';
import { KeyboardHelpModal } from './keyboard-help';
import { CommandPalette } from './command-palette';
import { useAppShellCommands, type AppShellCommandListOptions } from './app-shell-command-actions';
import type { ArchivedTasksBridge } from './settings/tasks-settings-page';
import type { UiLocaleUpdateGate } from './settings/ui-locale-update-gate';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

const SettingsModal = lazy(() => import('./settings/settings-modal').then((m) => ({ default: m.SettingsModal })));

type SearchModalProps = Parameters<typeof SearchModal>[0];

function SettingsModalFallback() {
  const copy = getShellRemainingCopy(useUiLocale()).overlays;
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={copy.loadingSettings}
      className="settingsModal settingsPage agents-layout-root"
      data-agents-page
    >
      <div className="maka-lazy-fallback" data-surface="modal">
        <Spinner size="md" shade="subtle" label={copy.loadingSettingsProgress} />
      </div>
    </div>
  );
}

export function AppShellOverlays(props: {
  settingsOpen: boolean;
  closeSettings(): void;
  themePref: ThemePreference;
  setThemePref(themePref: ThemePreference): void;
  themePalette: ThemePalette;
  setThemePalette(themePalette: ThemePalette): void;
  setUiLocalePreference: (preference: UiLocalePreference) => void;
  uiLocaleUpdateGate: UiLocaleUpdateGate;
  setUserLabel(userLabel: string): void;
  setDefaultPermissionMode(mode: ChatDefaultPermissionMode): void;
  settingsRequestedSection: SettingsSection | undefined;
  settingsProviderCatalogOpen: boolean;
  settingsConnectionDetailSlug: string | undefined;
  settingsCreateProviderType: ProviderType | undefined;
  onOpenDailyReview(): void;
  onOpenKeyboardHelp(): void;
  onOpenSettingsSession(sessionId: string): void;
  archivedTasks: ArchivedTasksBridge;
  helpOpen: boolean;
  closeHelp(): void;
  searchModalOpen: boolean;
  closeSearchModal(): void;
  searchModalDeps: SearchModalProps['deps'];
  searchModalOnNavigate: NonNullable<SearchModalProps['onNavigateToSession']>;
  paletteOpen: boolean;
  closePalette(): void;
  commandOptions: AppShellCommandListOptions;
  onExternalSessionImported(session: DesktopSessionSummary): void;
  onRemoteHostAdded(profileId: string): void;
  onSelectedRuntimeHostProfileIdChange(profileId: string | undefined): void;
}) {
  const {
    closeHelp,
    closePalette,
    closeSearchModal,
    closeSettings,
    commandOptions,
    helpOpen,
    paletteOpen,
    searchModalDeps,
    searchModalOnNavigate,
    searchModalOpen,
    settingsOpen,
    settingsRequestedSection,
    settingsProviderCatalogOpen,
    settingsConnectionDetailSlug,
    settingsCreateProviderType,
    setThemePalette,
    setThemePref,
    setUiLocalePreference,
    uiLocaleUpdateGate,
    setUserLabel,
    setDefaultPermissionMode,
    themePalette,
    themePref,
    onExternalSessionImported,
  } = props;

  // #1045: base commands freeze per open/close; session rows stay live on
  // visibleSessions/activeId. run() closures read latest options via ref.
  const commands = useAppShellCommands(paletteOpen, commandOptions);
  const copyDiagnosticsCommand = commands.find((command) => command.id === 'diag:copy-diagnostics');
  useHotkeys([
    {
      keys: 'mod+shift+d',
      allowInInputs: true,
      onPress: () => void copyDiagnosticsCommand?.run(),
    },
  ]);
  return (
    <>
      {settingsOpen && (
        <Suspense fallback={<SettingsModalFallback />}>
          <SettingsModal
            onClose={closeSettings}
            themePref={themePref}
            onThemeChange={setThemePref}
            themePalette={themePalette}
            onThemePaletteChange={setThemePalette}
            onUiLocalePreferenceChange={setUiLocalePreference}
            uiLocaleUpdateGate={uiLocaleUpdateGate}
            onUserLabelChange={setUserLabel}
            onDefaultPermissionModeChange={setDefaultPermissionMode}
            requestedSection={settingsRequestedSection}
            openProviderCatalog={settingsProviderCatalogOpen}
            initialConnectionSlug={settingsConnectionDetailSlug}
            initialCreateProviderType={settingsCreateProviderType}
            onOpenDailyReview={props.onOpenDailyReview}
            onOpenKeyboardHelp={props.onOpenKeyboardHelp}
            onOpenSession={props.onOpenSettingsSession}
            archivedTasks={props.archivedTasks}
            onTaskImported={onExternalSessionImported}
            onRemoteHostAdded={props.onRemoteHostAdded}
            onSelectedRuntimeHostProfileIdChange={props.onSelectedRuntimeHostProfileIdChange}
          />
        </Suspense>
      )}
      <KeyboardHelpModal
        isOpen={helpOpen}
        onOpenChange={(open) => {
          if (!open) closeHelp();
        }}
      />
      <SearchModal
        isOpen={searchModalOpen}
        onOpenChange={(open) => {
          if (!open) closeSearchModal();
        }}
        deps={searchModalDeps}
        onNavigateToSession={searchModalOnNavigate}
      />
      <CommandPalette
        isOpen={paletteOpen}
        onOpenChange={(open) => {
          if (!open) closePalette();
        }}
        commands={commands}
      />
    </>
  );
}
