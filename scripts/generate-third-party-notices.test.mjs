import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('keeps a version-pinned Apache override scoped to the Apache license', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/generate-third-party-notices.mjs', '--check'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const notices = readFileSync(
    join(root, 'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );
  const providerUtils = notices
    .split('\n================================================================================\n')
    .find((section) => section.includes('Package: @ai-sdk/provider-utils@5.0.25'));
  assert.ok(providerUtils, 'provider-utils notice section must exist');
  assert.doesNotMatch(providerUtils, /THIRD-PARTY COMPONENTS/);
});
