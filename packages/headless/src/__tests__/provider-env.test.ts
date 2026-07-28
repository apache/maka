import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  providerBaseUrlFromEnv,
  providerCredentialEnv,
  requireProviderCredentialEnv,
} from '../provider-env.js';

test('OpenAI Codex OAuth keeps account tokens separate from Platform API keys', () => {
  assert.deepEqual(providerCredentialEnv('openai-codex'), {
    apiKeys: ['OPENAI_CODEX_OAUTH_TOKEN'],
    apiKeyFile: 'OPENAI_CODEX_OAUTH_TOKEN_FILE',
    baseUrls: [],
  });
});

test('GitHub Copilot headless credentials are GitHub account tokens, not GitHub Models PATs', () => {
  assert.deepEqual(providerCredentialEnv('github-copilot'), {
    apiKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    apiKeyFile: 'COPILOT_GITHUB_TOKEN_FILE',
    baseUrls: [],
  });
});

test('MiniMax Coding Plan uses a credential namespace separate from MiniMax direct API', () => {
  assert.deepEqual(providerCredentialEnv('minimax-coding-plan'), {
    apiKeys: ['MINIMAX_CODING_PLAN_API_KEY'],
    apiKeyFile: 'MINIMAX_CODING_PLAN_API_KEY_FILE',
    baseUrls: ['MINIMAX_CODING_PLAN_BASE_URL'],
  });
  assert.deepEqual(providerCredentialEnv('MiniMax'), {
    apiKeys: ['MINIMAX_API_KEY'],
    apiKeyFile: 'MINIMAX_API_KEY_FILE',
    baseUrls: ['MINIMAX_BASE_URL'],
  });
});

test('xAI keeps provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('xai'), {
    apiKeys: ['XAI_API_KEY'],
    apiKeyFile: 'XAI_API_KEY_FILE',
    baseUrls: ['XAI_BASE_URL'],
  });
});

test('Xiaomi direct API keeps provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('xiaomi'), {
    apiKeys: ['XIAOMI_API_KEY'],
    apiKeyFile: 'XIAOMI_API_KEY_FILE',
    baseUrls: ['XIAOMI_BASE_URL'],
  });
});

test('Z.AI direct API uses its own credential namespace', () => {
  assert.deepEqual(providerCredentialEnv('zai'), {
    apiKeys: ['ZAI_API_KEY'],
    apiKeyFile: 'ZAI_API_KEY_FILE',
    baseUrls: ['ZAI_BASE_URL'],
  });
});

test('Cerebras credentials stay provider-scoped and support key files', () => {
  assert.deepEqual(providerCredentialEnv('cerebras'), {
    apiKeys: ['CEREBRAS_API_KEY'],
    apiKeyFile: 'CEREBRAS_API_KEY_FILE',
    baseUrls: ['CEREBRAS_BASE_URL'],
  });
});

test('Mistral keeps provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('mistral'), {
    apiKeys: ['MISTRAL_API_KEY'],
    apiKeyFile: 'MISTRAL_API_KEY_FILE',
    baseUrls: ['MISTRAL_BASE_URL'],
  });
});

test('Cohere keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('cohere'), {
    apiKeys: ['COHERE_API_KEY'],
    apiKeyFile: 'COHERE_API_KEY_FILE',
    baseUrls: ['COHERE_BASE_URL'],
  });
});

test('Hugging Face uses its official HF_TOKEN without accepting another provider key', () => {
  assert.deepEqual(providerCredentialEnv('huggingface'), {
    apiKeys: ['HF_TOKEN'],
    apiKeyFile: 'HF_TOKEN_FILE',
    baseUrls: ['HUGGINGFACE_BASE_URL'],
  });
});

test('Together AI keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('togetherai'), {
    apiKeys: ['TOGETHER_API_KEY'],
    apiKeyFile: 'TOGETHER_API_KEY_FILE',
    baseUrls: ['TOGETHER_BASE_URL'],
  });
});

test('DeepInfra keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('deepinfra'), {
    apiKeys: ['DEEPINFRA_API_KEY'],
    apiKeyFile: 'DEEPINFRA_API_KEY_FILE',
    baseUrls: ['DEEPINFRA_BASE_URL'],
  });
});

