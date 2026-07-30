import { useEffect, useRef } from 'react';
import type {
  LlmConnection,
  ProviderType,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UiLocalePreference,
} from '@maka/core';
import { useUiLocale } from '@maka/ui';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy';
import { SettingsSurface } from './settings-surface';
import type { UiLocaleUpdateGate } from './ui-locale-update-gate';

export { SETTINGS_NAV } from './settings-nav';
export type { SettingsNavGroup } from './settings-nav';

export function SettingsModal(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  onClose(): void;
  themePref: ThemePreference;
  onThemeChange(pref: ThemePreference): void;
  /**
   * PR-THEME-APPLY-AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): current
   * palette + live setter. Click handler calls `onThemePaletteChange(next)`
   * synchronously so the `data-maka-theme` attribute updates on the same
   * tick — no need to wait for the IPC `appearance.palette` round-trip,
   * and no need for a restart for switching to take visible effect.
   */
  themePalette: ThemePalette;
  onThemePaletteChange(palette: ThemePalette): void;
  onUiLocalePreferenceChange(preference: UiLocalePreference): void;
  uiLocaleUpdateGate: UiLocaleUpdateGate;
  onUserLabelChange?(label: string): void;
  /**
   * Force the modal to a specific section when it (re-)mounts or when the
   * value changes while already open. Used by the command palette so
   * ⌘K → "网络" jumps straight to the section without an extra click.
   */
  requestedSection?: SettingsSection;
  openProviderCatalog?: boolean;
  initialConnectionSlug?: string;
  initialCreateProviderType?: ProviderType;
  /**
   * PR-DAILY-REVIEW-MVP-0 follow-up: navigate to the sidebar's
   * Daily Review module. Optional so the settings page degrades
   * gracefully when the shell does not provide the jump.
   */
  onOpenDailyReview?(): void;
  /**
   * Jump from diagnostics surfaces (usage rows, later run history) back to the
   * source conversation. Settings owns the table, shell owns navigation.
   */
  onOpenSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsSharedCopy(locale);
  const pageRef = useRef<HTMLDivElement>(null);
  // Focused by SettingsSurface's section-keyed effect (mount + section
  // change). Deliberately NOT focused from an effect here keyed on any
  // callback prop: `onClose` is recreated on every AppShell render (which
  // happens per streamed token), and a focus side effect keyed on it yanks
  // focus away from anything open inside Settings while a session streams.
  const activeNavRef = useRef<HTMLButtonElement>(null);

  // The Escape listener is safe to resubscribe on every onClose identity
  // change (it only adds/removes a DOM listener, not a focus-stealing side
  // effect), and keeping it keyed on `onClose` guarantees Escape always
  // calls the current closure rather than a stale one.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') props.onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  return (
    <div
      ref={pageRef}
      role="region"
      aria-label={copy.modalLabel}
      className="settingsModal settingsPage agents-layout-root"
      data-agents-page
    >
      <SettingsSurface
        connections={props.connections}
        defaultSlug={props.defaultSlug}
        onRefresh={props.onRefresh}
        onClose={props.onClose}
        themePref={props.themePref}
        onThemeChange={props.onThemeChange}
        themePalette={props.themePalette}
        onThemePaletteChange={props.onThemePaletteChange}
        onUiLocalePreferenceChange={props.onUiLocalePreferenceChange}
        uiLocaleUpdateGate={props.uiLocaleUpdateGate}
        onUserLabelChange={props.onUserLabelChange}
        requestedSection={props.requestedSection}
        openProviderCatalog={props.openProviderCatalog}
        initialConnectionSlug={props.initialConnectionSlug}
        initialCreateProviderType={props.initialCreateProviderType}
        initialFocusRef={activeNavRef}
        onOpenDailyReview={props.onOpenDailyReview}
        onOpenSession={props.onOpenSession}
      />
    </div>
  );
}
