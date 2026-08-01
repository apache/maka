import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('Settings and Module loading placeholders delegate geometry and motion to Astryx Skeleton', () => {
  for (const rel of [
    'apps/desktop/src/renderer/settings/settings-skeleton.tsx',
    'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
    'packages/ui/src/daily-review-panel.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /import[^;]*\bSkeleton\b[^;]*from '@astryxdesign\/core'/s);
    assert.match(source, /<Skeleton\b/);
    assert.doesNotMatch(source, /maka-skeleton/);
  }

  assert.doesNotMatch(read('apps/desktop/src/renderer/maka-tokens.css'), /\.maka-skeleton/);
});
