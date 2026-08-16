import assert from 'node:assert/strict';
import test from 'node:test';
import type { SearchError, SearchResult } from '@maka/core/search';
import { collectThreadSearchResponses } from '../../preload/multi-host-thread-search.js';

const RESULT: SearchResult = {
  source: 'thread',
  title: 'Match',
};
const ERROR: SearchError = {
  ok: false,
  reason: 'provider_error',
  message: 'Host A failed',
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

  assert.deepEqual(
    await collectThreadSearchResponses([Promise.resolve(ERROR)], 10),
    ERROR,
  );
});
