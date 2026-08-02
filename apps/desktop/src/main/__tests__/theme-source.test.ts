import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isThemePreference, toNativeThemeSource } from '../theme-source.js';

describe('theme-source', () => {
  it('maps and validates the closed app preference enum', () => {
    const valid = [
      ['auto', 'system'],
      ['light', 'light'],
      ['dark', 'dark'],
    ] as const;
    for (const [preference, nativeSource] of valid) {
      assert.equal(isThemePreference(preference), true);
      assert.equal(toNativeThemeSource(preference), nativeSource);
    }
    for (const value of ['system', 'unknown', undefined, null, 42, {}]) {
      assert.equal(isThemePreference(value), false);
    }
  });
});
