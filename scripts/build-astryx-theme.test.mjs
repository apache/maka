import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAstryxTheme,
  normalizeGeneratedHeader,
  stripResetLayer,
} from './build-astryx-theme.mjs';

test('normalizes volatile Astryx generator metadata', () => {
  const generated = `/**
 * Command: astryx theme build source.ts --out /tmp/build/maka.css
 * Generated: 2026-07-31T12:34:56.789Z
 */
`;

  assert.equal(
    normalizeGeneratedHeader(generated),
    `/**
 * Command: astryx theme build src/renderer/astryx-theme/makaTheme.ts --out src/renderer/astryx-theme/maka.css
 */
`,
  );
});

test('strips exactly the generated reset layer and preserves nested rules', () => {
  const generated = `/**
 * Header
 */

@layer reset {
  @scope ([data-astryx-theme]) {
    :where(p) { margin: 0; }
  }
}

@layer astryx-theme {
  :root { --color: red; }
}
`;

  const stripped = stripResetLayer(generated);
  assert.doesNotMatch(stripped, /@layer reset\s*\{/);
  assert.match(stripped, /Post-processed by scripts\/build-astryx-theme\.mjs/);
  assert.match(stripped, /@layer astryx-theme/);
  assert.throws(
    () => stripResetLayer('@layer astryx-theme {}'),
    /expected a leading "@layer reset/,
  );
});

test('checked-in Astryx theme artifacts match a fresh build', () => {
  assert.doesNotThrow(() => buildAstryxTheme({ check: true, stdio: 'pipe' }));
});
