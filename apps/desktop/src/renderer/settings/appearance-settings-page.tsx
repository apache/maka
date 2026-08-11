import { useEffect, useRef } from 'react';
import { Grid, HStack, SelectableCard, Text, VStack } from '@astryxdesign/core';
import { SettingsPage, SettingsSection } from './settings-section';
import type { ThemePalette, ThemePreference, UpdateAppSettingsResult } from '@maka/core/settings';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';
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
const PALETTE_SECTION_HEADING_ID = 'settings-appearance-palette-heading';
const paletteGroupLabelId = (group: 'editor' | 'product') => `settings-appearance-palette-${group}-label`;

export function AppearanceSettingsPage(props: {
  themePref: ThemePreference;
  themePalette: ThemePalette;
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
                  <HStack gap={2} align="center">
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
      <CustomPetSettingsSection />
    </SettingsPage>
  );
}
