import { useEffect, useRef, useState } from 'react';
import { SettingsRows } from './settings-rows';
import type {
  AppSettings,
  PersonalizationSettings,
  ThemePalette,
  ThemePreference,
  UiLocalePreference,
  UpdateAppSettingsResult,
} from '@maka/core';
import { Button, ChoiceCard, ChoiceCardGroup, Input, Segmented, Textarea, useMountedRef, useToast, useUiLocale } from '@maka/ui';
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
    <div className="settingsStructuredPage">
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
    </div>
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
  async function persistPersonalization(patch: Partial<PersonalizationSettings>) {
    const ticket = ++persistTicketRef.current;
    const localeTicket = patch.uiLocale === undefined ? null : ++localePersistTicketRef.current;
    persistPendingCountRef.current += 1;
    try {
      const result = await props.onUpdate({ personalization: patch });
      if (!personalizationMountedRef.current) return;
      if (localeTicket !== null && localeTicket === localePersistTicketRef.current) {
        setUiLocale(result.settings.personalization.uiLocale);
      }
    } catch (error) {
      if (!personalizationMountedRef.current) return;
      if (localeTicket !== null && localeTicket === localePersistTicketRef.current) {
        setUiLocale(value.uiLocale);
      }
      if (ticket === persistTicketRef.current) {
        toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      persistPendingCountRef.current = Math.max(0, persistPendingCountRef.current - 1);
    }
  }

  function flushDisplayName(nextValue: string) {
    void persistPersonalization({ displayName: nextValue.trim().slice(0, 60) });
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
    <div className="settingsStructuredPage">
      {/* Detail audit round 3: these rows used the borderless
          .settingsField language while every other 通用 row is a bordered
          SettingsRows card — two row systems on one page. Unified onto
          the card language; the full-width tone textarea uses the
          vertical row variant. */}
      <SettingsRows>
        <div className="settingsFormRow">
          <div>
            <strong>{copy.displayName}</strong>
            <small>{copy.displayNameHelp}</small>
          </div>
          <Input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            onBlur={(event) => flushDisplayName(event.currentTarget.value)}
            placeholder={copy.displayNamePlaceholder}
            maxLength={60}
            autoComplete="off"
            spellCheck={false}
            aria-label={copy.displayName}
          />
        </div>

        {/*
          PR-LANG-PREF-0 (WAWQAQ msg `edc9cb41` + kenji `7e532892`
          acceptance criteria): 自动 / 中文 / English. User explicit
          choice wins over the temporary auto -> zh fallback;
          e2e-fixture override wins over both (deterministic baselines).
        */}
        <div className="settingsFormRow">
          <div>
            <strong>{copy.interfaceLanguage}</strong>
            <small>{copy.interfaceLanguageHelp}</small>
          </div>
          <Segmented
            value={uiLocale}
            options={copy.localeOptions}
            onChange={(next) => persistLocale(next as UiLocalePreference)}
            ariaLabel={copy.interfaceLanguage}
          />
        </div>

        <div className="settingsFormRow" data-orient="vertical">
          <div>
            <strong>{copy.assistantTone}</strong>
            <small>{copy.assistantToneHelp}</small>
          </div>
          <Textarea
            value={assistantTone}
            onChange={(event) => {
              setAssistantTone(event.currentTarget.value);
              scheduleToneSave(event.currentTarget.value);
            }}
            onBlur={(event) => flushTone(event.currentTarget.value)}
            placeholder={copy.assistantTonePlaceholder}
            rows={4}
            maxLength={500}
            spellCheck={false}
            aria-label={copy.assistantTone}
            className="min-h-21 w-full"
          />
        </div>
      </SettingsRows>
    </div>
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

type SkinSnapshot = Awaited<ReturnType<typeof window.maka.skins.list>>;

function SkinSettingsSection() {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).appearance.skins;
  const toast = useToast();
  const mountedRef = useMountedRef();
  const [snapshot, setSnapshot] = useState<SkinSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.maka.skins.list()
      .then((next) => {
        if (mountedRef.current) setSnapshot(next);
      })
      .catch((error) => {
        if (mountedRef.current) toast.error(copy.actionFailed, settingsActionErrorMessage(error, locale));
      });
    return window.maka.skins.subscribeChanges((next) => {
      if (mountedRef.current) setSnapshot(next);
    });
  }, [copy.actionFailed, locale, mountedRef, toast]);

  async function run(action: () => Promise<SkinSnapshot | { snapshot: SkinSnapshot }>) {
    setBusy(true);
    try {
      const result = await action();
      if (!mountedRef.current) return;
      setSnapshot('snapshot' in result ? result.snapshot : result);
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.actionFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <>
      <h3 className="settingsSubheading">{copy.title}</h3>
      <SettingsRows>
        <div className="settingsFormRow" data-orient="vertical">
          <div>
            <strong>{copy.title}</strong>
            <small>{copy.help}</small>
          </div>
          <div className="settingsActionRow" role="group" aria-label={copy.title}>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => window.maka.skins.install())}>
              {copy.import}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void window.maka.skins.openFolder()}>
              {copy.openFolder}
            </Button>
            {snapshot?.activeSkinId ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => window.maka.skins.disable())}>
                {copy.disable}
              </Button>
            ) : null}
          </div>
        </div>
        {snapshot?.safeMode ? (
          <div className="settingsFormRow">
            <div><strong>{copy.safeMode}</strong></div>
          </div>
        ) : null}
        {snapshot?.lastError ? (
          <div className="settingsFormRow">
            <div>
              <strong>{copy.actionFailed}</strong>
              <small>{snapshot.lastError}</small>
            </div>
          </div>
        ) : null}
        {snapshot && snapshot.installed.length === 0 ? (
          <div className="settingsFormRow">
            <div><small>{copy.empty}</small></div>
          </div>
        ) : null}
        {snapshot?.installed.map(({ manifest, active }) => (
          <div className="settingsFormRow" key={manifest.id}>
            <div>
              <strong>{manifest.name}</strong>
              <small>
                {manifest.author ? `${manifest.author} · ` : ''}
                v{manifest.version}
                {active ? ` · ${copy.active}` : ''}
              </small>
            </div>
            {active ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => window.maka.skins.disable())}>
                {copy.disable}
              </Button>
            ) : (
              <Button type="button" variant="secondary" size="sm" disabled={busy || snapshot.safeMode} onClick={() => void run(() => window.maka.skins.activate(manifest.id))}>
                {copy.activate}
              </Button>
            )}
          </div>
        ))}
      </SettingsRows>
    </>
  );
}

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
    <div className="settingsStructuredPage">
      <h3 className="settingsSubheading">{copy.theme}</h3>
      <ChoiceCardGroup
        className="settingsThemeOptions settingsThemeOptionsPreview"
        aria-label={copy.theme}
        value={props.themePref}
        onValueChange={(next) => void setTheme(next as typeof props.themePref)}
      >
        {(Object.entries(copy.themeOptions) as Array<[ThemePreference, { label: string; help: string }]>).map(([value, option]) => (
          // Base UI Radio.Root via ChoiceCard primitive (Round C,
          // PR round-c-choice-card-primitive). Keyboard arrow nav,
          // focus management, and `data-checked` are owned by the
          // primitive; the card chrome stays in `.settingsThemeOption*`
          // CSS so the regression test that catches `<Button>` shrinking
          // the card to a 36px black pill is no longer needed.
          <ChoiceCard
            key={value}
            value={value}
            className="settingsThemeOption settingsThemeOptionPreview"
          >
            <ThemePreviewMock variant={value} />
            <span className="settingsThemeLabel">
              <strong>{option.label}</strong>
              <small>{option.help}</small>
            </span>
          </ChoiceCard>
        ))}
      </ChoiceCardGroup>

      <h3 className="settingsSubheading">{copy.palette}</h3>
      {/* PR-PALETTE-PICKER-GROUPS-0: 11 palettes in a flat grid is
          cramped. Split into 编辑器主题 (default + 4 community editor
          themes) and 产品色调 (6 product accents) so the picker is
          easier to scan. Each subgroup is its own radiogroup so
          arrow-key navigation stays scoped. */}
      {PALETTE_GROUPS.map((group) => (
        <div key={group.id} className="settingsPaletteGroup">
          <h4 className="settingsPaletteGroupHeading">{copy.paletteGroups[group.id]}</h4>
          <ChoiceCardGroup
            className="settingsThemeOptions settingsPaletteOptions"
            aria-label={copy.paletteGroups[group.id]}
            value={currentPalette}
            onValueChange={(next) => void setPalette(next as ThemePalette)}
          >
            {group.palettes.map((palette) => (
              <ChoiceCard
                key={palette}
                value={palette}
                data-palette={palette}
                className="settingsThemeOption settingsPaletteOption"
              >
                <span className={`settingsPaletteSwatch settingsPaletteSwatch-${palette}`} aria-hidden="true" />
                <span className="settingsThemeLabel">
                  <strong>{copy.paletteLabels[palette]}</strong>
                  <small>{copy.paletteHelp[palette]}</small>
                </span>
              </ChoiceCard>
            ))}
          </ChoiceCardGroup>
        </div>
      ))}

      <p className="settingsHelpText">
        {copy.persistenceHelp}
      </p>
      <SkinSettingsSection />
    </div>
  );
}
