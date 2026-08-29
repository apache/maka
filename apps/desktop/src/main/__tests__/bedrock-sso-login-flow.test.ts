import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runBedrockSsoLogin,
  type BedrockSsoLoginBridge,
} from '../../shared/bedrock-sso-login-flow.js';

test('Bedrock renderer login advances through authorization to account and role selection', async () => {
  const calls: string[] = [];
  const host = { id: 'host' };
  const bridge: BedrockSsoLoginBridge<typeof host> = {
    start: async () => {
      calls.push('start');
      return { attemptId: 'attempt', phase: 'awaiting_authorization', userCode: 'ABCD-EFGH' };
    },
    query: async () => {
      calls.push('query');
      return { attemptId: 'attempt', phase: 'authenticated' };
    },
    listAccounts: async () => {
      calls.push('accounts');
      return { accounts: [{ accountId: '123456789012', accountName: 'Development' }] };
    },
    listRoles: async (_attemptId, accountId) => {
      calls.push(`roles:${accountId}`);
      return { roles: ['Developer'] };
    },
  };
  const projections: string[] = [];

  const result = await runBedrockSsoLogin({
    bridge,
    host,
    ssoStartUrl: 'https://example.awsapps.com/start',
    ssoRegion: 'us-east-1',
    region: 'us-west-2',
    isActive: () => true,
    wait: async () => undefined,
    onProjection: (projection) => projections.push(projection.phase),
  });

  assert.deepEqual(calls, ['start', 'query', 'accounts', 'roles:123456789012']);
  assert.deepEqual(projections, ['awaiting_authorization', 'authenticated']);
  assert.deepEqual(result, {
    attemptId: 'attempt',
    accounts: [{ accountId: '123456789012', accountName: 'Development' }],
    accountId: '123456789012',
    roles: ['Developer'],
    roleName: 'Developer',
  });
});

test('Bedrock renderer login stops before post-auth calls after cancellation', async () => {
  let active = true;
  let listedAccounts = false;
  const bridge: BedrockSsoLoginBridge<null> = {
    start: async () => ({ attemptId: 'attempt', phase: 'awaiting_authorization' }),
    query: async () => {
      active = false;
      return { attemptId: 'attempt', phase: 'authenticated' };
    },
    listAccounts: async () => {
      listedAccounts = true;
      return { accounts: [] };
    },
    listRoles: async () => ({ roles: [] }),
  };

  const result = await runBedrockSsoLogin({
    bridge,
    host: null,
    ssoStartUrl: 'https://example.awsapps.com/start',
    ssoRegion: 'us-east-1',
    region: 'us-west-2',
    isActive: () => active,
  });

  assert.equal(result, null);
  assert.equal(listedAccounts, false);
});
