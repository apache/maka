import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { base64urlEncode } from '../oauth-subscription.js';

describe('OAuth subscription helpers', () => {
  it('matches base64url encoding for empty and reserved bytes', () => {
    assert.equal(base64urlEncode(new Uint8Array()), '');
    assert.equal(base64urlEncode(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
  });
});
