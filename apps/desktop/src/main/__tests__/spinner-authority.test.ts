import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('loading indicators use Astryx Spinner without a Maka icon wrapper', () => {
  assert.equal(
    existsSync(join(REPO_ROOT, 'packages/ui/src/primitives/spinner.tsx')),
    false,
  );
  assert.match(read('packages/ui/src/index.ts'), /\bSpinner\b[^]*@astryxdesign\/core/);
  assert.doesNotMatch(read('packages/ui/src/index.ts'), /primitives\/spinner/);

  const onboarding = read('apps/desktop/src/renderer/settings/bot-onboarding-modal.tsx');
  assert.match(onboarding, /<Spinner size="xl"/);
  assert.doesNotMatch(onboarding, /<Spinner size=\{\d+\}/);
});
