import { lazy, Suspense, useCallback } from 'react';
import type {
  LlmConnection,
  ProviderType,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UiLocalePreference,
} from '@maka/core';
import { SearchModal, useUiLocale } from '@maka/ui';
import { KeyboardHelpModal } from './keyboard-help';
import { CommandPalette } from './command-palette';
import { useAppShellCommands, type AppShellCommandListOptions } from './app-shell-command-actions';
import type { UiLocaleUpdateGate } from './settings/ui-locale-update-gate';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

// Settings is a large surface (providers, OAuth, network, bots, daily-review,
// usage, etc.) that is only needed once the user opens the Settings modal.
// Loading it lazily keeps all of that out of the initial chunk so the first
// paint of the chat shell isn't blocked on parsing hundreds of KB of settings
// UI that may never be opened.
const SettingsModal = lazy(() => import('./settings/SettingsModal').then((m) => ({ default: m.SettingsModal })));

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
      <div className="maka-lazy-fallback" data-surface="modal">{copy.loadingSettingsProgress}</div>
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
  settingsRequestedSection: SettingsSection | undefined;
  settingsProviderCatalogOpen: boolean;
  settingsConnectionDetailSlug: string | undefined;
  settingsCreateProviderType: ProviderType | undefined;
  onOpenDailyReview(): void;
  onOpenSettingsSession(sessionId: string): void;
  helpOpen: boolean;
  closeHelp(): void;
  searchModalOpen: boolean;
  searchModalInitialQuery: string;
  closeSearchModal: SearchModalProps['onClose'];
  searchModalDeps: SearchModalProps['deps'];
  searchModalOnNavigate: NonNullable<SearchModalProps['onNavigateToSession']>;
  paletteOpen: boolean;
  closePalette(): void;
  paletteOnSelectSession(sessionId: string, turnId?: string): void;
  paletteOnOpenSearchModal(query: string): void;
  commandOptions: AppShellCommandListOptions;
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
    paletteOnOpenSearchModal,
    paletteOnSelectSession,
    paletteOpen,
    refreshConnections,
    searchModalDeps,
    searchModalInitialQuery,
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
    themePalette,
    themePref,
  } = props;

  // #1045: base commands freeze per open/close; session rows stay live on
  // visibleSessions/activeId. run() closures read latest options via ref.
  const commands = useAppShellCommands(paletteOpen, commandOptions);
  const openSearchModal = useCallback(
    (query: string) => {
      closePalette();
      paletteOnOpenSearchModal(query);
    },
    [closePalette, paletteOnOpenSearchModal],
  );

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
            requestedSection={settingsRequestedSection}
            openProviderCatalog={settingsProviderCatalogOpen}
            initialConnectionSlug={settingsConnectionDetailSlug}
            initialCreateProviderType={settingsCreateProviderType}
            onOpenDailyReview={props.onOpenDailyReview}
            onOpenSession={props.onOpenSettingsSession}
          />
        </Suspense>
      )}
      {helpOpen && <KeyboardHelpModal onClose={closeHelp} />}
      {searchModalOpen && (
        <SearchModal
          onClose={closeSearchModal}
          deps={searchModalDeps}
          initialQuery={searchModalInitialQuery}
          onNavigateToSession={searchModalOnNavigate}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          onSelectSession={paletteOnSelectSession}
          onOpenSearchModal={openSearchModal}
          commands={commands}
        />
      )}
    </>
  );
}
