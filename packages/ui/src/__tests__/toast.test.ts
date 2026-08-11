import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { toastContentKey } from '../toast.js';

it('deduplicates identical active toast content without merging different errors', () => {
  const input = {
    title: 'Send failed',
    description: 'Try again later',
    variant: 'error' as const,
  };
  assert.equal(toastContentKey(input), toastContentKey({ ...input }));
  assert.notEqual(
    toastContentKey(input),
    toastContentKey({ ...input, description: 'Authentication failed' }),
  );
});
