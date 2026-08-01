import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { ephemeralDelayFromOptions, EPHEMERAL_REPLY_MIN_MS, EPHEMERAL_REPLY_MAX_MS } = __TEST__;

describe('ephemeralDelayFromOptions', () => {
  it('rejects invalid TTLs and clamps valid TTLs to Telegram limits', () => {
    const cases: Array<[Parameters<typeof ephemeralDelayFromOptions>[0], number | undefined]> = [
      [undefined, undefined],
      [{}, undefined],
      [{ replyToMessageId: 'm-1' }, undefined],
      [{ ephemeralTtlMs: 0 }, undefined],
      [{ ephemeralTtlMs: -1 }, undefined],
      [{ ephemeralTtlMs: Number.NaN }, undefined],
      [{ ephemeralTtlMs: Number.POSITIVE_INFINITY }, undefined],
      [{ ephemeralTtlMs: 1 }, EPHEMERAL_REPLY_MIN_MS],
      [{ ephemeralTtlMs: 5 * 60_000 }, 5 * 60_000],
      [{ ephemeralTtlMs: 60 * 60_000 }, 60 * 60_000],
      [{ ephemeralTtlMs: 72 * 60 * 60_000 }, EPHEMERAL_REPLY_MAX_MS],
      [{ ephemeralTtlMs: 7 * 24 * 60 * 60_000 }, EPHEMERAL_REPLY_MAX_MS],
    ];
    for (const [options, expected] of cases) {
      assert.equal(ephemeralDelayFromOptions(options), expected, JSON.stringify(options));
    }
  });
});
