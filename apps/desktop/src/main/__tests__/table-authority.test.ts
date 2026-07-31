import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('comparative usage data uses Astryx Table directly', () => {
  const usageSource = read('apps/desktop/src/renderer/settings/usage-settings-page.tsx');
  assert.match(usageSource, /import[^;]*\bTable\b[^;]*from '@astryxdesign\/core'/s);
  assert.match(usageSource, /\bTable\b/);
  assert.match(usageSource, /\bTableColumn\b/);
  assert.match(usageSource, /<Table\b/);
  assert.doesNotMatch(usageSource, /\bDataTable\b/);
});
