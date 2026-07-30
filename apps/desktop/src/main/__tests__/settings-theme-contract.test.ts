import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings theme page contract', () => {
  it('keeps instant appearance preview but surfaces persistence failures', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/);

    assert.ok(themePage, 'Theme settings page block must exist');
    assert.match(
      themePage![0],
      /async function persistAppearance\(patch: NonNullable<Parameters<typeof window\.maka\.settings\.update>\[0\]\['appearance'\]>\)/,
      'Theme page must centralize appearance persistence',
    );
    assert.match(
      themePage![0],
      /const ticket = \+\+themePersistTicketRef\.current;[\s\S]*try \{[\s\S]*await props\.onUpdate\(\{ appearance: patch \}\)[\s\S]*catch \(error\) \{[\s\S]*if \(themePageMountedRef\.current && ticket === themePersistTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.saveFailed, settingsActionErrorMessage\(error, locale\)\)/,
      'Appearance persistence failures must show a user-visible toast only for the latest mounted request',
    );
    assert.match(
      themePage![0],
      /props\.onThemeChange\(next\);[\s\S]*await persistAppearance\(\{ theme: next \}\)/,
      'Theme changes must keep instant preview before persisting',
    );
    assert.match(
      themePage![0],
      /props\.onThemePaletteChange\(next\);[\s\S]*await persistAppearance\(\{ palette: next \}\)/,
      'Palette changes must keep instant preview before persisting',
    );
    assert.doesNotMatch(
      themePage![0],
      /await props\.onUpdate\(\{ appearance: \{ (theme|palette): next \} \}\)/,
      'Appearance controls must not call raw settings update without the fail-soft helper',
    );
  });

  it('drops stale or late theme persistence errors after newer choices or unmount', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';

    assert.match(
      themePage,
      /const themePageMountedRef = useMountedRef\(\);[\s\S]*const themePersistTicketRef = useRef\(0\);/,
      'Theme page must track mounted state and the newest persistence request',
    );
    assert.match(
      themePage,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*themePersistTicketRef\.current \+= 1;/,
      'Theme page cleanup must invalidate in-flight appearance persistence requests',
    );
    assert.match(
      themePage,
      /const ticket = \+\+themePersistTicketRef\.current;[\s\S]*catch \(error\) \{[\s\S]*if \(themePageMountedRef\.current && ticket === themePersistTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.saveFailed, settingsActionErrorMessage\(error, locale\)\);/,
      'Only the latest mounted theme persistence failure may show a toast',
    );
  });

  it('supports standard radiogroup keyboard navigation for appearance controls', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';

    // PR round-c-choice-card-primitive + PR yuejing/settings-segmented-
    // primitive: Theme/Palette via Base UI `RadioGroup`-backed
    // `ChoiceCardGroup`; Segmented via Base UI `ToggleGroup`-backed
    // `Segmented`. Both primitives provide arrow-key
    // navigation, focus management, and roving tabindex for free, so
    // the hand-rolled `onSettingsRadioGroupKeyDown` /
    // `focusRadioValue` / `radioTabIndex` helpers are gone from
    // SettingsModal.tsx. The provider connection dialog no longer
    // contains a hand-rolled default-model radiogroup.
    assert.doesNotMatch(src, /function onSettingsRadioGroupKeyDown/);
    assert.doesNotMatch(src, /function focusRadioValue/);
    assert.doesNotMatch(src, /function radioTabIndex/);
    assert.doesNotMatch(src, /import \{ nextRadioId \} from '\.\/model-table-keyboard'/);

    // Theme + palette pickers must use `ChoiceCardGroup` with
    // `value` + `onValueChange` semantics, NOT the legacy keyboard
    // helpers or `data-radio-value` attribute.
    assert.match(themePage, /<ChoiceCardGroup[\s\S]*aria-label=\{copy\.theme\}[\s\S]*value=\{props\.themePref\}[\s\S]*onValueChange/);
    assert.match(themePage, /<ChoiceCardGroup[\s\S]*aria-label=\{copy\.paletteGroups\[group\.id\]\}[\s\S]*value=\{currentPalette\}[\s\S]*onValueChange/);
    assert.doesNotMatch(themePage, /onSettingsRadioGroupKeyDown|radioTabIndex|data-radio-value/);
    assert.doesNotMatch(themePage, /界面密度|props\.density|setDensity|onDensityChange/);

    // Segmented now comes from `@maka/ui`. The local
    // `function Segmented` declaration must be gone.
    assert.match(src, /import \{[^}]*\bSegmented\b[^}]*\} from '@maka\/ui'/);
    assert.doesNotMatch(src, /^function Segmented</m);
  });

  it('uses the ChoiceCard primitive (not native <button> or shared <Button>) for theme + palette cards', async () => {
    // Regression history:
    //   1. Original `<Button>` migration (commit b40d097, WAWQAQ msg
    //      5f75daf6) baked `h-9 inline-flex bg-primary` utilities into
    //      the cards, collapsing each to a 36px black pill. Reverted
    //      to native `<button role="radio">` + manual keyboard nav.
    //   2. Round C (PR round-c-choice-card-primitive, WAWQAQ msg
    //      4f598b19) replaces the native `<button>` with a Base UI
    //      `Radio.Root`-backed `ChoiceCard` primitive. The primitive
    //      intentionally applies NO layout/background utilities so the
    //      existing `.settingsThemeOption*` chrome rules still own the
    //      visuals; the migration only moves semantics (data-checked,
    //      keyboard nav, focus) into Base UI.
    // This test pins step 2 and prevents regressing back to either
    // shared `<Button>` (which still has the 36px-pill problem) or
    // hand-rolled native `<button>` (which loses Base UI's keyboard
    // and focus contract).
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';
    const themePageNoComments = themePage
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const lcButtonCount = (themePageNoComments.match(/<button\b/g) ?? []).length;
    const ucButtonCount = (themePageNoComments.match(/<Button\b/g) ?? []).length;
    const choiceCardCount = (themePageNoComments.match(/<ChoiceCard\b/g) ?? []).length;
    const choiceCardGroupCount = (themePageNoComments.match(/<ChoiceCardGroup\b/g) ?? []).length;
    assert.equal(
      lcButtonCount,
      0,
      `Theme/palette cards must use the ChoiceCard primitive, not native <button> (found ${lcButtonCount} <button> occurrences in the page)`,
    );
    assert.equal(
      ucButtonCount,
      0,
      `Theme/palette cards must use the ChoiceCard primitive, not the shared <Button> (found ${ucButtonCount} <Button> occurrences — see the b40d097 regression note)`,
    );
    assert.equal(
      choiceCardCount,
      2,
      `Expected exactly 2 <ChoiceCard> elements (one per .map for theme + palette), found ${choiceCardCount}`,
    );
    assert.equal(
      choiceCardGroupCount,
      2,
      `Expected exactly 2 <ChoiceCardGroup> elements (theme group + palette group), found ${choiceCardGroupCount}`,
    );
    assert.match(themePage, /className="settingsThemeOption settingsThemeOptionPreview"/);
    assert.match(themePage, /className="settingsThemeOption settingsPaletteOption"/);
    assert.doesNotMatch(themePage, /界面密度|settingsDensitySwatch|setDensity/);
  });

  it('keeps theme page copy complete in both locales', () => {
    const zh = getSettingsPreferencesCopy('zh').appearance;
    const en = getSettingsPreferencesCopy('en').appearance;
    assert.match(zh.themeOptions.auto.help, /系统/);
    assert.match(zh.paletteHelp.default, /Maka 品牌蓝/);
    assert.match(zh.paletteHelp.azure, /湖蓝/);
    assert.match(zh.persistenceHelp, /保存在本地/);
    assert.equal(en.themeOptions.auto.label, 'Follow system');
    assert.equal(en.paletteLabels.azure, 'Azure');
    assert.doesNotMatch(JSON.stringify(en), /[\u3400-\u9fff]/u);
  });

  it('keeps shared Button chrome from collapsing theme choice cards', async () => {
    const css = await readRendererContractCss();

    assert.match(
      css,
      /\.settingsThemeOption \{[\s\S]*height:\s*auto;[\s\S]*min-height:\s*48px;[\s\S]*justify-content:\s*stretch;[\s\S]*overflow:\s*hidden;[\s\S]*white-space:\s*normal;/,
      'Theme option cards must reset shared Button defaults instead of inheriting h-9/centered chrome',
    );
    assert.match(
      css,
      /\.settingsThemeOptionPreview \{[\s\S]*align-items:\s*stretch;[\s\S]*min-height:\s*116px;/,
      'Theme preview cards must reserve enough vertical space for preview plus label',
    );
    assert.match(
      css,
      /\.settingsThemePreview \{[\s\S]*max-height:\s*70px;[\s\S]*aspect-ratio:\s*16 \/ 8;[\s\S]*overflow:\s*hidden;/,
      'Theme preview mocks must be bounded so they cannot cover visible labels',
    );
    assert.match(
      css,
      /\.settingsThemePreviewPane\[data-mode="light"\] \{[\s\S]*background:\s*oklch\(1\.000 0 0\);[\s\S]*color:\s*oklch\(0\.18 0 0\);/,
      'Light theme preview must show the target-layout style white content surface, not the old parchment hue',
    );
    assert.match(
      css,
      /\.settingsThemePreviewPane\[data-mode="light"\] \.settingsThemePreviewSidebar \{[\s\S]*background:\s*oklch\(0\.955 0 0\);/,
      'Light theme preview sidebar must show the gray shell backplate',
    );
    assert.doesNotMatch(
      css,
      /settingsThemePreviewPane[\s\S]{0,260}oklch\([^)]*75\)/,
      'Theme preview tiles must not keep the old warm parchment hue after the gray-shell baseline',
    );
    // #1362: palette names WRAP inside their cards instead of truncating —
    // at the 480px window floor the old nowrap+ellipsis cut "Catppuccin
    // Mocha" to "Catppucc…" with no way to recover the name. Scoped to the
    // rule body ([^}]*, not [\s\S]*): the previous pattern crossed the
    // closing brace and matched declarations in later, unrelated rules.
    assert.match(
      css,
      /\.settingsThemeLabel strong \{[^}]*overflow-wrap:\s*anywhere;/,
      'Long palette names must wrap inside their option cards',
    );
    assert.doesNotMatch(
      css,
      /\.settingsThemeLabel strong \{[^}]*text-overflow:\s*ellipsis;/,
      'Palette names must not regress to nowrap+ellipsis truncation (#1362)',
    );
  });
});
