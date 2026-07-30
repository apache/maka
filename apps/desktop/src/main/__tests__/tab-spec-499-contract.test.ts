import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  RENDERER_STYLES_DIR,
  STYLES_FILE,
  readCssTree,
  stripCssComments,
} from './css-test-helpers.js';

// Issue #499 P0-3 — tab component governance, now converged on Astryx.

const TABS_FILE = resolve(REPO_ROOT, 'packages/ui/src/primitives/tabs.tsx');
const PLAN_PANEL_FILE = resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx');
const PLAN_CSS_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles/module-pages/plan-reminders.css',
);
const PROVIDERS_PANEL_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/ProvidersPanel.tsx');
const MODELS_CSS_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/settings/models.css');
const PROVIDER_EDITOR_CSS_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles/settings/provider-editor.css',
);
const SKILLS_PANEL_FILE = resolve(REPO_ROOT, 'packages/ui/src/skills-panel.tsx');
const SKILLS_CSS_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/module-pages/skills.css');
const DAILY_REVIEW_PANEL_FILE = resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx');
const DAILY_REVIEW_CSS_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/daily-review.css');

describe('issue #499 P0-3 tab spec contract', () => {
  it('tabs delegate navigation to Astryx while preserving panel variants', async () => {
    const src = await readFile(TABS_FILE, 'utf8');
    assert.match(src, /from '@astryxdesign\/core\/TabList'/);
    assert.match(src, /'underline'/, 'TabsVariant must include underline');
    assert.match(src, /'pill'/, 'TabsVariant must include pill');
    assert.match(src, /export const TabsTab = AstryxTab/);
  });

  it('retires the old global maka-tab skin', async () => {
    const allCss = [...(await readCssTree(RENDERER_STYLES_DIR)), STYLES_FILE];
    const staleRules: string[] = [];
    for (const file of allCss) {
      const source = stripCssComments(await readFile(file, 'utf8'));
      for (const ruleMatch of source.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = ruleMatch[1]!;
        if (/\.maka-tab\b/.test(selector)) staleRules.push(`${file}: ${selector.trim()}`);
      }
    }
    assert.deepEqual(staleRules, [], `Astryx must be the only tab skin:\n${staleRules.join('\n')}`);
  });

  it('plan tabs consume Astryx + underline variant; no hand-written .maka-plan-tab active/under-bar CSS', async () => {
    const panel = await readFile(PLAN_PANEL_FILE, 'utf8');
    assert.match(
      panel,
      /TabsList[^>]*variant="underline"/,
      'plan TabsList must pass variant="underline"',
    );
    // Each plan tab value has a corresponding view panel.
    assert.match(
      panel,
      /TabsPanel[^>]*value="tasks"/,
      'plan must have a TabsPanel for the tasks view',
    );
    assert.match(
      panel,
      /TabsPanel[^>]*value="runs"/,
      'plan must have a TabsPanel for the runs view',
    );
    const css = stripCssComments(await readFile(PLAN_CSS_FILE, 'utf8'));
    // Astryx owns the active state and under-bar; surface layout may remain.
    assert.doesNotMatch(
      css,
      /\.maka-plan-tab\[data-state\s*=\s*"active"\]/,
      'plan hand-written [data-state="active"] selector must stay removed',
    );
    assert.doesNotMatch(
      css,
      /\.maka-plan-tab\[data-state\s*=\s*"active"\]::after/,
      'plan hand-written under-bar ::after must be removed',
    );
  });

  it('catalog tabs consume Astryx + pill variant + TabsPanel; no hand-written active/hover/indicator CSS', async () => {
    const panel = await readFile(PROVIDERS_PANEL_FILE, 'utf8');
    assert.match(
      panel,
      /PrimitiveTabsList[^>]*variant="pill"/,
      'catalog TabsList must pass variant="pill"',
    );
    // The active category owns one panel so hidden tabs do not mount duplicate
    // OAuth controllers or run background account probes.
    assert.match(
      panel,
      /<PrimitiveTabsPanel value=\{catalogCategory\}>/,
      'catalog must bind its single mounted panel to the active category',
    );
    assert.match(
      panel,
      /const CATALOG_TABS: CatalogCategory\[\] = \['recommended', 'accounts', 'plans', 'api', 'aggregators', 'local'\]/,
      'catalog categories must cover recommended / plans / api / aggregators / local',
    );
    // Astryx owns active state; data-catalog-tab remains an identifier.
    assert.doesNotMatch(
      panel,
      /data-active=\{catalogCategory === tab\.id\}/,
      'catalog hand-written data-active must stay removed',
    );
    assert.match(
      panel,
      /data-catalog-tab=\{tab\}/,
      'data-catalog-tab={tab} must stay (tab identifier used by model-oauth contract)',
    );

    const modelsCss = stripCssComments(await readFile(MODELS_CSS_FILE, 'utf8'));
    assert.doesNotMatch(
      modelsCss,
      /\.catalogPillTabs button\[data-active/,
      'catalog hand-written .catalogPillTabs button[data-active] must stay removed',
    );
    assert.doesNotMatch(
      modelsCss,
      /\.catalogPillTabs button:hover/,
      'catalog hand-written .catalogPillTabs button:hover must stay removed',
    );
    assert.doesNotMatch(
      modelsCss,
      /\.catalogPillTabs \[data-slot="tab-indicator"\]/,
      'catalog hand-written indicator override must stay removed',
    );

    const providerEditorCss = stripCssComments(await readFile(PROVIDER_EDITOR_CSS_FILE, 'utf8'));
    assert.doesNotMatch(
      providerEditorCss,
      /\.catalogTab\[data-active/,
      'catalog hand-written .catalogTab[data-active] must stay removed',
    );
    assert.doesNotMatch(
      providerEditorCss,
      /\.catalogTab:hover/,
      'catalog hand-written .catalogTab:hover must stay removed',
    );
  });

  it('skill tabs use Astryx + underline variant + TabsPanel', async () => {
    const panel = await readFile(SKILLS_PANEL_FILE, 'utf8');
    assert.match(
      panel,
      /TabsList[^>]*variant="underline"/,
      'skill TabsList must pass variant="underline"',
    );
    // Each skill tab value has a corresponding view panel.
    assert.match(
      panel,
      /TabsPanel[^>]*value="market"/,
      'skill must have a TabsPanel for the market view',
    );
    assert.match(
      panel,
      /TabsPanel[^>]*value="builtin"/,
      'skill must have a TabsPanel for the builtin view',
    );
    assert.match(
      panel,
      /TabsPanel[^>]*value="installed"/,
      'skill must have a TabsPanel for the installed view',
    );
    // Astryx replaces the old pressed-button switcher.
    assert.doesNotMatch(
      panel,
      /aria-pressed=\{activeSkillTab === tab\}/,
      'skill hand-rolled aria-pressed switcher must be removed',
    );
    assert.doesNotMatch(
      panel,
      /data-state=\{activeSkillTab === tab \? 'active' : 'inactive'\}/,
      'skill hand-rolled data-state switcher must be removed',
    );
    const css = stripCssComments(await readFile(SKILLS_CSS_FILE, 'utf8'));
    assert.doesNotMatch(
      css,
      /\.maka-skill-tab\[data-state\s*=\s*"active"\]/,
      'skill hand-written [data-state=active] selector must stay removed',
    );
    assert.doesNotMatch(
      css,
      /\.maka-skill-tab\[data-state\s*=\s*"active"\]::after/,
      'skill hand-written under-bar ::after must stay removed',
    );
  });

  it('daily-review range uses Segmented (Base UI ToggleGroup), not hand-rolled buttons; active is neutral', async () => {
    // daily-review range (今日/本周/本月) switches a time-window parameter —
    // the report re-fetches for the chosen range, it is not 3 distinct views.
    // So it is a segmented control, not tabs: Segmented (Base UI
    // ToggleGroup, single-select, roving tabindex + arrow keys + data-pressed)
    // is the a11y-correct primitive, not Tabs/TabsPanel.
    const panel = await readFile(DAILY_REVIEW_PANEL_FILE, 'utf8');
    assert.match(
      panel,
      /Segmented/,
      'daily-review range must use Segmented (Base UI ToggleGroup), not hand-rolled buttons',
    );
    assert.doesNotMatch(
      panel,
      /aria-pressed=\{range === option\}/,
      'daily-review hand-rolled aria-pressed switcher must be removed',
    );
    assert.doesNotMatch(
      panel,
      /data-active=\{range === option \? 'true' : undefined\}/,
      'daily-review hand-rolled data-active switcher must be removed',
    );
    const css = stripCssComments(await readFile(DAILY_REVIEW_CSS_FILE, 'utf8'));
    assert.doesNotMatch(
      css,
      /\.maka-daily-review-range-tab\[data-active/,
      'daily-review hand-written .maka-daily-review-range-tab[data-active] (brand --nav-active) must be removed (active is neutral via .maka-segmented button[data-pressed])',
    );
  });
});
