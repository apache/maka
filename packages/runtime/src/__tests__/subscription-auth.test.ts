import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64urlEncode } from '@maka/core/oauth-subscription';
import {
  extractCodexAccountClaims,
  extractCodexAccountId,
  openAiCodexHeaders,
} from '../subscription-auth.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none' })));
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${header}.${body}.signature`;
}

test('extractCodexAccountId reads the ChatGPT account id from the access token', () => {
  const token = makeJwt({
    sub: 'fallback-sub',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_pinned' },
  });
  assert.equal(extractCodexAccountId(token), 'acct_pinned');
  // Header routing deliberately does not fall back to JWT sub.
  assert.equal(extractCodexAccountId(makeJwt({ sub: 'plain-sub' })), null);
  assert.equal(extractCodexAccountId(makeJwt({})), null);
});

test('openAiCodexHeaders routes with the account id when present', () => {
  const token = makeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-header' },
  });
  const headers = openAiCodexHeaders(token);
  assert.equal(headers['ChatGPT-Account-Id'], 'acct-header');
  assert.equal(openAiCodexHeaders(makeJwt({})).ChatGPT_Account_Id, undefined);
});

test('extractCodexAccountClaims reads the ChatGPT account id from the access token', () => {
  const token = makeJwt({
    sub: 'fallback-sub',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_pinned' },
  });
  assert.deepEqual(extractCodexAccountClaims(token), { accountId: 'acct_pinned' });
});

test('extractCodexAccountClaims falls back to sub when the chatgpt_account_id claim is missing', () => {
  const token = makeJwt({ sub: 'fallback-sub-only' });
  assert.deepEqual(extractCodexAccountClaims(token), { accountId: 'fallback-sub-only' });
});

test('extractCodexAccountClaims extracts email + plan from the access token when present', () => {
  const token = makeJwt({
    sub: 'sub-1',
    email: 'user@example.test',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_x',
      chatgpt_plan_type: 'plus',
    },
  });
  assert.deepEqual(extractCodexAccountClaims(token), {
    accountId: 'acct_x',
    email: 'user@example.test',
    plan: 'plus',
  });
});

test('extractCodexAccountClaims fills picture + email from id_token when access token does not carry them', () => {
  const access = makeJwt({ sub: 'sub-2' });
  const id = makeJwt({
    picture: 'https://example.test/avatar.png',
    email: 'fill@example.test',
  });
  assert.deepEqual(extractCodexAccountClaims(access, id), {
    accountId: 'sub-2',
    picture: 'https://example.test/avatar.png',
    email: 'fill@example.test',
  });
});

test('extractCodexAccountClaims returns null when neither token contains an account id', () => {
  assert.equal(extractCodexAccountClaims(makeJwt({})), null);
  assert.equal(extractCodexAccountClaims('not-a-jwt'), null);
});
