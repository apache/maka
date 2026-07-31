import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('settings and module view navigation uses Astryx TabList directly', () => {
  for (const rel of [
    'packages/ui/src/skills-panel.tsx',
    'packages/ui/src/plan-reminder-panel.tsx',
    'apps/desktop/src/renderer/mcp-page.tsx',
    'apps/desktop/src/renderer/settings/usage-settings-page.tsx',
    'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /import[^;]*\bTabList\b[^;]*from '@astryxdesign\/core'/s);
    assert.match(source, /\bTabList\b/, `${rel} must use Astryx TabList`);
    assert.match(source, /<Tab\b/, `${rel} must use Astryx Tab`);
    assert.doesNotMatch(
      source,
      /\b(?:TabsRoot|TabsTrigger|TabsPanel|PrimitiveTabs)\b|primitives\/tabs/,
      `${rel} must not consume the old tabs API`,
    );
  }
  for (const rel of [
    'apps/desktop/src/renderer/styles/module-pages/skills.css',
    'apps/desktop/src/renderer/styles/module-pages/mcp.css',
    'apps/desktop/src/renderer/styles/settings/bot.css',
  ]) {
    assert.doesNotMatch(
      read(rel),
      /\.(?:maka-skill-tab|maka-mcp-tab|settingsUsageTab)(?:s)?(?:\s|,|\{)/,
      `${rel} must leave Astryx Tab geometry intact`,
    );
  }
});
