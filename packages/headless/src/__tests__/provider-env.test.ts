import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  providerBaseUrlFromEnv,
  providerCredentialEnv,
  requireProviderCredentialEnv,
} from '../provider-env.js';

describe('provider credential environment', () => {
  test('keeps account tokens separate from platform API keys', () => {
    assert.deepEqual(providerCredentialEnv('openai-codex'), {
      apiKeys: ['OPENAI_CODEX_OAUTH_TOKEN'],
      apiKeyFile: 'OPENAI_CODEX_OAUTH_TOKEN_FILE',
      baseUrls: [],
    });
    assert.deepEqual(providerCredentialEnv('github-copilot'), {
      apiKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
      apiKeyFile: 'COPILOT_GITHUB_TOKEN_FILE',
      baseUrls: [],
    });
  });

  test('separates direct and plan credential namespaces', () => {
    const cases = [
      [
        'MiniMax',
        {
          apiKeys: ['MINIMAX_API_KEY'],
          apiKeyFile: 'MINIMAX_API_KEY_FILE',
          baseUrls: ['MINIMAX_BASE_URL'],
        },
      ],
      [
        'minimax-coding-plan',
        {
          apiKeys: ['MINIMAX_CODING_PLAN_API_KEY'],
          apiKeyFile: 'MINIMAX_CODING_PLAN_API_KEY_FILE',
          baseUrls: ['MINIMAX_CODING_PLAN_BASE_URL'],
        },
      ],
      [
        'stepfun',
        {
          apiKeys: ['STEPFUN_API_KEY'],
          apiKeyFile: 'STEPFUN_API_KEY_FILE',
          baseUrls: ['STEPFUN_BASE_URL'],
        },
      ],
      [
        'stepfun-step-plan',
        {
          apiKeys: ['STEPFUN_STEP_PLAN_API_KEY'],
          apiKeyFile: 'STEPFUN_STEP_PLAN_API_KEY_FILE',
          baseUrls: ['STEPFUN_STEP_PLAN_BASE_URL'],
        },
      ],
    ] as const;
    for (const [provider, expected] of cases) {
      assert.deepEqual(providerCredentialEnv(provider), expected, provider);
    }
  });

  test('preserves exceptional official credential names', () => {
    assert.deepEqual(providerCredentialEnv('huggingface'), {
      apiKeys: ['HF_TOKEN'],
      apiKeyFile: 'HF_TOKEN_FILE',
      baseUrls: ['HUGGINGFACE_BASE_URL'],
    });
    assert.deepEqual(providerCredentialEnv('vercel'), {
      apiKeys: ['AI_GATEWAY_API_KEY'],
      apiKeyFile: 'AI_GATEWAY_API_KEY_FILE',
      baseUrls: ['AI_GATEWAY_BASE_URL'],
    });
    assert.deepEqual(providerCredentialEnv('opencode-go'), {
      apiKeys: ['OPENCODE_API_KEY'],
      apiKeyFile: 'OPENCODE_API_KEY_FILE',
      baseUrls: ['OPENCODE_GO_BASE_URL'],
    });
  });

  test('rejects interactive plan identities in headless credential loading', () => {
    const unsupported = [
      'tencent-coding-plan',
      'volcengine-coding-plan',
      'volcengine-agent-plan',
      'tencent-token-plan',
      'alibaba-coding-plan-cn',
      'alibaba-coding-plan',
      'alibaba-token-plan-cn',
      'alibaba-token-plan',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-ams',
    ];
    for (const provider of unsupported) {
      assert.equal(providerCredentialEnv(provider), undefined, provider);
      assert.throws(
        () => requireProviderCredentialEnv(provider),
        new RegExp(`provider does not support API key files: ${provider}`),
      );
    }
  });

  test('derives Cloudflare base URLs only from explicit authority', () => {
    assert.deepEqual(providerCredentialEnv('cloudflare-workers-ai'), {
      apiKeys: ['CLOUDFLARE_API_KEY'],
      apiKeyFile: 'CLOUDFLARE_API_KEY_FILE',
      baseUrls: ['CLOUDFLARE_WORKERS_AI_BASE_URL'],
      accountId: 'CLOUDFLARE_ACCOUNT_ID',
    });
    assert.equal(
      providerBaseUrlFromEnv('cloudflare-workers-ai', {
        CLOUDFLARE_ACCOUNT_ID: 'account-123',
      }),
      'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1',
    );
    assert.equal(
      providerBaseUrlFromEnv('cloudflare-workers-ai', {
        CLOUDFLARE_ACCOUNT_ID: 'account-123',
        CLOUDFLARE_WORKERS_AI_BASE_URL: 'https://workers-ai.example.test/v1',
      }),
      'https://workers-ai.example.test/v1',
    );
    assert.equal(providerBaseUrlFromEnv('cloudflare-workers-ai', {}), undefined);
  });
});
