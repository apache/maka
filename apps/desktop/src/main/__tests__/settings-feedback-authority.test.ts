import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('provider loading failure uses the Astryx error feedback seam', () => {
  const source = read('apps/desktop/src/renderer/settings/ProvidersPanel.tsx');
  assert.match(source, /import[^;]*\bBanner\b[^;]*from '@astryxdesign\/core'/s);
  assert.match(source, /<Banner\b[^>]*status="error"[^>]*title=\{copy\.loadFailed\}/s);
  assert.match(source, /endContent=\{<Button\b[^>]*onClick=\{\(\) => void reload\(\)\}/s);
  assert.doesNotMatch(source, /enabledEmptyAction|Button as BaseButton/);
});
