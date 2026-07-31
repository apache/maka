import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('settings and module empty surfaces use Astryx EmptyState directly', () => {
  for (const rel of [
    'packages/ui/src/skills-panel.tsx',
    'packages/ui/src/plan-reminder-panel.tsx',
    'packages/ui/src/daily-review-panel.tsx',
    'apps/desktop/src/renderer/mcp-page.tsx',
    'apps/desktop/src/renderer/settings/usage-settings-page.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /import[^;]*\bEmptyState\b[^;]*from '@astryxdesign\/core'/s);
    assert.doesNotMatch(source, /\bIcon=|\bbody=|\bextraClassName=|\bcta=/);
  }
});
