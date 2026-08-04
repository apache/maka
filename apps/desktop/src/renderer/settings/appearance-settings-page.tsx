import { useEffect, useRef, useState } from 'react';
import {
  Grid,
  HStack,
  SegmentedControl,
  SegmentedControlItem,
  SelectableCard,
  Text,
  VStack,
} from '@astryxdesign/core';
import { SettingsField, SettingsPage, SettingsRow, SettingsSection } from './settings-section';
import { SettingsExpandableRow } from './settings-expandable-row';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy';
import type {
  AppSettings,
  PersonalizationSettings,
  ThemePalette,
  ThemePreference,
  UiLocalePreference,
  UpdateAppSettingsResult,
} from '@maka/core';
import {
  TextArea,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

export function AppearanceSettingsPage(props: {
  themePref: ThemePreference;
  themePalette: ThemePalette;
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onThemeChange(pref: ThemePreference): void;
  onThemePaletteChange(palette: ThemePalette): void;
}) {
  return (
    <SettingsPage>
      {/* Designer audit P2-13: 显示名称/界面语言/语气偏好 are identity, not
          appearance — PersonalizationSettingsPage now renders on the 通用
          page. The duplicated 主题 section heading is gone too: the page IS
          the theme page now. */}
      <ThemeSettingsPage
        themePref={props.themePref}
        themePalette={props.themePalette}
        settings={props.settings}
        onUpdate={props.onUpdate}
        onThemeChange={props.onThemeChange}
        onThemePaletteChange={props.onThemePaletteChange}
      />
    </SettingsPage>
  );
}

// PR-TONE-AUTOSAVE-0: the personalization block used to be the page's ONLY
// control with an explicit 保存 button + helper line — every neighboring row
// (显示名称 / 界面语言 / 默认模型 / switches) persists silently on change or
// blur. Two save models on one page. This block now autosaves like its
// siblings: 显示名称 and 助手语气偏好 flush on blur (and the tone textarea
// also debounces mid-typing), 界面语言 persists on change. No button, no
// success toast — silence is the page's success language; only failures
// surface (toast.error, like every sibling persist path).

export function PersonalizationSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).personalization;
  const sections = getSettingsPreferencesCopy(locale).sections;
  const sharedCopy = getSettingsSharedCopy(locale);
  // At most one row in the group is open — the template's own rule.
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Persist the tone textarea this long after the user stops typing; blur
  // flushes immediately regardless.
  const TONE_AUTOSAVE_DEBOUNCE_MS = 800;
  const value = props.settings.personalization;
  const [displayName, setDisplayName] = useState(value.displayName);
  const [assistantTone, setAssistantTone] = useState(value.assistantTone);
  const [uiLocale, setUiLocale] = useState<UiLocalePreference>(value.uiLocale);
  const toast = useToast();
  const personalizationMountedRef = useMountedRef();
  // The shared ticket limits stale failure feedback. Locale reconciliation
  // has separate ownership because a later display-name or tone save must not
  // suppress rollback of a failed language preference.
  const persistTicketRef = useRef(0);
  const localePersistTicketRef = useRef(0);
  const persistPendingCountRef = useRef(0);
  // Debounce timer for the tone textarea; flushed immediately on blur.
  const toneDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      // Invalidate any in-flight save's late UI write, and drop the pending
      // debounced flush so it can't fire after the panel closes.
      persistTicketRef.current += 1;
      localePersistTicketRef.current += 1;
      if (toneDebounceRef.current) {
        clearTimeout(toneDebounceRef.current);
        toneDebounceRef.current = null;
      }
    };
  }, []);

  // PR-PERSONALIZATION-SYNC-0: sync form state when the persisted
  // personalization changes externally. Two real scenarios:
  //   1. Server-side sanitization (control chars, secret-shaped
  //      patterns) rewrites the input on save — local state would
  //      otherwise keep showing the raw typed value while the
  //      persisted store has the sanitized version.
  //   2. Another agent / background sync mutates settings while the
  //      panel is open.
  // Guarded on the pending-save count so an autosave that's still in
  // flight doesn't get its optimistic local value reset out from under
  // the user mid-edit — the sync only lands when nothing is in flight.
  useEffect(() => {
    if (persistPendingCountRef.current > 0) return;
    setDisplayName(value.displayName);
    setAssistantTone(value.assistantTone);
    setUiLocale(value.uiLocale);
  }, [value.displayName, value.assistantTone, value.uiLocale]);

  // Shared persist path for every personalization field. Locale has its own
  // last-write-wins lane so unrelated saves cannot steal rollback ownership.
  // Returns whether the write landed. The autosaving fields ignore it — they
  // have nowhere to put the answer — but a row that closes on save has to
  // know, or a failed write collapses the row onto the old value and drops
  // the draft with only a toast to show for it.
  async function persistPersonalization(patch: Partial<PersonalizationSettings>): Promise<boolean> {
    const ticket = ++persistTicketRef.current;
    const localeTicket = patch.uiLocale === undefined ? null : ++localePersistTicketRef.current;
    persistPendingCountRef.current += 1;
    try {
      const result = await props.onUpdate({ personalization: patch });
      // Saved. An unmounted page just has nowhere left to reflect it.
      if (!personalizationMountedRef.current) return true;
      if (localeTicket !== null && localeTicket === localePersistTicketRef.current) {
        setUiLocale(result.settings.personalization.uiLocale);
      }
      return true;
    } catch (error) {
      if (!personalizationMountedRef.current) return false;
      if (localeTicket !== null && localeTicket === localePersistTicketRef.current) {
        setUiLocale(value.uiLocale);
      }
      if (ticket === persistTicketRef.current) {
        toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale));
      }
      return false;
    } finally {
      persistPendingCountRef.current = Math.max(0, persistPendingCountRef.current - 1);
    }
  }

  function persistLocale(next: UiLocalePreference) {
    setUiLocale(next);
    void persistPersonalization({ uiLocale: next });
  }

  // Tone autosave: debounce mid-typing so we don't hammer settings.update on
  // every keystroke, then flush the pending value immediately on blur (blur
  // wins — clears the timer and saves right away).
  function scheduleToneSave(nextValue: string) {
    if (toneDebounceRef.current) clearTimeout(toneDebounceRef.current);
    toneDebounceRef.current = setTimeout(() => {
      toneDebounceRef.current = null;
      void persistPersonalization({ assistantTone: nextValue.trim().slice(0, 500) });
    }, TONE_AUTOSAVE_DEBOUNCE_MS);
  }

  function flushTone(nextValue: string) {
    if (toneDebounceRef.current) {
      clearTimeout(toneDebounceRef.current);
      toneDebounceRef.current = null;
    }
    void persistPersonalization({ assistantTone: nextValue.trim().slice(0, 500) });
  }

  return (
    <SettingsPage>
      {/* These editable values stay in the same grouped Settings card as the
          neighboring preferences; the full-width tone field uses the vertical
          row variant. */}
      <SettingsSection title={sections.identity} description={sections.identityHelp}>
        {/* A name you set once and then read. A permanently-open input asked
            the user to fill in something already filled in, and its blur-save
            gave them no way to back out of a change. The row reports the
            settled value and opens on demand; Cancel puts the draft back. */}
        <SettingsExpandableRow
          label={copy.displayName}
          value={value.displayName || copy.displayNameUnset}
          actionLabel={value.displayName ? copy.displayNameChange : copy.displayNameSet}
          isEditing={expandedRow === 'displayName'}
          canSave={displayName.trim() !== value.displayName}
          saveLabel={sharedCopy.save}
          cancelLabel={sharedCopy.cancel}
          onEdit={() => {
            setDisplayName(value.displayName);
            setExpandedRow('displayName');
          }}
          onCancel={() => {
            setDisplayName(value.displayName);
            setExpandedRow(null);
          }}
          onSave={async () => {
            // Only close on a write that landed: a failed save leaves the row
            // open with the draft intact, which is the promise explicit saving
            // makes and blur-autosave could not keep.
            if (await persistPersonalization({ displayName: displayName.trim().slice(0, 60) })) {
              setExpandedRow(null);
            }
          }}
        >
          <TextInput
            type="text"
            value={displayName}
            onChange={(value) => setDisplayName(value.slice(0, 60))}
            placeholder={copy.displayNamePlaceholder}
            label={copy.displayName}
            description={copy.displayNameHelp}
            isLabelHidden
            width="100%"
          />
        </SettingsExpandableRow>

        {/*
          PR-LANG-PREF-0 (WAWQAQ msg `edc9cb41` + kenji `7e532892`
          acceptance criteria): 自动 / 中文 / English. User explicit
          choice wins over the temporary auto -> zh fallback;
          e2e-fixture override wins over both (deterministic baselines).
        */}
        <SettingsRow
          label={copy.interfaceLanguage}
          description={copy.interfaceLanguageHelp}
          end={<SegmentedControl
            value={uiLocale}
            onChange={(next) => persistLocale(next as UiLocalePreference)}
            label={copy.interfaceLanguage}
          >
            {copy.localeOptions.map(([value, label]) => (
              <SegmentedControlItem key={value} value={value} label={label} />
            ))}
          </SegmentedControl>}
        />

        <SettingsField>
          <TextArea
            value={assistantTone}
            onChange={(value) => {
              const next = value.slice(0, 500);
              setAssistantTone(next);
              scheduleToneSave(next);
            }}
            onBlur={() => flushTone(assistantTone)}
            placeholder={copy.assistantTonePlaceholder}
            rows={4}
            hasSpellCheck={false}
            label={copy.assistantTone}
            description={copy.assistantToneHelp}
            width="100%"
            style={{
              boxSizing: 'border-box',
              height: 'calc(var(--space-16) + var(--space-5))',
            }}
          />
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}

