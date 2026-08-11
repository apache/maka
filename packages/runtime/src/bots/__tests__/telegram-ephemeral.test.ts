import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { ephemeralDelayFromOptions } = __TEST__;

describe('ephemeralDelayFromOptions', () => {
  it('rejects invalid TTLs and clamps valid TTLs to Telegram limits', () => {
    const cases: Array<[Parameters<typeof ephemeralDelayFromOptions>[0], number | undefined]> = [
      [{ replyToMessageId: 'm-1' }, undefined],
      [{ ephemeralTtlMs: 0 }, undefined],
      [{ ephemeralTtlMs: Number.NaN }, undefined],
      [{ ephemeralTtlMs: 1 }, 1_000],
      [{ ephemeralTtlMs: 5 * 60_000 }, 5 * 60_000],
      [{ ephemeralTtlMs: 72 * 60 * 60_000 }, 48 * 60 * 60_000],
    ];
    for (const [options, expected] of cases) {
      assert.equal(ephemeralDelayFromOptions(options), expected, JSON.stringify(options));
    }
  });
});
