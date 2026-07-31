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

  it('uses Astryx radio selection without keeping retired keyboard helpers', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';

    assert.doesNotMatch(src, /function onSettingsRadioGroupKeyDown/);
    assert.doesNotMatch(src, /function focusRadioValue/);
    assert.doesNotMatch(src, /function radioTabIndex/);
    assert.doesNotMatch(src, /import \{ nextRadioId \} from '\.\/model-table-keyboard'/);

    assert.match(
      themePage,
      /<RadioList[\s\S]*label=\{copy\.theme\}[\s\S]*value=\{props\.themePref\}[\s\S]*onChange=\{\(value\) => void setTheme\(value as ThemePreference\)\}/,
    );
    assert.match(
      themePage,
      /<RadioList[\s\S]*label=\{copy\.palette\}[\s\S]*value=\{currentPalette\}[\s\S]*onChange=\{\(value\) => void setPalette\(value as ThemePalette\)\}/,
    );
    assert.doesNotMatch(themePage, /onSettingsRadioGroupKeyDown|radioTabIndex|data-radio-value/);
    assert.doesNotMatch(themePage, /role="group"|<SelectableCard/);
    assert.doesNotMatch(themePage, /界面密度|props\.density|setDensity|onDensityChange/);

    // Astryx owns the segmented-control structure and keyboard behavior.
    assert.match(src, /import \{[^}]*\bSegmentedControl\b[^}]*\} from '@astryxdesign\/core'/);
    assert.match(src, /<SegmentedControl[\s\S]*<SegmentedControlItem/);
    assert.doesNotMatch(src, /^function Segmented</m);
  });

  it('expresses preview-rich choices through RadioList public content slots', async () => {
    const src = await readSettingsCombinedSource();
    const themePage = src.match(/function ThemeSettingsPage\([\s\S]*?function WebSearchSettingsPage/)?.[0] ?? '';
    const themePageNoComments = themePage
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const lcButtonCount = (themePageNoComments.match(/<button\b/g) ?? []).length;
    const ucButtonCount = (themePageNoComments.match(/<Button\b/g) ?? []).length;
    const radioListCount = (themePageNoComments.match(/<RadioList\b/g) ?? []).length;
    const radioItemCount = (themePageNoComments.match(/<RadioListItem\b/g) ?? []).length;
    assert.equal(
      lcButtonCount,
      0,
      `Theme/palette choices must not use native <button> (found ${lcButtonCount})`,
    );
    assert.equal(
      ucButtonCount,
      0,
      `Theme/palette choices must not use shared <Button> (found ${ucButtonCount})`,
    );
    assert.equal(
      radioListCount,
      2,
      `Expected exactly 2 <RadioList> elements, found ${radioListCount}`,
    );
    assert.equal(
      radioItemCount,
      2,
      `Expected exactly 2 mapped <RadioListItem> elements, found ${radioItemCount}`,
    );
    assert.match(themePage, /startContent=\{<ThemePreviewMock variant=\{value\} \/>\}/);
    assert.match(themePage, /className=\{`settingsPaletteSwatch settingsPaletteSwatch-\$\{palette\}`\}/);
    assert.doesNotMatch(themePage, /settingsThemeOption(?:Copy|Preview)?\b/);
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

  it('keeps product preview content without restyling RadioListItem chrome', async () => {
    const css = await readRendererContractCss();

    assert.doesNotMatch(css, /\.settingsThemeOption(?:Copy|Preview)?\b/);
    assert.match(
      css,
      /\.settingsThemePreview \{[\s\S]*width:\s*88px;[\s\S]*height:\s*44px;[\s\S]*overflow:\s*hidden;/,
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
    assert.doesNotMatch(css, /\.astryx-(?:radio-list|radio-list-item)/);
  });
});
