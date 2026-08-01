import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HitTestArgumentError, parseHitTestArgs } from './check-hit-test.mjs';

test('hit-test arguments reject typos and unknown flags', () => {
  assert.throws(
    () => parseHitTestArgs(['--route', 'chat', '--route', 'chatt']),
    (error) =>
      error instanceof HitTestArgumentError && /must be one of: .*chat/.test(error.message),
  );
  assert.throws(() => parseHitTestArgs(['--not-a-flag']), /unknown arg/);
});
