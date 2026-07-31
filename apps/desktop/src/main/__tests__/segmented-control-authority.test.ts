import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('mode, range, and peer navigation inputs use Astryx SegmentedControl without a Maka wrapper', () => {
  assert.equal(
    existsSync(join(REPO_ROOT, 'packages/ui/src/primitives/segmented.tsx')),
    false,
  );
  assert.doesNotMatch(read('packages/ui/src/index.ts'), /primitives\/segmented|\bSegmented\b/);
  for (const rel of [
    'packages/ui/src/module-hub-selector.tsx',
    'packages/ui/src/daily-review-panel.tsx',
    'apps/desktop/src/renderer/settings/appearance-settings-page.tsx',
    'apps/desktop/src/renderer/settings/bot-chat-detail.tsx',
    'apps/desktop/src/renderer/settings/usage-settings-page.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /\bSegmentedControl\b/);
    assert.match(source, /\bSegmentedControlItem\b/);
    assert.doesNotMatch(source, /<Segmented\b|\bSegmented,/);
    if (rel.endsWith('module-hub-selector.tsx')) {
      assert.doesNotMatch(source, /DropdownMenu/);
    }
  }
});
