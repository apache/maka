import { useRef } from 'react';
import { useHotkeys } from '@astryxdesign/core/hooks';
import type { ChatDefaultPermissionMode, SettingsSection, ThemePalette, ThemePreference } from '@maka/core/settings';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';
import type { UiLocalePreference } from '@maka/core/ui-locale';
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
  onDefaultPermissionModeChange(mode: ChatDefaultPermissionMode): void;
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
  /** Opens the keyboard sheet; 关于 is its click-reachable home. */
  onOpenKeyboardHelp?(): void;
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

  // useHotkeys keeps its entries in a ref it refreshes every render, so Escape
  // always calls the current `onClose` without the listener churning on that
  // prop's identity (it is recreated on every AppShell render, i.e. per
  // streamed token). It also skips defaultPrevented events, which is what the
  // old `!event.defaultPrevented` check bought: a nested dialog that already
  // consumed Escape closes itself, not the whole Settings surface.
  //
  // `allowInInputs` because Escape must close Settings from inside its own
  // fields — the hook's default would have made Escape dead in every text box
  // on the page.
  useHotkeys([
    { keys: 'escape', allowInInputs: true, onPress: () => props.onClose() },
  ]);

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
        onDefaultPermissionModeChange={props.onDefaultPermissionModeChange}
        requestedSection={props.requestedSection}
        openProviderCatalog={props.openProviderCatalog}
        initialConnectionSlug={props.initialConnectionSlug}
        initialCreateProviderType={props.initialCreateProviderType}
        initialFocusRef={activeNavRef}
        onOpenDailyReview={props.onOpenDailyReview}
        onOpenKeyboardHelp={props.onOpenKeyboardHelp}
        onOpenSession={props.onOpenSession}
      />
    </div>
  );
}
