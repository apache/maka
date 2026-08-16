import assert from 'node:assert/strict';
import test from 'node:test';
import type { SearchResult } from '@maka/core/search';
import { collectThreadSearchResponses } from '../../preload/multi-host-thread-search.js';

const RESULT: SearchResult = {
  source: 'thread',
  title: 'Match',
};

test('preserves total multi-Host search failure without discarding partial success', async () => {
  await assert.rejects(
    collectThreadSearchResponses(
      [
        Promise.reject(new Error('Host A unavailable')),
        Promise.reject(new Error('Host B unavailable')),
      ],
      10,
    ),
    /Host A unavailable/,
  );

  assert.deepEqual(
    await collectThreadSearchResponses(
      [Promise.reject(new Error('Host A unavailable')), Promise.resolve([RESULT])],
      10,
    ),
    [RESULT],
  );
});
