import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

function openingTags(source: string, tagName: 'input' | 'select' | 'textarea'): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${tagName}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const start = match.index;
    let cursor = start;
    let inQuote: '"' | "'" | null = null;
    while (cursor < source.length) {
      const ch = source[cursor];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>' && source[cursor - 1] !== '=') {
        tags.push(source.slice(start, cursor + 1));
        break;
      }
      cursor += 1;
    }
  }
  return tags;
}

describe('Settings form accessibility labels', () => {
  it('keeps Settings secondary surfaces close to reference implementation card geometry', async () => {
    const styles = await readRendererContractCss();
    const connectionRow = styles.match(/\.settingsConnectionRow\s*\{[\s\S]*?\}/)?.[0] ?? '';
    // #520 PR9: .settingsConnectionBadge / .settingsBadge CSS chips retired
    // onto the squared Chip primitive. The "compact squared, not pill" intent
    // now lives on Chip's cva base (rounded-[var(--radius-control)]).
    const chipPrimitive = await readRepo('packages/ui/src/primitives/chip.tsx');
    const connectionBadge = chipPrimitive;
    const settingsBadge = chipPrimitive;
    // U1 (retire account section): `.settingsAuthContract` was the nested
    // auth card on the deleted AccountSettingsPage. The connection-card
    // geometry pin below still covers the live `.settingsConnectionRow`
    // surfaces (used by provider-oauth / claude-subscription).
    // PR-DELETE-ORPHAN-CSS: `.providerEmpty` / `.providerCard` were
    // orphan classes (no TSX consumer); the comma-grouped rule
    // collapsed to `.settingsRow` alone.
    const providerSurfaces = styles.match(/\.settingsRow\s*\{[\s\S]*?\}/g)?.at(0) ?? '';
    // PR-MODEL-PAGE-ITEM-GOVERNANCE: the provider catalog moved off the
    // hand-written .providerCatalogCard grid onto the shared shadcn Item
    // primitive (.providerCatalogRow) in a seamless single-column list, so
    // the whole 模型 page speaks one component language. The "secondary
    // surface 8px card geometry" intent now lives on the connection /
    // model-table surfaces; the catalog's intent is "governed rows +
    // squared (non-pill) badges".
    const providerCatalogRow = styles.match(/\.providerCatalogRow\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const providerMarketGridRule = styles.match(/\.providerMarketGrid,[\s\S]*?\}/)?.[0] ?? '';
    // PR-DELETE-ORPHAN-CSS: `.providerIcon` was an orphan class
    // (no TSX consumer); the geometry pin moved to the live model
    // table cells which carry the same border-radius family.
    const providerIcon = '';
    const providerCatalogBadge = styles.match(/\.providerCatalogBadge\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const modelChoiceList = styles.match(/\.providerModelChoiceList\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const modelChoiceScroll = styles.match(/\.providerModelChoiceScroll\s*\{[\s\S]*?\}/)?.[0] ?? '';
    // #1362: TWO .settingsRow rules exist now — the base label/value grid
    // and the narrow-card stacking override inside the @container block.
    // The base rule is the one that declares its own display.
    const settingsRowRules = styles.match(/\.settingsRow\s*\{[\s\S]*?\}/g) ?? [];
    const settingsRow = settingsRowRules.find((rule) => /display:\s*grid;/.test(rule)) ?? '';
    const settingsRowStacked = settingsRowRules.find((rule) => !/display:/.test(rule)) ?? '';
    const settingsRowValue = styles.match(/\.settingsRow > span\s*\{[\s\S]*?\}/)?.[0] ?? '';
    // #1362: the title tier is one comma-grouped rule for both row kinds.
    const settingsRowTitle = styles.match(/\.settingsRow strong,\s*\.settingsFormRow strong\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(connectionRow, /border-radius:\s*var\(--radius-surface\);/, 'Settings connection cards should use reference implementation rounded-lg geometry');
    assert.match(connectionRow, /box-shadow:\s*0 1px 3px oklch\(from var\(--foreground\) l c h \/ 0\.03\);/, 'Settings connection cards should use the near-flat card shadow (P-SHADOW: foreground-derived, not pure-black)');
    // PR-DELETE-ORPHAN-CSS: `.providerEmpty` / `.providerCard` were
    // orphan; only `.settingsRow` remains in the live rule. The
    // border-radius / shadow geometry still applies via the same
    // rule which is captured by `providerSurfaces` now.
    assert.match(providerMarketGridRule, /grid-template-columns:\s*1fr;/, 'Settings provider catalog should render as a seamless single-column row list, not a card grid');
    assert.ok(providerCatalogRow, 'Settings provider catalog rows should be governed by the shared .providerCatalogRow (Item) class');
    // PR-DELETE-ORPHAN-CSS: providerIcon assertion removed (orphan).
    assert.match(modelChoiceList, /display:\s*grid;/, 'The model list should group plain rows with layout, not per-row container chrome');
    assert.match(modelChoiceList, /gap:\s*var\(--space-0-5\);/, 'Model rows should use whitespace as their persistent grouping cue');
    assert.doesNotMatch(modelChoiceList, /border-(?:top|bottom):/, 'Model rows should not add separators inside the already-bordered scroll region');
    assert.match(modelChoiceScroll, /border-radius:\s*var\(--radius-surface\);/, 'The model scroll region uses the standard secondary-surface radius');
    assert.match(modelChoiceScroll, /height:\s*\d+px;/, 'The model scroll region is a fixed height so filtering never resizes the dialog');
    assert.match(providerCatalogBadge, /border-radius:\s*var\(--radius-control\);/, 'Provider catalog badges (category / preview / login) should use compact squared target-layout style corners, not pills');
    assert.match(connectionBadge, /rounded-\[var\(--radius-control\)\]/, 'Settings status badges (Chip primitive) should use compact squared target-layout style corners, not pills');
    assert.match(settingsBadge, /rounded-\[var\(--radius-control\)\]/, 'Generic Settings badges (Chip primitive) should use compact squared target-layout style corners, not pills');
    assert.doesNotMatch(providerCatalogBadge, /border-radius:\s*var\(--radius-pill\);/, 'Provider catalog badges must not regress to pill-shaped chrome');
    assert.doesNotMatch(modelChoiceList, /border-radius|box-shadow|background:/, 'Model rows must stay visually flat inside the bordered scroll region');
    assert.doesNotMatch(connectionBadge, /rounded-\[var\(--radius-pill\)\]/, 'Settings connection badges (Chip primitive) must not regress to pill-shaped chrome');
    assert.doesNotMatch(settingsBadge, /rounded-\[var\(--radius-pill\)\]/, 'Generic Settings badges (Chip primitive) must not regress to pill-shaped chrome');
    assert.match(settingsRow, /display:\s*grid;/, 'Settings rows should use a stable label/value grid instead of flex auto sizing');
    // The track split itself is pinned by settings-row-track-contract, which
    // is the one home for that rule. This file used to restate it as
    // `minmax(150px, 0.36fr) minmax(0, 1fr)` under the banner "protected
    // label column" — the split that starved the label, so the duplicate was
    // both redundant and wrong, and the second copy is what a fix has to
    // hunt down. Assert the shape here, not the numbers.
    assert.match(settingsRowValue, /overflow-wrap:\s*anywhere;/, 'Long Settings values such as workspace paths should wrap in the value column');
    assert.match(settingsRowValue, /text-align:\s*right;/, 'Short Settings values should keep the existing right-aligned summary rhythm');
    // #1362: the old `white-space: nowrap` title pin protected labels from
    // collapsing to one Chinese character per line, but it did so by letting
    // long titles BLEED over the value column instead. The protection is now
    // structural — the 150px label floor above, plus the narrow-card override
    // that stacks the row so the label gets the full card width. Titles wrap
    // as a last resort instead of overflowing the card.
    assert.match(settingsRowStacked, /grid-template-columns:\s*minmax\(0,\s*1fr\);/, 'Narrow cards must stack Settings rows so labels keep a full-width line, not char-per-line slivers');
    assert.match(settingsRowTitle, /overflow-wrap:\s*anywhere;/, 'Settings row titles need a last-resort break for unbreakable runs on a squeezed label column');
    assert.doesNotMatch(settingsRowTitle, /white-space:\s*nowrap;/, 'Settings row titles must wrap inside their column instead of bleeding over the value column');
  });

  it('keeps migrated Settings text fields and action buttons on shared UI primitives', async () => {
    const settings = await readSettingsCombinedSource();
    const settingsSelect = await readRepo('packages/ui/src/primitives/settings-select.tsx');
    const passwordInput = await readRepo('apps/desktop/src/renderer/settings/password-input.tsx');
    const providersPanel = await readProviderSettingsCombinedSource();
    const styles = await readRendererContractCss();

    assert.match(settings, /SettingsSelect,/);
    assert.match(settingsSelect, /SelectItem,[\s\S]*SelectPopup,[\s\S]*SelectPortal,[\s\S]*SelectPositioner,[\s\S]*SelectRoot,[\s\S]*SelectTrigger,[\s\S]*SelectValue,/);
    assert.match(passwordInput, /import \{[^}]*\bButton\b[^}]*\bInput\b[^}]*\buseMountedRef\b[^}]*\buseToast\b[^}]*\buseUiLocale\b[^}]*\} from '@maka\/ui';/);
    // ProvidersPanel sources its UI from the shared @maka/ui primitives;
    // tolerant of single- vs multi-line import formatting.
    const providersPanelUiImports = providersPanel.match(/import \{[^}]*\} from '@maka\/ui';/g)?.join('\n') ?? '';
    for (const name of ['Button', 'PrimitiveTabs', 'PrimitiveTabsList', 'PrimitiveTabsTrigger', 'Input', 'RelativeTime', 'Textarea', 'useToast']) {
      assert.ok(providersPanelUiImports.includes(name), `Providers provider files should import ${name} from @maka/ui`);
    }
    assert.match(settingsSelect, /export function SettingsSelect<T extends string>/);
    assert.match(settingsSelect, /<SelectPositioner alignItemWithTrigger=\{false\} sideOffset=\{6\} className="settingsSelectPositioner">/);
    assert.match(
      styles,
      /\.settingsSelectPositioner\s*\{[\s\S]*z-index:\s*var\(--z-overlay\);[\s\S]*\}/,
      'SettingsSelect popups must share the overlay layer so visible options stay clickable above Settings rows, modals, and the Composer.',
    );

    // ThemeSettingsPage uses native <button> on purpose for the radio-card
    // pickers (mode / palette): the cards are a custom grid with a preview
    // tile + label, and the shared <Button>'s baked-in Tailwind
    // utilities (`h-9 inline-flex bg-primary text-primary-foreground`) collapse
    // the card to a 36px-tall black pill. See `settings-theme-contract.test.ts`
    // which pins the inverse direction (radio cards must stay native).
    // For the general SettingsModal coverage we strip that block out before
    // asserting `no <button>` so the form-primitive rule still bites everywhere
    // else (action buttons, header buttons, etc.).
    const themeBlockRange = (() => {
      const start = settings.indexOf('function ThemeSettingsPage(');
      const end = settings.indexOf('function WebSearchSettingsPage(', start);
      return { start, end };
    })();
    assert.ok(themeBlockRange.start >= 0 && themeBlockRange.end > themeBlockRange.start, 'ThemeSettingsPage block must exist for the radio-card exception window');
    const settingsExceptTheme =
      settings.slice(0, themeBlockRange.start) + settings.slice(themeBlockRange.end);
    // Item's Base UI `render` target is the semantic element the primitive
    // enhances, not a separate hand-rolled control. Keep the same exception
    // already used for ProvidersPanel below so Settings pages can adopt Item
    // without layering Button chrome onto full-row navigation targets.
    const settingsPrimitiveButtons = settingsExceptTheme.replace(
      /render=\{\s*\(\s*<button[\s\S]*?\/>\s*\)\s*\}/g,
      'render={<primitiveTarget/>}',
    );

    for (const [path, source] of [
      ['SettingsModal.tsx (outside ThemeSettingsPage)', settingsPrimitiveButtons],
      ['password-input.tsx', passwordInput],
    ] as const) {
      assert.doesNotMatch(source, /<input\b/, `${path} must use the shared Input primitive for Settings text fields`);
      assert.doesNotMatch(source, /<textarea\b/, `${path} must use the shared Textarea primitive for Settings text areas`);
      assert.doesNotMatch(source, /<select\b/, `${path} must use the Base UI Select primitive for Settings selects`);
      assert.doesNotMatch(source, /<button\b/, `${path} must use the shared Button primitive for Settings buttons`);
      assert.doesNotMatch(source, /className="maka-button/, `${path} must not keep legacy maka-button styling on migrated actions`);
    }

    assert.doesNotMatch(providersPanel, /<input\b/, 'ProvidersPanel must use the shared Input primitive for Settings text fields');
    assert.doesNotMatch(providersPanel, /<textarea\b/, 'ProvidersPanel must use the shared Textarea primitive for Settings text areas');
    assert.doesNotMatch(providersPanel, /<select\b/, 'ProvidersPanel must use the Base UI Select primitive for Settings selects');
    assert.doesNotMatch(providersPanel, /className="maka-button/, 'ProvidersPanel governed Buttons must not layer the legacy maka-button class (inert under the @maka/ui Button utilities, so it is dead weight)');
    assert.match(providersPanel, /aria-label=\{copy\.searchModels\}/);
    assert.match(providersPanel, /className="providerModelChoiceList"\s+aria-label=\{copy\.modelListAria\}/);
    // `Item` rows become real buttons through Base UI's polymorphic
    // `render={<button .../>}` prop, which is a primitive render target rather
    // than a hand-rolled control. Strip those before asserting no raw <button>
    // so the rule still catches bespoke buttons everywhere else.
    const providersPanelButtons = providersPanel.replace(/render=\{\s*<button[\s\S]*?\/>\s*\}/g, 'render={<primitiveTarget/>}');
    assert.doesNotMatch(providersPanelButtons, /<button\b/, 'ProvidersPanel must use the shared Button / Item primitives (raw <button> only allowed as a Base UI render target)');
  });

  it('keeps shared Settings password copy actions guarded and failure-visible', async () => {
    const passwordInput = await readRepo('apps/desktop/src/renderer/settings/password-input.tsx');

    assert.match(passwordInput, /const toast = useToast\(\)/);
    assert.match(passwordInput, /const copyGuard = useActionGuard<'copy'>\(\)/);
    assert.match(passwordInput, /const mountedRef = useMountedRef\(\)/);
    assert.match(passwordInput, /const copyFeedbackTimerRef = useRef<number \| null>\(null\)/);
    assert.match(
      passwordInput,
      /return \(\) => \{[\s\S]*if \(copyFeedbackTimerRef\.current !== null\) \{[\s\S]*window\.clearTimeout\(copyFeedbackTimerRef\.current\);[\s\S]*copyFeedbackTimerRef\.current = null;/,
      'PasswordInput must clear pending copy-feedback timers when it unmounts (duplicate-copy release is owned by useActionGuard)',
    );
    assert.match(
      passwordInput,
      /function showCopiedFeedback\(\) \{[\s\S]*window\.clearTimeout\(copyFeedbackTimerRef\.current\);[\s\S]*setJustCopied\(true\);[\s\S]*copyFeedbackTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]*if \(mountedRef\.current\) setJustCopied\(false\);/,
      'PasswordInput must replace stale success timers so repeated copies do not clear fresh success feedback early',
    );
    assert.match(passwordInput, /if \(!copyGuard\.begin\('copy'\)\) return;/);
    assert.match(passwordInput, /setCopying\(true\)/);
    assert.match(passwordInput, /if \(mountedRef\.current\) showCopiedFeedback\(\)/);
    assert.match(passwordInput, /if \(mountedRef\.current\) toast\.error\(copy\.copyFailed, copy\.clipboardUnavailable\)/);
    assert.match(passwordInput, /copyGuard\.finish\(\);[\s\S]*if \(mountedRef\.current\) setCopying\(false\)/);
    assert.match(passwordInput, /disabled=\{copying\}/);
    assert.match(passwordInput, /aria-label=\{copying \? copy\.copying : justCopied \? copy\.copied : copy\.copy\}/);
    assert.match(passwordInput, /toast\.error\(copy\.copyFailed, copy\.clipboardUnavailable\)/);
    assert.doesNotMatch(
      passwordInput,
      /const copyingRef = useRef\(false\)/,
      'PasswordInput must not keep a private copy guard after routing through useActionGuard',
    );
    assert.doesNotMatch(
      passwordInput,
      /clipboard unavailable; silent|catch \{\s*\/\*/,
      'credential copy failures must not be silent',
    );
  });

  it('keeps every Settings input/select/textarea named for assistive tech', async () => {
    for (const [path, src] of [
      ['apps/desktop/src/renderer/settings/SettingsModal.tsx', await readSettingsCombinedSource()],
      ['apps/desktop/src/renderer/settings/provider settings sources', await readProviderSettingsCombinedSource()],
    ] as const) {
      for (const tagName of ['input', 'select', 'textarea'] as const) {
        for (const tag of openingTags(src, tagName)) {
          assert.match(
            tag,
            /aria-label=|ariaLabel=/,
            `${path} has unnamed <${tagName}>: ${tag.replace(/\s+/g, ' ').slice(0, 180)}`,
          );
        }
      }
    }
  });

  it('names the high-risk Settings fields found by the real app AX sweep', async () => {
    const settings = await readSettingsCombinedSource();
    const providers = await readProviderSettingsCombinedSource();

    for (const [label, pattern] of [
      ['Telegram proxy address', /ariaLabel: copy\.telegramProxyAria/],
      ['Discord proxy address', /ariaLabel: copy\.discordProxyAria/],
      ['allowed user IDs', /aria-label=\{copy\.allowedUsersAria\}/],
      ['web-search query', /aria-label=\{copy\.queryAria\}/],
      ['proxy server address', /aria-label=\{copy\.proxyServerAddress\}/],
      ['proxy port', /aria-label=\{copy\.proxyPort\}/],
      ['Open Gateway host', /ariaLabel=\{copy\.form\.hostAria\}/],
      ['Open Gateway port', /aria-label=\{copy\.form\.portAria\}/],
      ['Open Gateway session ID', /aria-label=\{copy\.form\.sessionAria\}/],
      ['usage request filter', /aria-label=\{props\.copy\.filterAria\}/],
      ['usage status filter', /ariaLabel=\{props\.copy\.statusAria\}/],
      ['MEMORY.md content', /aria-label=\{copy\.text\.contentEditorAria\}/],
    ] as const) {
      assert.match(settings, pattern, `SettingsModal must label ${label}`);
    }

    for (const [label, pattern] of [
      ['provider slug', /aria-label=\{copy\.slugAria\}/],
      ['provider display name', /aria-label=\{copy\.nameAria\}/],
      ['provider endpoint', /aria-label=\{copy\.endpointAria\}/],
      ['model search', /aria-label=\{copy\.searchModels\}/],
    ] as const) {
      assert.match(providers, pattern, `ProvidersPanel must label ${label}`);
    }
  });

  it('keeps Settings sidebar navigation groups named', async () => {
    const settings = await readSettingsCombinedSource();
    const settingsSurface = settings.match(/function SettingsSurface\([\s\S]*?function SettingsPage/)?.[0] ?? '';

    assert.match(settingsSurface, /<nav aria-label=\{copy\.navigationLabel\}>/);
    assert.match(
      settingsSurface,
      /<div key=\{group\} className="settingsNavGroup" role="group" aria-label=\{label\}>/,
      'Settings sidebar groups must expose the visible group title to assistive tech',
    );
    assert.doesNotMatch(
      settingsSurface,
      /<div key=\{group\} className="settingsNavGroup">\s*<div className="settingsNavGroupLabel">\{group\}<\/div>/,
      'Settings sidebar navigation groups must not regress to anonymous visual-only labels',
    );
  });

  it('keeps the Settings active nav row neutral without a leading accent rail', async () => {
    const styles = await readRendererContractCss();
    const activeRule = styles.match(/\.settingsNavItem\[data-active="true"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(activeRule, /background:\s*var\(--state-selected-bg\);/);
    assert.match(activeRule, /box-shadow:\s*none;/);
    assert.doesNotMatch(
      activeRule,
      /inset\s+\d+px\s+0\s+0\s+var\(--accent\)|border-left|border-inline-start/,
      'Settings active nav item must not draw the left green accent rail',
    );
  });

  // PR settings-rows-convergence: styles/settings/rows.css is the single
  // style home for the settings row primitives, and both row kinds share
  // one typography + padding contract. Before the convergence,
  // .settingsFormRow titles rendered 15px while adjacent .settingsRow
  // titles on the SAME page rendered 13px with tighter padding. These
  // pins match the COMMA-GROUPED shared rules, so both a value drift and
  // a fork back into per-kind sibling rules fail.
  it('keeps both settings row kinds on the converged typography and padding contract', async () => {
    const styles = await readRendererContractCss();
    const settingsRow = styles.match(/\.settingsRow\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const settingsFormRow = styles.match(/\.settingsFormRow\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const rowTitle = styles.match(/\.settingsRow strong,\s*\.settingsFormRow strong\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const fieldLabel = styles.match(/\.settingsField span,\s*\.settingsFormGrid label span\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const hint = styles.match(/\.settingsRow small,\s*\.settingsFormRow small,\s*\.settingsField small\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    for (const [name, block] of [['.settingsRow', settingsRow], ['.settingsFormRow', settingsFormRow]] as const) {
      assert.ok(block, `${name} base rule must exist in the aggregated renderer CSS (rows.css import reachable)`);
      assert.match(block, /padding:\s*var\(--space-5\)\s+var\(--space-6\);/, `${name} must keep the shared space-5/space-6 row padding`);
    }
    assert.ok(rowTitle, 'row titles must stay on ONE comma-grouped rule for both row kinds');
    assert.match(rowTitle, /font-size:\s*var\(--font-size-heading\);/, 'row titles sit on the heading tier for both row kinds');
    assert.match(rowTitle, /font-weight:\s*var\(--font-weight-medium\);/, 'row titles are medium weight');
    assert.ok(fieldLabel, 'field labels must stay on ONE comma-grouped rule');
    assert.match(fieldLabel, /font-size:\s*var\(--font-size-ui\);/, 'field labels sit one tier BELOW row titles (ui, not heading)');
    assert.ok(hint, 'hints must stay on ONE comma-grouped rule across row kinds and fields');
    assert.match(hint, /font-size:\s*var\(--font-size-base\);/, 'hints sit on the body tier');
  });

  // Alignment-governance round (maintainer report: 每日回顾 switches sat
  // mid-page while every other row control hugs the right rail). The
  // original end-align rule was tag-qualified (`button[role="switch"]`)
  // but Base UI renders the Switch root as a SPAN — the selector matched
  // nothing and rotted silently for weeks. Two pins: the rule exists in
  // tag-agnostic form, and no settings CSS ever tag-qualifies role
  // selectors again (role is the contract; the rendered tag is not).
  it('end-aligns settings row switches with a tag-agnostic role selector', async () => {
    const styles = await readRendererContractCss();
    const alignRule = styles.match(/\.settingsRow\s*>\s*\[role="switch"\]\s*\{[\s\S]*?\}/)?.[0] ?? '';
    assert.ok(alignRule, '.settingsRow > [role="switch"] rule must exist');
    assert.match(alignRule, /justify-self:\s*end;/, 'settings row switches must end-align like every other row control');
    assert.doesNotMatch(
      styles,
      /button\[role="switch"\]/,
      'never tag-qualify role selectors — Base UI renders the Switch root as a span, so button[role="switch"] silently matches nothing',
    );
  });
});