test('Groq keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('groq'), {
    apiKeys: ['GROQ_API_KEY'],
    apiKeyFile: 'GROQ_API_KEY_FILE',
    baseUrls: ['GROQ_BASE_URL'],
  });
});

test('OpenRouter keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('openrouter'), {
    apiKeys: ['OPENROUTER_API_KEY'],
    apiKeyFile: 'OPENROUTER_API_KEY_FILE',
    baseUrls: ['OPENROUTER_BASE_URL'],
  });
});

test('Ollama Cloud keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('ollama-cloud'), {
    apiKeys: ['OLLAMA_API_KEY'],
    apiKeyFile: 'OLLAMA_API_KEY_FILE',
    baseUrls: [],
  });
});

test('Cloudflare Workers AI separates account scope from API token credentials', () => {
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

test('Fireworks AI keeps provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('fireworks-ai'), {
    apiKeys: ['FIREWORKS_API_KEY'],
    apiKeyFile: 'FIREWORKS_API_KEY_FILE',
    baseUrls: ['FIREWORKS_BASE_URL'],
  });
});

test('NVIDIA credentials stay provider-scoped and support key files', () => {
  assert.deepEqual(providerCredentialEnv('nvidia'), {
    apiKeys: ['NVIDIA_API_KEY'],
    apiKeyFile: 'NVIDIA_API_KEY_FILE',
    baseUrls: ['NVIDIA_BASE_URL'],
  });
});

test('Tencent TokenHub keeps direct API credentials separate from Tencent plans', () => {
  assert.deepEqual(providerCredentialEnv('tencent-tokenhub'), {
    apiKeys: ['TENCENT_TOKENHUB_API_KEY'],
    apiKeyFile: 'TENCENT_TOKENHUB_API_KEY_FILE',
    baseUrls: ['TENCENT_TOKENHUB_BASE_URL'],
  });
});

test('Tencent Coding Plan is unavailable to non-interactive headless credential loading', () => {
  assert.equal(providerCredentialEnv('tencent-coding-plan'), undefined);
  assert.throws(
    () => requireProviderCredentialEnv('tencent-coding-plan'),
    /provider does not support API key files: tencent-coding-plan/,
  );
});

test('Volcengine Coding Plan is unavailable to non-interactive headless credential loading', () => {
  assert.equal(providerCredentialEnv('volcengine-coding-plan'), undefined);
  assert.throws(
    () => requireProviderCredentialEnv('volcengine-coding-plan'),
    /provider does not support API key files: volcengine-coding-plan/,
  );
});

test('Volcengine Agent Plan is unavailable to non-interactive headless credential loading', () => {
  assert.equal(providerCredentialEnv('volcengine-agent-plan'), undefined);
  assert.throws(
    () => requireProviderCredentialEnv('volcengine-agent-plan'),
    /provider does not support API key files: volcengine-agent-plan/,
  );
});

test('Tencent Token Plan is unavailable to non-interactive headless credential loading', () => {
  assert.equal(providerCredentialEnv('tencent-token-plan'), undefined);
  assert.throws(
    () => requireProviderCredentialEnv('tencent-token-plan'),
    /provider does not support API key files: tencent-token-plan/,
  );
});

test('Alibaba Coding Plan (China) is unavailable to non-interactive headless credential loading', () => {
  assert.equal(providerCredentialEnv('alibaba-coding-plan-cn'), undefined);
  assert.throws(
    () => requireProviderCredentialEnv('alibaba-coding-plan-cn'),
    /provider does not support API key files: alibaba-coding-plan-cn/,
  );
});

test('Alibaba Coding Plan (global) is unavailable to non-interactive headless credential loading', () => {
  assert.equal(providerCredentialEnv('alibaba-coding-plan'), undefined);
  assert.throws(
    () => requireProviderCredentialEnv('alibaba-coding-plan'),
    /provider does not support API key files: alibaba-coding-plan/,
  );
});

