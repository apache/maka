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
import { useEffect, useRef, useState } from 'react';
import { Button, Grid, HStack, SelectableCard, Text, VStack } from '@astryxdesign/core';
import { SettingsPage, SettingsSection } from './settings-section';
import {
  isAppIcon,
  type AppIcon,
  DEFAULT_APP_ICON_DARK,
  type AppIconChoice,
  type AppIconTarget,
  type ThemePalette,
  type ThemePreference,
  type UpdateAppSettingsResult,
} from '@maka/core/settings';
import { Switch, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import { CustomPetSettingsSection } from './custom-pet-settings-section.js';

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
/**
 * 40 shipped icons need grouping for the same reason 11 palettes did: an
 * ungrouped wall gives the eye nowhere to start. The brand pair leads;
 * everything after it is one drawing recoloured, split by what the colour is
 * doing. Imported art is appended as its own group by the renderer, since the
 * set is not known until the main process reads the directory.
 *
 * The order matches `APP_ICONS`, which follows the order the icon discussion
 * used — see the note there about why it is not one-to-one with its numbering.
 */
const APP_ICON_GROUPS: ReadonlyArray<{
  id:
    | 'mascot'
    | 'blue'
    | 'contrast'
    | 'pencil'
    | 'mountain'
    | 'dark'
    | 'neon'
    | 'muted'
    | 'warm'
    | 'nature'
    | 'metal'
    | 'highContrast';
  icons: ReadonlyArray<AppIcon>;
}> = [
  { id: 'mascot', icons: ['default', 'mono'] },
  { id: 'blue', icons: ['sky', 'cyan', 'ice', 'pale-inverted'] },
  { id: 'contrast', icons: ['ink', 'paper', 'graphite'] },
  { id: 'pencil', icons: ['pencil-kraft', 'pencil-sky', 'pencil-navy'] },
  { id: 'mountain', icons: ['alpine', 'dusk', 'night', 'forest'] },
  { id: 'dark', icons: ['midnight', 'carbon', 'slate', 'obsidian'] },
  { id: 'neon', icons: ['neon-cyan', 'matrix', 'magenta', 'amber-crt'] },
  { id: 'muted', icons: ['clay', 'sage', 'dust', 'fog'] },
  { id: 'warm', icons: ['sunset', 'amber', 'terracotta'] },
  { id: 'nature', icons: ['ocean', 'moss', 'desert', 'glacier'] },
  { id: 'metal', icons: ['gold', 'chrome'] },
  { id: 'highContrast', icons: ['mono-black', 'mono-white', 'hazard'] },
];

const PALETTE_GROUPS: ReadonlyArray<{ id: 'editor' | 'product'; palettes: ReadonlyArray<ThemePalette> }> = [
  { id: 'editor', palettes: ['default', 'onedark', 'catppuccin-mocha', 'tokyo-night', 'nord'] },
  { id: 'product', palettes: ['coral', 'azure', 'forest', 'dusk', 'sand', 'mono'] },
];

// The section headings and the palette sub-group labels are the page's only
// landmarks, so they carry stable ids: `SettingsSection` wires each
// `<section>` to its heading via aria-labelledby, and each option Grid is a
// `role="group"` named by the label above it. Without them the page hands a
// screen reader 14 loose option tiles with no statement of which set — 主题,
// 编辑器主题, or 产品色调 — any one of them belongs to.
const THEME_SECTION_HEADING_ID = 'settings-appearance-theme-heading';
const APP_ICON_SECTION_HEADING_ID = 'settings-appearance-app-icon-heading';
const PALETTE_SECTION_HEADING_ID = 'settings-appearance-palette-heading';
const paletteGroupLabelId = (group: 'editor' | 'product') => `settings-appearance-palette-${group}-label`;
const appIconGroupLabelId = (group: string) => `settings-appearance-app-icon-${group}-label`;

export function AppearanceSettingsPage(props: {
  themePref: ThemePreference;
  themePalette: ThemePalette;
  appIcon: AppIconChoice;
  /** Absent when one icon serves both appearances. */
  appIconDark?: AppIconChoice;
  /* No `settings` prop: the page reads theme and palette from the two
     dedicated props above and writes through `onUpdate`. It used to accept
     the whole AppSettings object and pass it down one level, where nothing
     ever read it. */
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
  // The picker draws real artwork, so the option set arrives from the main
  // process (ids plus thumbnails) rather than from a list held here: the icons
  // are 1024px masters that only main can read, and the renderer is never
  // handed a path. `undefined` is "still asking", not "none shipped".
  const [appIconOptions, setAppIconOptions] = useState<
    ReadonlyArray<{ id: AppIconChoice; dataUrl: string; removable?: boolean }> | undefined
  >(undefined);
  const [appIconLoadFailed, setAppIconLoadFailed] = useState(false);
  const [appIconBusy, setAppIconBusy] = useState(false);

  async function refreshAppIcons() {
    const options = await window.maka.app.iconPreviews().catch(() => undefined);
    if (options) setAppIconOptions(options);
  }

  async function importAppIcon() {
    setAppIconBusy(true);
    try {
      const result = await window.maka.app.importIcon();
      if (!result.ok) {
        // Closing the dialog is an answer, not a failure worth a toast.
        if (result.reason !== 'cancelled') toast.error(copy.appIconImportFailed[result.reason]);
        return;
      }
      await refreshAppIcons();
      // Imported art lands in whichever slot the picker is editing, the same
      // as clicking a tile — importing while on the dark slot and having it
      // silently replace the light icon would be the surprising reading.
      await setAppIcon(result.icon, appIconSplit ? appIconTarget : 'both');
    } catch (error) {
      // Reasons above describe the *file*; landing here instead means the call
      // itself failed — a stale preload bundle with no `importIcon` on the
      // bridge looks exactly like this — and calling that "unreadable image"
      // would send the user off inspecting a file that was never the problem.
      toast.error(copy.appIconImportError, settingsActionErrorMessage(error, locale));
    } finally {
      setAppIconBusy(false);
    }
  }

  async function removeAppIcon(icon: AppIconChoice) {
    setAppIconBusy(true);
    try {
      // The main process owns the pair: it resets the selection before the
      // file goes away, so there is no ordering for this side to get wrong.
      const result = await window.maka.app.removeIcon(icon);
      if (!result.ok) toast.error(copy.appIconRemoveFailed);
      // No second write from here: the main process already persisted the
      // reset, `settings:clientChanged` reloads this surface from it, and
      // writing again could stamp a stale value over a newer choice.
      await refreshAppIcons();
    } catch (error) {
      toast.error(copy.appIconRemoveFailed, settingsActionErrorMessage(error, locale));
    } finally {
      setAppIconBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void window.maka.app
      .iconPreviews()
      .then((options) => {
        if (!cancelled) setAppIconOptions(options);
      })
      .catch(() => {
        if (!cancelled) setAppIconLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  // No optimistic local copy, unlike theme and palette above: those two paint
  // the renderer, so a click has to show immediately. The app icon is an OS
  // surface applied by the main process, and the tile follows the settings
  // snapshot the write returns.
  // Which slot the grid is editing. Only meaningful while the two
  // appearances are split; the toggle below owns that.
  const [appIconTarget, setAppIconTarget] = useState<'light' | 'dark'>('light');
  const appIconSplit = props.appIconDark !== undefined;
  const editedAppIcon =
    appIconSplit && appIconTarget === 'dark' ? (props.appIconDark ?? props.appIcon) : props.appIcon;

  async function setAppIcon(next: AppIconChoice, target: AppIconTarget) {
    // Not `persistAppearance`: selection goes through the icon seam so it
    // queues behind import and removal in the main process. Writing it on the
    // generic settings channel is what let a selection land between a removal
    // resetting the setting and deleting the file.
    try {
      const result = await window.maka.app.selectIcon(next, target);
      if (!result.ok) toast.error(copy.appIconSelectFailed);
    } catch (error) {
      toast.error(copy.appIconSelectFailed, settingsActionErrorMessage(error, locale));
    }
  }

  // Turning the split on seeds the dark slot with the shipped dark
  // recommendation and moves the grid to it, so the user lands on a sensible
  // dark tile already selected rather than on a copy of the light one they
  // then have to change. Turning it off writes the light choice with `both`,
  // which clears the slot.
  async function setAppIconSplit(enabled: boolean) {
    if (enabled) {
      setAppIconTarget('dark');
      await setAppIcon(DEFAULT_APP_ICON_DARK, 'dark');
    } else {
      setAppIconTarget('light');
      await setAppIcon(props.appIcon, 'both');
    }
  }

  // Group membership is a renderer concern: the main process reports what
  // artwork loaded, and the grouping is how the picker chooses to read it.
  // Anything the main process reports that no group claims — imported art —
  // falls into the trailing group rather than disappearing.
  const appIconGroupsToRender = (() => {
    const byId = new Map((appIconOptions ?? []).map((option) => [option.id, option]));
    const claimed = new Set<string>();
    const groups = APP_ICON_GROUPS.map((group) => {
      const options = group.icons.flatMap((id) => {
        const option = byId.get(id);
        if (!option) return [];
        claimed.add(id);
        return [option];
      });
      return { id: group.id, options };
    }).filter((group) => group.options.length > 0);
    const imported = (appIconOptions ?? []).filter((option) => !claimed.has(option.id));
    return imported.length > 0
      ? [...groups, { id: 'custom' as const, options: imported }]
      : groups;
  })();

  function appIconLabel(id: AppIconChoice): string {
    return isAppIcon(id) ? copy.appIconLabels[id] : copy.appIconCustom;
  }

  function appIconHelpText(id: AppIconChoice): string {
    return isAppIcon(id) ? copy.appIconHelp[id] : copy.appIconCustomHelp;
  }

  const currentPalette: ThemePalette = props.themePalette;
  async function setPalette(next: ThemePalette) {
    props.onThemePaletteChange(next);
    await persistAppearance({ palette: next });
  }

  return (
    /* Designer audit P2-13: 显示名称/界面语言/语气偏好 are identity, not
       appearance — they render on the 通用 page (see
       personalization-settings-page.tsx). The page IS the theme page now, so
       it owns the one `SettingsPage` root directly; it used to wrap a second
       component that opened a `SettingsPage` of its own, nesting the page
       grid inside itself. */
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
      <SettingsSection
        variant="bare"
        titleId={THEME_SECTION_HEADING_ID}
        title={sections.theme}
        description={sections.themeHelp}
      >
        <Grid columns={{ minWidth: 180 }} gap={2} role="group" aria-labelledby={THEME_SECTION_HEADING_ID}>
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
                <VStack gap={0.5}>
                  <Text type="label" size="sm">{option.label}</Text>
                  <Text type="supporting" size="sm" color="secondary">{option.help}</Text>
                </VStack>
              </VStack>
            </SelectableCard>
          ))}
        </Grid>
      </SettingsSection>
      {/* The group description says what the palette governs AND when a switch
          lands, the same two things `sections.themeHelp` says for the section
          above — so both sections now take their lede from the same `sections`
          namespace instead of one reaching into `appearance` for a loose
          persistence line. */}
      <SettingsSection
        variant="bare"
        titleId={PALETTE_SECTION_HEADING_ID}
        title={sections.palette}
        description={sections.paletteHelp}
      >
        {PALETTE_GROUPS.map((group) => (
          <VStack key={group.id} gap={1.5}>
            <Text
              id={paletteGroupLabelId(group.id)}
              type="supporting"
              size="sm"
              color="secondary"
              weight="medium"
            >
              {copy.paletteGroups[group.id]}
            </Text>
            <Grid
              columns={{ minWidth: 180 }}
              gap={2}
              role="group"
              aria-labelledby={paletteGroupLabelId(group.id)}
            >
              {group.palettes.map((palette) => (
                <SelectableCard
                  key={palette}
                  label={copy.paletteLabels[palette]}
                  isSelected={currentPalette === palette}
                  onChange={() => void setPalette(palette)}
                  padding={2}
                >
                  <HStack gap={2} align="center" height="100%">
                    <span
                      className={`settingsPaletteSwatch settingsPaletteSwatch-${palette}`}
                      aria-hidden="true"
                    />
                    <VStack gap={0.5}>
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
      <SettingsSection
        variant="bare"
        titleId={APP_ICON_SECTION_HEADING_ID}
        title={sections.appIcon}
        description={sections.appIconHelp}
      >
        {appIconLoadFailed ? (
          <Text type="supporting" size="sm" color="secondary">{copy.appIconUnavailable}</Text>
        ) : (
          <VStack gap={3}>
            <HStack gap={2} align="center">
              <Switch
                label={copy.appIconSplitLabel}
                value={appIconSplit}
                isDisabled={appIconBusy}
                onChange={(enabled) => void setAppIconSplit(enabled)}
              />
              <Text type="supporting" size="sm" color="secondary">
                {copy.appIconSplitHelp}
              </Text>
            </HStack>
            {appIconSplit ? (
              /* Which slot the grid below edits. Two buttons rather than a
                 second grid: 43 tiles twice over is a wall, and the choice
                 being made is the same one either way. */
              <HStack gap={1} role="group" aria-label={copy.appIconSplitLabel}>
                {(['light', 'dark'] as const).map((target) => (
                  <Button
                    key={target}
                    size="sm"
                    variant={appIconTarget === target ? 'primary' : 'ghost'}
                    label={copy.appIconTargets[target]}
                    onClick={() => setAppIconTarget(target)}
                  />
                ))}
              </HStack>
            ) : null}
            {appIconGroupsToRender.map((group) => (
              <VStack key={group.id} gap={1.5}>
                <Text
                  id={appIconGroupLabelId(group.id)}
                  type="label"
                  size="sm"
                  color="secondary"
                  weight="medium"
                >
                  {copy.appIconGroups[group.id]}
                </Text>
                <Grid
                  columns={{ minWidth: 180 }}
                  gap={2}
                  role="group"
                  aria-labelledby={appIconGroupLabelId(group.id)}
                >
                  {group.options.map((option) => (
                    <SelectableCard
                      key={option.id}
                      label={appIconLabel(option.id)}
                      isSelected={editedAppIcon === option.id}
                      // Removal reads the current selection in the main
                      // process before it deletes. A click landing inside that
                      // window would persist the very icon being removed, so
                      // the whole set is fenced, not just the remove button.
                      isDisabled={appIconBusy}
                      onChange={() =>
                        void setAppIcon(option.id, appIconSplit ? appIconTarget : 'both')
                      }
                      padding={2}
                    >
                      <HStack gap={2} align="center" height="100%">
                        {/* Decorative: the tile's own label already names the icon. */}
                        <img className="settingsAppIconPreview" src={option.dataUrl} alt="" width={48} height={48} />
                        <VStack gap={0.5}>
                          <Text type="label" size="sm">{appIconLabel(option.id)}</Text>
                          <Text type="supporting" size="sm" color="secondary">
                            {appIconHelpText(option.id)}
                          </Text>
                        </VStack>
                        {option.removable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            isDisabled={appIconBusy}
                            label={copy.appIconRemove}
                            onClick={(event) => {
                              // The tile is a radio; deleting is not choosing it.
                              event.stopPropagation();
                              void removeAppIcon(option.id);
                            }}
                          />
                        ) : null}
                      </HStack>
                    </SelectableCard>
                  ))}
                </Grid>
              </VStack>
            ))}
            <HStack gap={2} align="center">
              <Button
                variant="secondary"
                isDisabled={appIconBusy}
                label={appIconBusy ? copy.appIconImporting : copy.appIconImport}
                onClick={() => void importAppIcon()}
              />
              <Text type="supporting" size="sm" color="secondary">{copy.appIconImportHelp}</Text>
            </HStack>
          </VStack>
        )}
      </SettingsSection>
      <CustomPetSettingsSection />
    </SettingsPage>
  );
}
