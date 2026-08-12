import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { isAllowedUser } = __TEST__;

describe('isAllowedUser', () => {
  it('defaults open and otherwise requires an exact user-id match', () => {
    const cases: Array<[string[] | undefined, string, boolean]> = [
      [undefined, '12345', true],
      [[], '12345', true],
      [['12345', '67890'], '67890', true],
      [['1234567890'], '123', false],
    ];
    for (const [allowlist, userId, expected] of cases) {
      assert.equal(isAllowedUser(allowlist, userId), expected, `${allowlist}:${userId}`);
    }
  });
});
