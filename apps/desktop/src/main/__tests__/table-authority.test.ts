import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('comparative usage data uses Astryx Table without a Maka DataTable wrapper', () => {
  assert.equal(
    existsSync(join(REPO_ROOT, 'packages/ui/src/primitives/data-table.tsx')),
    false,
    'the retired Maka DataTable implementation must be deleted',
  );

  const indexSource = read('packages/ui/src/index.ts');
  assert.doesNotMatch(indexSource, /\bDataTable\b|primitives\/data-table/);

  const usageSource = read('apps/desktop/src/renderer/settings/usage-settings-page.tsx');
  assert.match(usageSource, /\bTable\b/);
  assert.match(usageSource, /\bTableColumn\b/);
  assert.match(usageSource, /<Table\b/);
  assert.doesNotMatch(usageSource, /\bDataTable\b/);
});
