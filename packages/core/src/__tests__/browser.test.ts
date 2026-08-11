import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { normalizeBrowserAddressInput } from '../browser.js';

describe('browser address input normalization', () => {
  it('returns stable rejection reasons for non-navigable input', () => {
    assert.deepEqual(normalizeBrowserAddressInput('   '), { ok: false, reason: 'empty' });
    assert.deepEqual(normalizeBrowserAddressInput('javascript:alert(1)'), {
      ok: false,
      reason: 'unsupported_scheme',
    });
    assert.deepEqual(normalizeBrowserAddressInput('http://'), { ok: false, reason: 'invalid_url' });
  });
});
