import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GitHubCopilotSubscriptionService } from '../oauth/github-copilot-subscription-service.js';

describe('GitHubCopilotSubscriptionService', () => {
  test('prefers an explicit Copilot Requests credential over the generic GitHub CLI login', async () => {
    const previous = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = 'github_pat_copilot_requests';
    let stored: string | null = null;
    let authorization = '';
    try {
      const service = new GitHubCopilotSubscriptionService({
        credentialStore: {
          getSecret: async () => stored,
          setSecret: async (_slug, _kind, value) => { stored = value; },
          deleteSecret: async () => { stored = null; },
        },
        fetchFn: async (url, init) => {
          assert.equal(String(url), 'https://api.githubcopilot.com/models');
          authorization = new Headers(init?.headers).get('authorization') ?? '';
          return copilotModelsResponse();
        },
      });

      const result = await service.connectExistingLogin();
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.models.map(({ id }) => id), ['gpt-5.4']);
      assert.equal(authorization, 'Bearer github_pat_copilot_requests');
      assert.ok(stored);
    } finally {
      if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
      else process.env.COPILOT_GITHUB_TOKEN = previous;
    }
  });

  test('imports a supported existing gh login into the shared OAuth credential lifecycle', async () => {
    let stored: string | null = null;
    let requestAuthorization = '';
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => { stored = value; },
        deleteSecret: async () => { stored = null; },
      },
      resolveGitHubToken: async () => 'gho_existing_login\n',
      fetchFn: async (url, init) => {
        assert.equal(String(url), 'https://api.githubcopilot.com/models');
        requestAuthorization = new Headers(init?.headers).get('authorization') ?? '';
        return copilotModelsResponse();
      },
    });

    const result = await service.connectExistingLogin();
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.models.map(({ id }) => id), ['gpt-5.4']);
    assert.equal(requestAuthorization, 'Bearer gho_existing_login');
    assert.deepEqual(JSON.parse(stored ?? ''), {
      access_token: 'gho_existing_login',
      refresh_token: 'gho_existing_login',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
    assert.deepEqual(await service.getAccountState(), {
      provider: 'github-copilot',
      runtimeState: 'authenticated',
    });
  });

  test('rejects classic PATs before any Copilot request', async () => {
    let requested = false;
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: memoryCredentialStore(),
      resolveGitHubToken: async () => 'ghp_classic_pat',
      fetchFn: async () => {
        requested = true;
        return Response.json({});
      },
    });

    const result = await service.connectExistingLogin();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'token_exchange_failed');
      assert.match(result.message, /不支持 classic PAT/);
      assert.equal(result.message.includes('ghp_classic_pat'), false);
    }
    assert.equal(requested, false);
  });

  test('explains subscription or Copilot Requests policy rejection without exposing provider details', async () => {
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
      resolveGitHubToken: async () => 'gho_without_copilot_permission',
      fetchFn: async () => new Response(null, { status: 403 }),
    });

    const result = await service.connectExistingLogin();
    assert.equal(result.ok, false);
    assert.match(result.message, /Copilot Requests/);
    assert.doesNotMatch(result.message, /404|gho_without/);
  });

  test('refreshes and logs out through the same store without exposing either token in state', async () => {
    let stored: string | null = JSON.stringify({
      access_token: 'github_pat_supported',
      refresh_token: 'github_pat_supported',
      expires_at: Number.MAX_SAFE_INTEGER,
      base_url: 'https://api.githubcopilot.com',
    });
    let writes = 0;
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => {
          writes += 1;
          stored = value;
        },
        deleteSecret: async () => { stored = null; },
      },
      now: () => 10_000,
      fetchFn: async () => copilotModelsResponse(),
    });

    const result = await service.refreshTokens();
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.models.map(({ id }) => id), ['gpt-5.4']);
    assert.equal(writes, 0, 'validating an unchanged durable token must not rewrite it after network I/O');
    const state = await service.getAccountState();
    assert.deepEqual(state, { provider: 'github-copilot', runtimeState: 'authenticated' });
    assert.equal('access_token' in state, false);
    assert.equal('refresh_token' in state, false);
    assert.deepEqual(await service.logout(), { ok: true });
    assert.deepEqual(await service.getAccountState(), {
      provider: 'github-copilot',
      runtimeState: 'not_logged_in',
    });
  });

  test('signs in with a GitHub device grant and adopts the account it authorizes', async () => {
    let stored: string | null = null;
    let modelsAuthorization = '';
    let polls = 0;
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => { stored = value; },
        deleteSecret: async () => { stored = null; },
      },
      // The device grant must never fall back to a locally discovered token:
      // a login the user did not authorize here would be the old behaviour.
      resolveGitHubToken: async () => { throw new Error('local discovery must not run'); },
      fetchFn: async (url, init) => {
        const target = String(url);
        if (target === 'https://github.com/login/device/code') {
          return Response.json({
            device_code: 'device-code',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 1,
          });
        }
        if (target === 'https://github.com/login/oauth/access_token') {
          polls += 1;
          return polls === 1
            ? Response.json({ error: 'authorization_pending' })
            : Response.json({ access_token: 'gho_device_granted' });
        }
        assert.equal(target, 'https://api.githubcopilot.com/models');
        modelsAuthorization = new Headers(init?.headers).get('authorization') ?? '';
        return copilotModelsResponse();
      },
    });

    const started = await service.beginDeviceLogin();
    assert.equal(started.ok, true);
    if (started.ok) {
      assert.equal(started.userCode, 'ABCD-1234');
      assert.equal(started.verificationUrl, 'https://github.com/login/device');
    }

    const completed = await service.completeDeviceLogin();
    assert.equal(completed.ok, true);
    if (completed.ok) assert.deepEqual(completed.models.map(({ id }) => id), ['gpt-5.4']);
    assert.equal(polls, 2);
    assert.equal(modelsAuthorization, 'Bearer gho_device_granted');
    assert.ok(stored);
    // The grant is spent: a second completion must not replay it.
    assert.equal((await service.completeDeviceLogin()).ok, false);
  });

  test('reports a completion with no pending device grant instead of starting one', async () => {
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
      fetchFn: async () => { throw new Error('no request may be issued'); },
    });
    assert.equal((await service.completeDeviceLogin()).ok, false);
  });
});

function copilotModelsResponse(): Response {
  return Response.json({
    data: [{
      id: 'gpt-5.4',
      model_picker_enabled: true,
      supported_endpoints: ['/responses'],
      policy: { state: 'enabled' },
      capabilities: {
        limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_000 },
        supports: { tool_calls: true },
      },
    }],
  });
}

function memoryCredentialStore() {
  return {
    getSecret: async () => null,
    setSecret: async () => undefined,
    deleteSecret: async () => undefined,
  };
}
