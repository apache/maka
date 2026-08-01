import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('Settings and Module navigation inputs use Astryx SegmentedControl directly', () => {
  for (const rel of [
    'packages/ui/src/daily-review-panel.tsx',
    'apps/desktop/src/renderer/settings/appearance-settings-page.tsx',
    'apps/desktop/src/renderer/settings/bot-chat-detail.tsx',
    'apps/desktop/src/renderer/settings/usage-settings-page.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /import[^;]*\bSegmentedControl\b[^;]*from '@astryxdesign\/core'/s);
    assert.match(source, /\bSegmentedControl\b/);
    assert.match(source, /\bSegmentedControlItem\b/);
    assert.doesNotMatch(source, /<Segmented\b|\bSegmented,/);
  }
});
