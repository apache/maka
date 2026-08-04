import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVariantsReference } from './build-astryx-theme.mjs';

// @astryxdesign/cli 0.2.0 emits a `/// <reference>` to maka.variants.d.ts but
// no longer emits the file (#1980). Post-processing must drop the dangling
// line so tsc does not depend on skipLibCheck to resolve maka.d.ts.
test('the dangling variants reference line is stripped', () => {
  const dts =
    '/// <reference path="./maka.variants.d.ts" />\nimport type { DefinedTheme } from "x";\n';
  assert.equal(stripVariantsReference(dts), 'import type { DefinedTheme } from "x";\n');
});

test('stripping is idempotent and leaves other content alone', () => {
  const dts =
    'import type { DefinedTheme } from "x";\nexport declare const makaTheme: DefinedTheme;\n';
  assert.equal(stripVariantsReference(dts), dts);
});