/**
 * Mini chat-surface mockup rendered inside each theme radio tile. Replaces
 * the generic gradient swatch with a representative preview so the user
 * can see roughly what light vs dark looks like before clicking. The mock
 * uses hardcoded color values per variant (deliberately not tokenized) so
 * the preview tiles don't all shift to match the *currently active* theme
 * — that would defeat the comparison.
 *
 * Per @kenji's PR79 review: preview is purely visual; click commits. We
 * deliberately do not do a "hover to apply globally" flow because it
 * makes Settings feel like it's mutating state on idle pointer movement.
 */
function ThemePreviewMock(props: { variant: ThemePreference }) {
  if (props.variant === 'auto') {
    return (
      <div className="settingsThemePreview settingsThemePreviewSplit" aria-hidden="true">
        <ThemePreviewPane mode="light" />
        <ThemePreviewPane mode="dark" />
      </div>
    );
  }
  return (
    <div className="settingsThemePreview" aria-hidden="true">
      <ThemePreviewPane mode={props.variant} />
    </div>
  );
}

function ThemePreviewPane(props: { mode: 'light' | 'dark' }) {
  return (
    <div className="settingsThemePreviewPane" data-mode={props.mode}>
      <div className="settingsThemePreviewSidebar" />
      <div className="settingsThemePreviewChat">
        <div className="settingsThemePreviewLine settingsThemePreviewLine-assistant" />
        <div className="settingsThemePreviewLine settingsThemePreviewLine-assistant settingsThemePreviewLine-short" />
        <div className="settingsThemePreviewBubble" />
      </div>
    </div>
  );
}

