/**
 * PR-NUMBER-FIELD-CONVERGE-0 (issue #520 PR5 item 21, 2026-07-05):
 * the two gateway/proxy port inputs migrate off the native `Input` +
 * `Number(event.currentTarget.value)` hand-conversion onto Base UI
 * NumberField, which binds `value: number | null` directly and parses
 * numeric input itself (no manual string→number, no `|| default` fallback
 * gymnastics).
 *
 * Sites:
 * - general-settings-page proxy port (default 0 on empty).
 * - open-gateway-settings-page gateway port (default 3939 on empty).
 *
 * The contract: the two files must not carry the `Number(event.currentTarget
 * .value)` hand-conversion and must import NumberField; the primitive must
 * wrap Base UI NumberField with the data-slot convention (item 23).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const MIGRATED_FILES = [
  'apps/desktop/src/renderer/settings/general-settings-page.tsx',
  'apps/desktop/src/renderer/settings/open-gateway-settings-page.tsx',
];

const NUMBER_FIELD_PRIMITIVE = 'packages/ui/src/primitives/number-field.tsx';

/** The hand-conversion the migration removes. */
const HAND_CONVERT_RE = /Number\(event\.currentTarget\.value\)/;

/** A NumberField import from the barrel / primitives / @base-ui. */
const NUMBER_FIELD_IMPORT_RE = /import\s+\{[^}]*\bNumberField\b[^}]*\}\s+from\s+['"][^'"]*(?:@maka\/ui|primitives\/number-field|@base-ui\/react\/number-field)[^'"]*['"]/;

describe('PR-NUMBER-FIELD-CONVERGE-0 contract', () => {
  it('the port-input files use Base UI NumberField (no Number(event.currentTarget.value) hand-conversion)', async () => {
    for (const rel of MIGRATED_FILES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(!HAND_CONVERT_RE.test(src), `${rel}: must not hand-convert Number(event.currentTarget.value) — use Base UI NumberField (value: number | null, onValueChange)`);
      assert.match(src, NUMBER_FIELD_IMPORT_RE, `${rel}: must import NumberField from @maka/ui / primitives/number-field / @base-ui/react/number-field`);
    }
  });

  it('primitives/number-field.tsx wraps Base UI NumberField with data-slot on Root / Input', async () => {
    const src = await readFile(resolve(REPO_ROOT, NUMBER_FIELD_PRIMITIVE), 'utf8');
    assert.match(src, /@base-ui\/react\/number-field/, 'must import from @base-ui/react/number-field');
    for (const slot of ['number-field', 'number-field-input']) {
      assert.match(src, new RegExp(`data-slot="${slot}"`), `must expose data-slot="${slot}" (style-hook convention, item 23)`);
    }
  });
});
