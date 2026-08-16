import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PROVIDER_REGISTRY, type LlmConnection } from '@maka/core/llm-connections';
import { buildProviderOptions } from '../model-factory.js';
import { openAiCodexHeaders } from '../subscription-auth.js';
import { testConnection } from '../test-connection.js';

describe('Claude subscription runtime wiring', () => {
  test('testConnection treats resolved Claude OAuth token as a usable login', async () => {
    const result = await testConnection(claudeOAuthConnection(), 'oauth-access-token');
    assert.equal(result.ok, true);
  });

  test('testConnection never burns Claude OAuth quota with a synthetic messages probe', async () => {
    let requests = 0;
    const result = await testConnection(claudeOAuthConnection(), 'oauth-access-token', undefined, {
      fetch: async () => {
        requests += 1;
        throw new Error('Claude OAuth connection test must not issue a request');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requests, 0);
  });

  test('anthropicV1BaseUrl normalizes base URLs to a single /v1 suffix', async () => {
    const { anthropicV1BaseUrl } = await import('../provider-urls.js');
    assert.equal(
      anthropicV1BaseUrl('https://api.anthropic.com'),
      'https://api.anthropic.com/v1',
      'bare root gains /v1',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.anthropic.com/'),
      'https://api.anthropic.com/v1',
      'trailing slash is stripped before re-appending /v1',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.anthropic.com/v1'),
      'https://api.anthropic.com/v1',
      'already-versioned root is idempotent',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.kimi.com/coding/v1'),
      'https://api.kimi.com/coding/v1',
      'already-versioned override is idempotent',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.kimi.com/coding/'),
      'https://api.kimi.com/coding/v1',
      'override omitting /v1 gets it filled in',
    );
  });

  test('registry routes Anthropic and Kimi through the normalized API-key adapter', () => {
    assert.deepEqual(PROVIDER_REGISTRY.anthropic.runtimeAdapter, {
      kind: 'anthropic',
      auth: 'api-key',
      normalizeBaseUrl: true,
    });
    assert.deepEqual(PROVIDER_REGISTRY['kimi-coding-plan'].runtimeAdapter, {
      kind: 'anthropic',
      auth: 'api-key',
      normalizeBaseUrl: true,
    });
  });

  test('registry sends both MiniMax variants over Bearer without rewriting their base URL', () => {
    const expected = { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false };
    assert.deepEqual(PROVIDER_REGISTRY.MiniMax.runtimeAdapter, expected);
    assert.deepEqual(PROVIDER_REGISTRY['MiniMax-cn'].runtimeAdapter, expected);
  });

  test('testConnection treats resolved Codex OAuth token as a usable login', async () => {
    const result = await testConnection(codexOAuthConnection(), codexAccessToken('acct_test'));
    assert.equal(result.ok, true);
    assert.equal(result.modelTested, 'gpt-5.5');
  });

  test('Codex OAuth headers include ChatGPT Responses beta and account id', () => {
    const headers = openAiCodexHeaders(codexAccessToken('acct_test'));
    assert.equal(headers['OpenAI-Beta'], 'responses=experimental');
    assert.equal(headers['ChatGPT-Account-Id'], 'acct_test');
  });

  test('Codex OAuth headers do not fall back to JWT sub as ChatGPT account id', () => {
    const headers = openAiCodexHeaders(codexAccessTokenWithoutChatGptAccount('sub_not_account'));
    assert.equal(headers['ChatGPT-Account-Id'], undefined);
  });

  test('Codex OAuth provider options use non-persistent ChatGPT backend defaults', () => {
    assert.deepEqual(buildProviderOptions(codexOAuthConnection(), 'gpt-5.5'), {
      openai: { store: false, textVerbosity: 'medium' },
    });
  });
});

function claudeOAuthConnection(): LlmConnection {
  return {
    slug: 'claude-subscription',
    name: 'Claude OAuth',
    providerType: 'claude-subscription',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexOAuthConnection(): LlmConnection {
  return {
    slug: 'openai-codex',
    name: 'Codex OAuth',
    providerType: 'openai-codex',
    defaultModel: 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexAccessToken(accountId: string): string {
  return [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({
      sub: 'sub_fallback',
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
    'signature',
  ].join('.');
}

function codexAccessTokenWithoutChatGptAccount(sub: string): string {
  return [base64url({ alg: 'none', typ: 'JWT' }), base64url({ sub }), 'signature'].join('.');
}

function base64url(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