// PR-THEME-PRODUCT-PALETTES-0: user-facing labels + short description
// for each palette. Kept inline (not in i18n strings) so the picker
// label and accessibility text live next to the palette token.
/**
 * PR-PALETTE-PICKER-GROUPS-0: 11 palettes need grouping so the
 * picker scans cleanly. `default` + the 4 community editor themes
 * land in 编辑器主题; the 6 color-family product accents land in
 * 产品色调. Order within each group is preserved for stable
 * keyboard navigation.
 */
const PALETTE_GROUPS: ReadonlyArray<{ id: 'editor' | 'product'; palettes: ReadonlyArray<ThemePalette> }> = [
  { id: 'editor', palettes: ['default', 'onedark', 'catppuccin-mocha', 'tokyo-night', 'nord'] },
  { id: 'product', palettes: ['coral', 'azure', 'forest', 'dusk', 'sand', 'mono'] },
];

function ThemeSettingsPage(props: {
  themePref: ThemePreference;
  themePalette: ThemePalette;
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onThemeChange(pref: ThemePreference): void;
  onThemePaletteChange(palette: ThemePalette): void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).appearance;
  const sections = getSettingsPreferencesCopy(locale).sections;
  const toast = useToast();
  const themePageMountedRef = useMountedRef();
  const themePersistTicketRef = useRef(0);

  useEffect(() => {
    return () => {
      themePersistTicketRef.current += 1;
    };
  }, []);

  async function persistAppearance(patch: NonNullable<Parameters<typeof window.maka.settings.update>[0]['appearance']>) {
    const ticket = ++themePersistTicketRef.current;
    try {
      await props.onUpdate({ appearance: patch });
    } catch (error) {
      if (themePageMountedRef.current && ticket === themePersistTicketRef.current) {
        toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale));
      }
    }
  }

  async function setTheme(next: ThemePreference) {
    // Apply immediately for instant feedback, then persist. If persistence
    // fails the visual stays — the next app start will re-read whatever
    // landed on disk.
    props.onThemeChange(next);
    await persistAppearance({ theme: next });
  }

  // PR-THEME-PRODUCT-PALETTES-0 (WAWQAQ msg `4472ee95`) + PR-THEME-APPLY-
  // AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): apply the palette
  // synchronously on click for instant feedback, then persist. Same
  // pattern as setTheme above. The original comment claimed
  // the IPC round-trip would re-apply on its own, but main.tsx had no
  // listener for palette changes — only ran applyThemePalette once at
  // mount — so switches were invisible until the next app start.
  const currentPalette: ThemePalette = props.themePalette;
  async function setPalette(next: ThemePalette) {
    props.onThemePaletteChange(next);
    await persistAppearance({ palette: next });
  }

  return (
    <SettingsPage>
      {/* Both option grids are Astryx `Grid` + `SelectableCard`. SelectableCard
          is documented for exactly this ("plan pickers, filter chips, or option
          grids") and already owns the surface, the hover / pressed / focus
          states, and the inset accent selection ring — which reads Maka's
          palette through the --color-accent bridge in maka-tokens.css. It also
          carries a visually-hidden checkbox for the accessible name and state,
          so the group needs no RadioList wrapper.

          This replaces a RadioList whose items were re-skinned into cards by
          hand-written CSS: a border/radius/background recipe, a hover rule, a
          `:has(input:checked)` selected rule, and a stretched `label::after`
          overlay to make the tile clickable. All four are the library's job. */}
      <SettingsSection variant="bare" title={sections.theme} description={sections.themeHelp}>
        <Grid columns={{ minWidth: 180 }} gap={2}>
          {(Object.entries(copy.themeOptions) as Array<[ThemePreference, { label: string; help: string }]>).map(([value, option]) => (
            <SelectableCard
              key={value}
              label={option.label}
              isSelected={props.themePref === value}
              onChange={() => void setTheme(value)}
              padding={2}
            >
              <VStack gap={2}>
                <ThemePreviewMock variant={value} />
                <VStack gap={0}>
                  <Text type="label" size="sm">{option.label}</Text>
                  <Text type="supporting" size="sm" color="secondary">{option.help}</Text>
                </VStack>
              </VStack>
            </SelectableCard>
          ))}
        </Grid>
      </SettingsSection>

      {/* persistenceHelp used to trail the page as a loose <p> with no owner.
          It describes when a palette change lands, so it is the palette
          group's description. */}
      <SettingsSection
        variant="bare"
        title={sections.palette}
        description={copy.persistenceHelp}
      >
        {PALETTE_GROUPS.map((group) => (
          <VStack key={group.id} gap={1.5}>
            <Text type="supporting" size="sm" color="secondary" weight="medium">
              {copy.paletteGroups[group.id]}
            </Text>
            <Grid columns={{ minWidth: 180 }} gap={2}>
              {group.palettes.map((palette) => (
                <SelectableCard
                  key={palette}
                  label={copy.paletteLabels[palette]}
                  isSelected={currentPalette === palette}
                  onChange={() => void setPalette(palette)}
                  padding={2}
                >
                  <HStack gap={2} align="center">
                    <span
                      className={`settingsPaletteSwatch settingsPaletteSwatch-${palette}`}
                      aria-hidden="true"
                    />
                    <VStack gap={0}>
                      <Text type="label" size="sm">{copy.paletteLabels[palette]}</Text>
                      <Text type="supporting" size="sm" color="secondary">{copy.paletteHelp[palette]}</Text>
                    </VStack>
                  </HStack>
                </SelectableCard>
              ))}
            </Grid>
          </VStack>
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