test('Alibaba Token Plan variants are unavailable to non-interactive headless credential loading', () => {
  for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
    assert.equal(providerCredentialEnv(providerType), undefined);
    assert.throws(
      () => requireProviderCredentialEnv(providerType),
      new RegExp(`provider does not support API key files: ${providerType}`),
    );
  }
});

for (const providerType of [
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'xiaomi-token-plan-ams',
] as const) {
  test(`${providerType} is unavailable to non-interactive headless credential loading`, () => {
    assert.equal(providerCredentialEnv(providerType), undefined);
    assert.throws(
      () => requireProviderCredentialEnv(providerType),
      new RegExp(`provider does not support API key files: ${providerType}`),
    );
  });
}

test('StepFun China keeps direct API credentials separate from global and plan identities', () => {
  assert.deepEqual(providerCredentialEnv('stepfun'), {
    apiKeys: ['STEPFUN_API_KEY'],
    apiKeyFile: 'STEPFUN_API_KEY_FILE',
    baseUrls: ['STEPFUN_BASE_URL'],
  });
});

test('StepFun Step Plan China uses an independent credential namespace', () => {
  assert.deepEqual(providerCredentialEnv('stepfun-step-plan'), {
    apiKeys: ['STEPFUN_STEP_PLAN_API_KEY'],
    apiKeyFile: 'STEPFUN_STEP_PLAN_API_KEY_FILE',
    baseUrls: ['STEPFUN_STEP_PLAN_BASE_URL'],
  });
});

test('StepFun Step Plan Global uses an independent credential namespace', () => {
  assert.deepEqual(providerCredentialEnv('stepfun-ai-step-plan'), {
    apiKeys: ['STEPFUN_AI_STEP_PLAN_API_KEY'],
    apiKeyFile: 'STEPFUN_AI_STEP_PLAN_API_KEY_FILE',
    baseUrls: ['STEPFUN_AI_STEP_PLAN_BASE_URL'],
  });
});

test('StepFun Global keeps direct API credentials separate from China and plan identities', () => {
  assert.deepEqual(providerCredentialEnv('stepfun-ai'), {
    apiKeys: ['STEPFUN_AI_API_KEY'],
    apiKeyFile: 'STEPFUN_AI_API_KEY_FILE',
    baseUrls: ['STEPFUN_AI_BASE_URL'],
  });
});

test('Volcengine Ark direct API uses its official credential namespace', () => {
  assert.deepEqual(providerCredentialEnv('volcengine-ark'), {
    apiKeys: ['ARK_API_KEY'],
    apiKeyFile: 'ARK_API_KEY_FILE',
    baseUrls: ['ARK_BASE_URL'],
  });
});

test('LocalAI exposes only its optional provider-scoped key and base URL env', () => {
  assert.deepEqual(providerCredentialEnv('localai'), {
    apiKeys: ['LOCALAI_API_KEY'],
    apiKeyFile: 'LOCALAI_API_KEY_FILE',
    baseUrls: ['LOCALAI_BASE_URL'],
  });
});

test('Vercel Gateway uses its official AI Gateway credential namespace', () => {
  assert.deepEqual(providerCredentialEnv('vercel'), {
    apiKeys: ['AI_GATEWAY_API_KEY'],
    apiKeyFile: 'AI_GATEWAY_API_KEY_FILE',
    baseUrls: ['AI_GATEWAY_BASE_URL'],
  });
});

test('ZenMux keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('zenmux'), {
    apiKeys: ['ZENMUX_API_KEY'],
    apiKeyFile: 'ZENMUX_API_KEY_FILE',
    baseUrls: ['ZENMUX_BASE_URL'],
  });
});

test('OpenCode Zen and Go share the official API key identity with independent endpoints', () => {
  assert.deepEqual(providerCredentialEnv('opencode'), {
    apiKeys: ['OPENCODE_API_KEY'],
    apiKeyFile: 'OPENCODE_API_KEY_FILE',
    baseUrls: ['OPENCODE_BASE_URL'],
  });
  assert.deepEqual(providerCredentialEnv('opencode-go'), {
    apiKeys: ['OPENCODE_API_KEY'],
    apiKeyFile: 'OPENCODE_API_KEY_FILE',
    baseUrls: ['OPENCODE_GO_BASE_URL'],
  });
});
