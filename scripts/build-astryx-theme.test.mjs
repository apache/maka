import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripResetLayer } from './build-astryx-theme.mjs';

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
  assert.match(stripped, /@layer astryx-theme/);
  assert.throws(
    () => stripResetLayer('@layer astryx-theme {}'),
    /expected a leading "@layer reset/,
  );
});
