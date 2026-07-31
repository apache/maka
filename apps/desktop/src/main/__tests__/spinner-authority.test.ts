import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('settings loading indicators use Astryx Spinner directly', () => {
  const onboarding = read('apps/desktop/src/renderer/settings/bot-onboarding-modal.tsx');
  assert.match(onboarding, /import[^;]*\bSpinner\b[^;]*from '@astryxdesign\/core'/s);
  assert.match(onboarding, /<Spinner size="xl"/);
  assert.doesNotMatch(onboarding, /<Spinner size=\{\d+\}/);
});
