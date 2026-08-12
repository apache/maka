import { lazy, Suspense } from 'react';
import type { ChatDefaultPermissionMode, SettingsSection, ThemePalette, ThemePreference } from '@maka/core/settings';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';
import type { SessionSummary } from '@maka/core/session';
import type { UiLocalePreference } from '@maka/core/ui-locale';
import { Spinner } from '@astryxdesign/core/Spinner';
import { SearchModal, useUiLocale } from '@maka/ui';
import { KeyboardHelpModal } from './keyboard-help';
import { CommandPalette } from './command-palette';
import { useAppShellCommands, type AppShellCommandListOptions } from './app-shell-command-actions';
import type { UiLocaleUpdateGate } from './settings/ui-locale-update-gate';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';
import { ExternalSessionImportDialog } from './external-session-import-dialog.js';

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
  connections: LlmConnection[];
  defaultConnection: string | null;
  refreshConnections(): Promise<void>;
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
  helpOpen: boolean;
  closeHelp(): void;
  searchModalOpen: boolean;
  closeSearchModal(): void;
  searchModalDeps: SearchModalProps['deps'];
  searchModalOnNavigate: NonNullable<SearchModalProps['onNavigateToSession']>;
  paletteOpen: boolean;
  closePalette(): void;
  commandOptions: AppShellCommandListOptions;
  externalImportOpen: boolean;
  onExternalImportOpenChange(open: boolean): void;
  onExternalSessionImported(session: SessionSummary): void;
}) {
  const {
    closeHelp,
    closePalette,
    closeSearchModal,
    closeSettings,
    commandOptions,
    connections,
    defaultConnection,
    helpOpen,
    paletteOpen,
    refreshConnections,
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
    externalImportOpen,
    onExternalImportOpenChange,
    onExternalSessionImported,
  } = props;

  // #1045: base commands freeze per open/close; session rows stay live on
  // visibleSessions/activeId. run() closures read latest options via ref.
  const commands = useAppShellCommands(paletteOpen, commandOptions);
  return (
    <>
      {settingsOpen && (
        <Suspense fallback={<SettingsModalFallback />}>
          <SettingsModal
            connections={connections}
            defaultSlug={defaultConnection}
            onRefresh={refreshConnections}
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
      <ExternalSessionImportDialog
        isOpen={externalImportOpen}
        onOpenChange={onExternalImportOpenChange}
        onImported={onExternalSessionImported}
      />
    </>
  );
}
