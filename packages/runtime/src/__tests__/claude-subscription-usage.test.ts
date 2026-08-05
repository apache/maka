import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_SUBSCRIPTION_USAGE_ENDPOINT,
  fetchClaudeSubscriptionUsage,
} from '../claude-subscription-usage.js';

test('fetches a bounded Claude usage projection without returning credential material', async () => {
  const secret = 'account-access-token';
  const quota = await fetchClaudeSubscriptionUsage({
    accessToken: secret,
    now: () => 123,
    fetchFn: async (url, init) => {
      assert.equal(url, CLAUDE_SUBSCRIPTION_USAGE_ENDPOINT);
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${secret}`);
      return Response.json({
        five_hour: { utilization: 24.6, resets_at: '2026-08-05T12:00:00.000Z' },
        seven_day: { utilization: 50, resets_at: '2026-08-12T00:00:00.000Z' },
        ignored_provider_field: { token: secret },
      });
    },
  });

  assert.deepEqual(quota, {
    fiveHour: { utilization: 25, resetsAt: '2026-08-05T12:00:00.000Z' },
    sevenDay: { utilization: 50, resetsAt: '2026-08-12T00:00:00.000Z' },
    fetchedAt: 123,
  });
  assert.equal(JSON.stringify(quota).includes(secret), false);
});
