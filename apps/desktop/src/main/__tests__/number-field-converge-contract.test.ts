import { strict as assert } from 'node:assert';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const MIGRATED_FILES = [
  'apps/desktop/src/renderer/settings/general-settings-page.tsx',
];

const RETIRED_NUMBER_FIELD_PRIMITIVE = 'packages/ui/src/primitives/number-field.tsx';

/** The hand-conversion the migration removes. */
const HAND_CONVERT_RE = /Number\(value\)/;

/** The Astryx NumberInput is available only through Maka's public barrel. */
const NUMBER_INPUT_IMPORT_RE = /import\s+\{[^}]*\bNumberInput\b[^}]*\}\s+from\s+['"]@maka\/ui['"]/;

describe('PR 4 Astryx number-input contract', () => {
  it('the port-input files use the public Astryx NumberInput without string hand-conversion', async () => {
    for (const rel of MIGRATED_FILES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(!HAND_CONVERT_RE.test(src), `${rel}: must not hand-convert Number(value)`);
      assert.match(src, NUMBER_INPUT_IMPORT_RE, `${rel}: must import NumberInput from @maka/ui`);
      assert.match(src, /<NumberInput\b/, `${rel}: must render NumberInput`);
    }
  });

  it('exports Astryx NumberInput and retires the local Base UI wrapper', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, 'packages/ui/src/index.ts'), 'utf8');
    assert.match(barrel, /\bNumberInput,\s*\n\s*type NumberInputProps,/);
    assert.match(barrel, /\} from '@astryxdesign\/core';/);
    await assert.rejects(access(resolve(REPO_ROOT, RETIRED_NUMBER_FIELD_PRIMITIVE)));
  });
});

describe('number-field negative cases', () => {
  it('HAND_CONVERT_RE matches the hand-conversion, not other Number() uses', () => {
    assert.ok(HAND_CONVERT_RE.test('Number(value)'), 'the hand-conversion must match');
    assert.ok(!HAND_CONVERT_RE.test('Number(123)'), 'a plain Number(123) must not match');
    assert.ok(!HAND_CONVERT_RE.test('const n = Number("x")'), 'a different Number() call must not match');
  });
});
