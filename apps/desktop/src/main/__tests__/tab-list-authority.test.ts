import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('view navigation uses Astryx TabList without a Maka tabs wrapper', () => {
  assert.equal(
    existsSync(join(REPO_ROOT, 'packages/ui/src/primitives/tabs.tsx')),
    false,
    'the retired Base UI tabs wrapper must be deleted',
  );

  for (const rel of ['packages/ui/src/index.ts', 'packages/ui/src/ui.tsx']) {
    const source = read(rel);
    assert.doesNotMatch(
      source,
      /\b(?:TabsRoot|TabsTrigger|TabsPanel|PrimitiveTabs)\b|primitives\/tabs/,
      `${rel} must not preserve the old tabs API`,
    );
  }

  for (const rel of [
    'packages/ui/src/skills-panel.tsx',
    'packages/ui/src/plan-reminder-panel.tsx',
    'apps/desktop/src/renderer/mcp-page.tsx',
    'apps/desktop/src/renderer/settings/usage-settings-page.tsx',
    'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
    'apps/desktop/src/renderer/session-workbar.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /\bTabList\b/, `${rel} must use Astryx TabList`);
    assert.match(source, /<Tab\b/, `${rel} must use Astryx Tab`);
    assert.doesNotMatch(
      source,
      /\b(?:TabsRoot|TabsTrigger|TabsPanel|PrimitiveTabs)\b|primitives\/tabs/,
      `${rel} must not consume the old tabs API`,
    );
  }

  assert.doesNotMatch(
    read('apps/desktop/src/renderer/maka-tokens.css'),
    /\.maka-tabs-list|\.maka-tab(?:\b|\[)/,
    'the retired tab recipe must not remain a CSS authority',
  );
});
