import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('empty surfaces use Astryx EmptyState without Maka empty wrappers', () => {
  for (const rel of [
    'packages/ui/src/empty-state.tsx',
    'packages/ui/src/primitives/empty.tsx',
  ]) {
    assert.equal(existsSync(join(REPO_ROOT, rel)), false, `${rel} must be deleted`);
  }

  const indexSource = read('packages/ui/src/index.ts');
  assert.match(indexSource, /\bEmptyState\b[^]*@astryxdesign\/core/);
  assert.doesNotMatch(indexSource, /primitives\/empty|\.\/empty-state/);

  for (const rel of [
    'packages/ui/src/skills-panel.tsx',
    'packages/ui/src/plan-reminder-panel.tsx',
    'packages/ui/src/daily-review-panel.tsx',
    'apps/desktop/src/renderer/mcp-page.tsx',
    'apps/desktop/src/renderer/settings/usage-settings-page.tsx',
  ]) {
    assert.doesNotMatch(read(rel), /\bIcon=|\bbody=|\bextraClassName=|\bcta=/);
  }
});
