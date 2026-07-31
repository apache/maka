import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('the shared Chip API remains available for consumers outside Slice 10', () => {
  const chipSource = read('packages/ui/src/primitives/chip.tsx');
  const indexSource = read('packages/ui/src/index.ts');

  assert.match(chipSource, /export function Chip/);
  assert.match(chipSource, /["']?data-slot["']?\s*[:=]\s*["']chip["']/);
  assert.match(chipSource, /rounded-\[var\(--radius-control\)\]/);
  assert.match(indexSource, /export (?:\*|\{[^}]*\bChip\b[^}]*\}) from ['"]\.\/primitives\/chip\.js['"]/);
});

test('Settings and Modules use Astryx Badge instead of the shared Chip API', () => {
  for (const rel of [
    'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
    'apps/desktop/src/renderer/settings/provider-add-form.tsx',
    'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
    'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
    'apps/desktop/src/renderer/settings/claude-subscription-card.tsx',
    'apps/desktop/src/renderer/settings/bot-chat-overview.tsx',
    'apps/desktop/src/renderer/settings/bot-chat-detail.tsx',
    'apps/desktop/src/renderer/settings/provider-catalog.tsx',
    'apps/desktop/src/renderer/mcp-page.tsx',
    'packages/ui/src/skills-panel.tsx',
    'packages/ui/src/plan-reminder-panel.tsx',
    'packages/ui/src/daily-review-panel.tsx',
  ]) {
    const source = read(rel);
    assert.doesNotMatch(source, /\bChip\b|primitives\/chip/, `${rel} must not consume the shared Chip API`);
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
