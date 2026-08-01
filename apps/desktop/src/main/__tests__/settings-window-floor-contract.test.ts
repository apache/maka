/**
 * Settings window-floor layout contract (#1304 / #1361 / #1364).
 *
 * These declarations used to be locked only by Electron e2e that resized the
 * live shell to SAFE_MIN_WIDTH (480) and measured scrollWidth. That is the
 * correct user-visible outcome, but each assertion paid a full cold start and
 * the suite serializes on CI. The load-bearing fixes are pure CSS: pin them
 * here so a reversion fails in unit time. Keep product journeys (theme apply,
 * remote access, voice draft) in e2e.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, stripCssComments } from './css-test-helpers.js';

const SETTINGS_CSS = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/settings');

async function readSettingsCss(name: string): Promise<string> {
  return stripCssComments(await readFile(resolve(SETTINGS_CSS, name), 'utf8'));
}

describe('settings window-floor CSS contract', () => {
  it('keeps permission OS rows structurally wrapable with a readable body floor', async () => {
    const css = await readSettingsCss('permission.css');

    assert.match(
      css,
      /\.settingsOsPermissionRow\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;/,
      'OS permission rows must wrap actions under the body instead of squeezing text to 0',
    );
    assert.match(
      css,
      /\.settingsOsPermissionRow\s*>\s*\.settingsOsPermissionBody\s*\{[\s\S]*?flex:\s*1\s+1\s+101px;[\s\S]*?min-width:\s*101px;/,
      'permission body must keep the status-badge floor (~101px)',
    );
    assert.match(
      css,
      /\.settingsOsPermissionHeading\s+strong\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/,
      'long permission titles must be allowed to shrink and break',
    );
    assert.match(
      css,
      /\.settingsPermissionSummary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*96px\s*,\s*1fr\s*\)\s*\);/,
      'permission summary must auto-fit from a legible track floor, not four hard tracks',
    );
    assert.match(
      css,
      /\.settingsCapabilityLayers\s*\{[\s\S]*?grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*min\(\s*150px\s*,\s*100%\s*\)\s*,\s*1fr\s*\)\s*\);/,
      'capability layers must not hard-floor a 150px track past the content column',
    );
  });

  it('keeps health and usage metric strips auto-fit with legible floors', async () => {
    const health = await readSettingsCss('health.css');
    const usage = await readSettingsCss('bot.css');

    assert.match(
      health,
      /\.settingsHealthSummary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*80px\s*,\s*1fr\s*\)\s*\);/,
      'health summary must auto-fit from an 80px floor',
    );
    assert.match(
      usage,
      /\.settingsUsageSummary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*min\(\s*120px\s*,\s*100%\s*\)\s*,\s*1fr\s*\)\s*\);/,
      'usage summary must auto-fit instead of four hard tracks',
    );
    assert.match(
      usage,
      /\.settingsUsagePage\s*\{[\s\S]*?grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\);/,
      'usage page must pin a 0-floor column so wide children scroll inside, not expand the page',
    );
    assert.match(
      usage,
      /\.settingsUsageTabsBar\s*\{[\s\S]*?overflow-x:\s*auto;/,
      'usage tabs must scroll within themselves at the window floor',
    );
  });

  it('wraps unbreakable web-search tokens and keeps inputs shrinkable', async () => {
    const css = await readSettingsCss('web-search.css');

    assert.match(
      css,
      /\.settingsWebSearchDisabledReason\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
      'env-var hint must wrap unbreakable tokens at the floor',
    );
    assert.match(
      css,
      /\.settingsWebSearchResult\s+a\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
      'result titles that are bare URLs must wrap inside the card',
    );
    assert.match(
      css,
      /\.settingsWebSearchResult\s+small\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
      'result hostnames must wrap inside the card',
    );
    assert.match(
      css,
      /\.settingsWebSearchKeyField\s*,\s*\.settingsWebSearchQueryField\s*\{[\s\S]*?min-width:\s*0;/,
      'search inputs must be allowed to shrink below UA size at the floor',
    );
  });

  it('lets memory preview chrome wrap and keeps form surfaces min-width free', async () => {
    const memory = await readSettingsCss('memory.css');
    const form = await readSettingsCss('form.css');
    const rows = await readSettingsCss('rows.css');

    assert.match(
      memory,
      /\.settingsMemoryPromptPreviewHeader\s*\{[\s\S]*?flex-wrap:\s*wrap;/,
      'memory preview header must wrap the status cluster under the title',
    );
    assert.match(
      form,
      /\.settingsSurface\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/,
      'settings surface must be a constrained flex child',
    );
    assert.match(
      rows,
      /\.settingsRows\s*\{[\s\S]*?overflow:\s*hidden;/,
      'settings row cards must clip horizontal overflow of children',
    );
  });

  it('keeps remote-access rows and detail headers readable at the window floor', async () => {
    const css = await readSettingsCss('bot.css');

    assert.match(
      css,
      /\.settingsRemoteAccessItemTitle\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?overflow-wrap:\s*anywhere;/,
      'channel titles must wrap status chips instead of overflowing',
    );
    assert.match(
      css,
      /\.settingsRemoteAccessItemDescription\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
      'channel diagnostics must wrap unbreakable tokens',
    );
    assert.match(
      css,
      /\.settingsBotStatusGrid\s+dd\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
      'runtime status values must wrap inside the grid',
    );
    assert.match(
      css,
      /@media\s*\(\s*max-width:\s*620px\s*\)\s*\{[\s\S]*?\.settingsRemoteAccessItemActions\s*\{[\s\S]*?display:\s*none;/,
      'narrow overview must drop the redundant chevron column',
    );
    assert.match(
      css,
      /@media\s*\(\s*max-width:\s*620px\s*\)\s*\{[\s\S]*?\.settingsBotDetailHeaderBody\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/,
      'narrow detail body must span the full header row',
    );
    assert.match(
      css,
      /@media\s*\(\s*max-width:\s*620px\s*\)\s*\{[\s\S]*?\.settingsBotStatusGrid\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
      'narrow runtime status must collapse to one column',
    );
    assert.match(
      css,
      /@media\s*\(\s*max-width:\s*620px\s*\)\s*\{[\s\S]*?\.settingsRemoteAccessSectionHeader[\s\S]*?flex-direction:\s*column;/,
      'narrow section headers must stack',
    );
  });
});
