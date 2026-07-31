import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('entity rows use the Astryx Item taxonomy without compound Maka slots', () => {
  assert.equal(
    existsSync(join(REPO_ROOT, 'packages/ui/src/primitives/item.tsx')),
    false,
    'the retired compound Item implementation must be deleted',
  );

  for (const rel of [
    'packages/ui/src/index.ts',
    'apps/desktop/src/renderer/OnboardingHero.tsx',
    'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
    'apps/desktop/src/renderer/settings/bot-chat-overview.tsx',
    'apps/desktop/src/renderer/settings/health-center-page.tsx',
    'apps/desktop/src/renderer/settings/provider-catalog.tsx',
    'apps/desktop/src/renderer/settings/provider-oauth-section.tsx',
  ]) {
    const source = read(rel);
    assert.doesNotMatch(
      source,
      /\bItem(?:Media|Content|Title|Description|Actions)\b|primitives\/item/,
      `${rel} must use Astryx Item's named props`,
    );
  }
});
