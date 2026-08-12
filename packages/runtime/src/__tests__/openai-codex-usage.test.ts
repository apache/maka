import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOpenAiCodexUsage, OPENAI_CODEX_USAGE_ENDPOINT } from '../openai-codex-usage.js';

function accessToken(accountId: string): string {
  const encoded = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `header.${encoded}.signature`;
}

test('fetchOpenAiCodexUsage maps windows by duration and scopes the account header', async () => {
  let requestedUrl = '';
  let requestedAccount = '';
  const quota = await fetchOpenAiCodexUsage({
    accessToken: accessToken('acct_second'),
    now: () => 1234,
    fetchFn: async (url, init) => {
      requestedUrl = String(url);
      requestedAccount = new Headers(init?.headers).get('ChatGPT-Account-Id') ?? '';
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 41.4,
              limit_window_seconds: 604800,
              reset_at: 1_800_000_000,
            },
            secondary_window: {
              used_percent: 12.2,
              limit_window_seconds: 18000,
              reset_at: 1_700_000_000,
            },
          },
        }),
      );
    },
  });

  assert.equal(requestedUrl, OPENAI_CODEX_USAGE_ENDPOINT);
  assert.equal(requestedAccount, 'acct_second');
  assert.deepEqual(quota, {
    fiveHour: { utilization: 12, resetsAt: '2023-11-14T22:13:20.000Z' },
    sevenDay: { utilization: 41, resetsAt: '2027-01-15T08:00:00.000Z' },
    fetchedAt: 1234,
  });
});

test('fetchOpenAiCodexUsage does not invent a missing quota window', async () => {
  const quota = await fetchOpenAiCodexUsage({
    accessToken: accessToken('acct_primary'),
    now: () => 99,
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 8,
              limit_window_seconds: 604800,
              reset_at: 1_800_000_000,
            },
            secondary_window: null,
          },
        }),
      ),
  });

  assert.deepEqual(quota, {
    sevenDay: { utilization: 8, resetsAt: '2027-01-15T08:00:00.000Z' },
    fetchedAt: 99,
  });
});
