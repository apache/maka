import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('status labels use the Astryx Badge authority without a Maka Chip API', () => {
  assert.equal(
    existsSync(join(REPO_ROOT, 'packages/ui/src/primitives/chip.tsx')),
    false,
    'the retired Maka Chip implementation must be deleted',
  );

  const indexSource = read('packages/ui/src/index.ts');
  assert.match(
    indexSource,
    /export\s*\{[^}]*\bBadge\b[^}]*\}\s*from\s*['"]@astryxdesign\/core['"]/s,
    'the public Badge must remain the direct Astryx export',
  );
  assert.doesNotMatch(indexSource, /\bChip\b|primitives\/chip/, 'the package barrel must not retain the old Chip API');

  for (const rel of [
    'apps/desktop/src/renderer/settings',
    'apps/desktop/src/renderer/mcp-page.tsx',
    'packages/ui/src/skills-panel.tsx',
    'packages/ui/src/plan-reminder-panel.tsx',
    'packages/ui/src/daily-review-panel.tsx',
  ]) {
    const source = rel.endsWith('.tsx') ? read(rel) : '';
    if (source) assert.doesNotMatch(source, /\bChip\b|primitives\/chip/, `${rel} must use Astryx Badge or plain text`);
  }
});

test('page-level status uses Astryx Banner without a custom status dot', () => {
  const source = read('apps/desktop/src/renderer/settings/daily-review-settings-page.tsx');
  const css = read('apps/desktop/src/renderer/styles/settings/nav-sidebar.css');

  assert.match(source, /import\s+\{[^}]*\bBanner\b[^}]*\}\s+from '@astryxdesign\/core'/s);
  assert.match(source, /<Banner\s+status="info"/);
  assert.doesNotMatch(source, /settingsFeatureStatusBannerDot/);
  assert.doesNotMatch(css, /\.settingsFeatureStatusBanner(?:Dot)?\b/);
});
