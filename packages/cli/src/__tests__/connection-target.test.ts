import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  listReadyModelChoices,
  resolveDefaultSessionTarget,
  selectableModelIdsForTarget,
} from '../connection-target.js';

describe('default session target resolver', () => {
  test('resolves OpenCode Go credentials without rewriting its exact model id', async () => {
    const connection = makeConnection({
      slug: 'opencode-go',
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      defaultModel: 'minimax-m3',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'opencode-go',
        get: async (slug) => (slug === 'opencode-go' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'opencode-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'opencode-go');
    assert.equal(target.apiKey, 'opencode-test-key');
    assert.equal(target.model, 'minimax-m3');
  });

  test('resolves Volcengine Coding Plan credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'volcengine-coding-plan',
      name: 'Volcengine Ark Coding Plan (China)',
      providerType: 'volcengine-coding-plan',
      defaultModel: 'kimi-k2.7-code',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'volcengine-coding-plan',
        get: async (slug) => (slug === 'volcengine-coding-plan' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) =>
          kind === 'api_key' ? 'volcengine-coding-plan-test-key' : null,
      },
    });

    assert.equal(target.connection.providerType, 'volcengine-coding-plan');
    assert.equal(target.apiKey, 'volcengine-coding-plan-test-key');
    assert.equal(target.model, 'kimi-k2.7-code');
  });

  test('resolves Volcengine Ark credentials without rewriting the snapshot model id', async () => {
    const modelId = 'doubao-seed-2-0-pro-260215';
    const connection = makeConnection({
      slug: 'volcengine-ark',
      name: 'Volcengine Ark (China)',
      providerType: 'volcengine-ark',
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'volcengine-ark',
        get: async (slug) => (slug === 'volcengine-ark' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'ark-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'volcengine-ark');
    assert.equal(target.apiKey, 'ark-test-key');
    assert.equal(target.model, modelId);
  });

  test('resolves Fireworks credentials without rewriting the exact model path', async () => {
    const connection = makeConnection({
      slug: 'fireworks-ai',
      name: 'Fireworks AI',
      providerType: 'fireworks-ai',
      defaultModel: 'accounts/fireworks/models/kimi-k2p6',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'fireworks-ai',
        get: async (slug) => (slug === 'fireworks-ai' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'fireworks-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'fireworks-ai');
    assert.equal(target.apiKey, 'fireworks-test-key');
    assert.equal(target.model, 'accounts/fireworks/models/kimi-k2p6');
  });

  test('resolves StepFun China credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'stepfun',
      name: 'StepFun (China)',
      providerType: 'stepfun',
      defaultModel: 'step-3.7-flash',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'stepfun',
        get: async (slug) => (slug === 'stepfun' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'stepfun-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'stepfun');
    assert.equal(target.apiKey, 'stepfun-test-key');
    assert.equal(target.model, 'step-3.7-flash');
  });

  test('resolves StepFun Step Plan credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'stepfun-step-plan',
      name: 'StepFun Step Plan (China)',
      providerType: 'stepfun-step-plan',
      defaultModel: 'step-router-v1',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'stepfun-step-plan',
        get: async (slug) => (slug === 'stepfun-step-plan' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) =>
          kind === 'api_key' ? 'stepfun-step-plan-test-key' : null,
      },
    });

    assert.equal(target.connection.providerType, 'stepfun-step-plan');
    assert.equal(target.apiKey, 'stepfun-step-plan-test-key');
    assert.equal(target.model, 'step-router-v1');
  });

  test('resolves StepFun Step Plan Global credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'stepfun-ai-step-plan',
      name: 'StepFun Step Plan (Global)',
      providerType: 'stepfun-ai-step-plan',
      defaultModel: 'step-3.5-flash-2603',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'stepfun-ai-step-plan',
        get: async (slug) => (slug === 'stepfun-ai-step-plan' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) =>
          kind === 'api_key' ? 'stepfun-global-step-plan-test-key' : null,
      },
    });

    assert.equal(target.connection.providerType, 'stepfun-ai-step-plan');
    assert.equal(target.apiKey, 'stepfun-global-step-plan-test-key');
    assert.equal(target.model, 'step-3.5-flash-2603');
  });

  test('resolves StepFun Global credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'stepfun-ai',
      name: 'StepFun (Global)',
      providerType: 'stepfun-ai',
      defaultModel: 'step-3.7-flash',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'stepfun-ai',
        get: async (slug) => (slug === 'stepfun-ai' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'stepfun-global-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'stepfun-ai');
    assert.equal(target.apiKey, 'stepfun-global-test-key');
    assert.equal(target.model, 'step-3.7-flash');
  });

  test('resolves Tencent TokenHub credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'tencent-tokenhub',
      name: 'Tencent TokenHub',
      providerType: 'tencent-tokenhub',
      defaultModel: 'hy3-preview',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'tencent-tokenhub',
        get: async (slug) => (slug === 'tencent-tokenhub' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'tencent-tokenhub-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'tencent-tokenhub');
    assert.equal(target.apiKey, 'tencent-tokenhub-test-key');
    assert.equal(target.model, 'hy3-preview');
  });

  test('resolves Tencent Coding Plan credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'tencent-coding-plan',
      name: 'Tencent Coding Plan (China)',
      providerType: 'tencent-coding-plan',
      defaultModel: 'glm-5',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'tencent-coding-plan',
        get: async (slug) => (slug === 'tencent-coding-plan' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) =>
          kind === 'api_key' ? 'tencent-coding-plan-test-key' : null,
      },
    });

    assert.equal(target.connection.providerType, 'tencent-coding-plan');
    assert.equal(target.apiKey, 'tencent-coding-plan-test-key');
    assert.equal(target.model, 'glm-5');
  });

  test('resolves Tencent Token Plan credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'tencent-token-plan',
      name: 'Tencent Token Plan',
      providerType: 'tencent-token-plan',
      defaultModel: 'deepseek-v4-pro-202606',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'tencent-token-plan',
        get: async (slug) => (slug === 'tencent-token-plan' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) =>
          kind === 'api_key' ? 'tencent-token-plan-test-key' : null,
      },
    });

    assert.equal(target.connection.providerType, 'tencent-token-plan');
    assert.equal(target.apiKey, 'tencent-token-plan-test-key');
    assert.equal(target.model, 'deepseek-v4-pro-202606');
  });

  test('resolves both Alibaba Coding Plan regions without rewriting the selected model id', async () => {
    for (const [providerType, defaultModel] of [
      ['alibaba-coding-plan-cn', 'qwen3.7-plus'],
      ['alibaba-coding-plan', 'qwen3-coder-plus'],
    ] as const) {
      const connection = makeConnection({
        slug: providerType,
        name: providerType,
        providerType,
        defaultModel,
      });

      const target = await resolveDefaultSessionTarget({
        connectionStore: {
          getDefault: async () => providerType,
          get: async (slug) => (slug === providerType ? connection : null),
        },
        credentialStore: {
          getSecret: async (_slug, kind) =>
            kind === 'api_key' ? `${providerType}-test-key` : null,
        },
      });

      assert.equal(target.connection.providerType, providerType);
      assert.equal(target.apiKey, `${providerType}-test-key`);
      assert.equal(target.model, defaultModel);
    }
  });

  test('resolves Alibaba Token Plan credentials without rewriting the selected model id', async () => {
    for (const [providerType, model] of [
      ['alibaba-token-plan-cn', 'qwen3.7-max'],
      ['alibaba-token-plan', 'deepseek-v4-pro'],
    ] as const) {
      const connection = makeConnection({
        slug: providerType,
        name: 'Alibaba Token Plan',
        providerType,
        defaultModel: model,
      });

      const target = await resolveDefaultSessionTarget({
        connectionStore: {
          getDefault: async () => providerType,
          get: async (slug) => (slug === providerType ? connection : null),
        },
        credentialStore: {
          getSecret: async (_slug, kind) =>
            kind === 'api_key' ? `${providerType}-test-key` : null,
        },
      });

      assert.equal(target.connection.providerType, providerType);
      assert.equal(target.apiKey, `${providerType}-test-key`);
      assert.equal(target.model, model);
    }
  });

  for (const providerType of [
    'xiaomi-token-plan-cn',
    'xiaomi-token-plan-sgp',
    'xiaomi-token-plan-ams',
  ] as const) {
    test(`resolves ${providerType} credentials without rewriting the selected model id`, async () => {
      const connection = makeConnection({
        slug: providerType,
        name: providerType,
        providerType,
        defaultModel: 'mimo-v2.5-pro',
      });

      const target = await resolveDefaultSessionTarget({
        connectionStore: {
          getDefault: async () => providerType,
          get: async (slug) => (slug === providerType ? connection : null),
        },
        credentialStore: {
          getSecret: async (_slug, kind) =>
            kind === 'api_key' ? `${providerType}-test-key` : null,
        },
      });

      assert.equal(target.connection.providerType, providerType);
      assert.equal(target.apiKey, `${providerType}-test-key`);
      assert.equal(target.model, 'mimo-v2.5-pro');
    });
  }

  test('resolves LM Studio without reading a credential or rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'lm-studio',
      name: 'LM Studio',
      providerType: 'lm-studio',
      defaultModel: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    });
    let credentialReads = 0;

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'lm-studio',
        get: async (slug) => (slug === 'lm-studio' ? connection : null),
      },
      credentialStore: {
        getSecret: async () => {
          credentialReads += 1;
          return null;
        },
      },
    });

    assert.equal(credentialReads, 0);
    assert.equal(target.connection.providerType, 'lm-studio');
    assert.equal(target.apiKey, '');
    assert.equal(target.model, 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF');
  });

  test('resolves LocalAI without requiring its optional credential or rewriting the exact alias', async () => {
    const model = 'localai/Qwen3-8B-Instruct-GGUF:Q4_K_M';
    const connection = makeConnection({
      slug: 'localai',
      name: 'LocalAI',
      providerType: 'localai',
      defaultModel: model,
    });
    const credentialReads: string[] = [];

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'localai',
        get: async (slug) => (slug === 'localai' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => {
          credentialReads.push(kind);
          return null;
        },
      },
    });

    assert.deepEqual(credentialReads, ['api_key']);
    assert.equal(target.connection.providerType, 'localai');
    assert.equal(target.apiKey, '');
    assert.equal(target.model, model);
  });

  test('resolves Cerebras credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'cerebras',
      name: 'Cerebras',
      providerType: 'cerebras',
      defaultModel: 'gpt-oss-120b',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'cerebras',
        get: async (slug) => (slug === 'cerebras' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'cerebras-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'cerebras');
    assert.equal(target.apiKey, 'cerebras-test-key');
    assert.equal(target.model, 'gpt-oss-120b');
  });

  test('resolves a Together AI API-key connection without rewriting its exact model id', async () => {
    const connection = makeConnection({
      slug: 'together',
      name: 'Together AI',
      providerType: 'togetherai',
      defaultModel: 'MiniMaxAI/MiniMax-M3',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'together',
        get: async (slug) => (slug === 'together' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'together-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'togetherai');
    assert.equal(target.apiKey, 'together-test-key');
    assert.equal(target.model, 'MiniMaxAI/MiniMax-M3');
  });

  test('resolves DeepInfra credentials without rewriting the exact model id', async () => {
    const modelId = 'moonshotai/Kimi-K2.7-Code';
    const connection = makeConnection({
      slug: 'deepinfra',
      name: 'Deep Infra',
      providerType: 'deepinfra',
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'deepinfra',
        get: async (slug) => (slug === 'deepinfra' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'deepinfra-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'deepinfra');
    assert.equal(target.apiKey, 'deepinfra-test-key');
    assert.equal(target.model, modelId);
  });

  test('resolves Groq credentials without rewriting the exact model id', async () => {
    const modelId = 'llama-3.3-70b-versatile';
    const connection = makeConnection({
      slug: 'groq',
      name: 'Groq',
      providerType: 'groq',
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'groq',
        get: async (slug) => (slug === 'groq' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'groq-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'groq');
    assert.equal(target.apiKey, 'groq-test-key');
    assert.equal(target.model, modelId);
  });

  test('resolves OpenRouter credentials without rewriting the exact model id', async () => {
    const modelId = 'anthropic/claude-sonnet-5';
    const connection = makeConnection({
      slug: 'openrouter',
      name: 'OpenRouter',
      providerType: 'openrouter',
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'openrouter',
        get: async (slug) => (slug === 'openrouter' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'openrouter-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'openrouter');
    assert.equal(target.apiKey, 'openrouter-test-key');
    assert.equal(target.model, modelId);
  });

  test('resolves Ollama Cloud credentials without crossing into local Ollama state', async () => {
    const modelId = 'qwen3.5:397b';
    const connection = makeConnection({
      slug: 'ollama-cloud',
      name: 'Ollama Cloud',
      providerType: 'ollama-cloud',
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'ollama-cloud',
        get: async (slug) => (slug === 'ollama-cloud' ? connection : null),
      },
      credentialStore: {
        getSecret: async (slug, kind) =>
          slug === 'ollama-cloud' && kind === 'api_key' ? 'ollama-cloud-test-key' : null,
      },
    });

    assert.equal(target.connection.providerType, 'ollama-cloud');
    assert.equal(target.apiKey, 'ollama-cloud-test-key');
    assert.equal(target.model, modelId);
  });

  test('resolves Cloudflare Workers AI credentials without rewriting account scope or model id', async () => {
    const modelId = '@cf/moonshotai/kimi-k2.6';
    const baseUrl = 'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1';
    const connection = makeConnection({
      slug: 'cloudflare-workers-ai',
      name: 'Cloudflare Workers AI',
      providerType: 'cloudflare-workers-ai',
      baseUrl,
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'cloudflare-workers-ai',
        get: async (slug) => (slug === 'cloudflare-workers-ai' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) =>
          kind === 'api_key' ? 'cloudflare-workers-ai-test-token' : null,
      },
    });

    assert.equal(target.connection.providerType, 'cloudflare-workers-ai');
    assert.equal(target.connection.baseUrl, baseUrl);
    assert.equal(target.apiKey, 'cloudflare-workers-ai-test-token');
    assert.equal(target.model, modelId);
  });

  test('resolves NVIDIA credentials without rewriting the selected model id', async () => {
    const modelId = 'nvidia/nemotron-3-super-120b-a12b';
    const connection = makeConnection({
      slug: 'nvidia',
      name: 'NVIDIA',
      providerType: 'nvidia',
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'nvidia',
        get: async (slug) => (slug === 'nvidia' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'nvidia-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'nvidia');
    assert.equal(target.apiKey, 'nvidia-test-key');
    assert.equal(target.model, modelId);
  });

  test('resolves MiniMax Coding Plan credentials without rewriting the selected model id', async () => {
    const connection = makeConnection({
      slug: 'minimax-plan',
      name: 'MiniMax Coding Plan',
      providerType: 'minimax-coding-plan',
      defaultModel: 'MiniMax-M2.7-highspeed',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'minimax-plan',
        get: async (slug) => (slug === 'minimax-plan' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'minimax-plan-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'minimax-coding-plan');
    assert.equal(target.apiKey, 'minimax-plan-test-key');
    assert.equal(target.model, 'MiniMax-M2.7-highspeed');
  });

  test('resolves an xAI API-key connection without rewriting its exact model id', async () => {
    const connection = makeConnection({
      slug: 'xai',
      name: 'xAI',
      providerType: 'xai',
      defaultModel: 'grok-4.5',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'xai',
        get: async (slug) => (slug === 'xai' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'xai-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'xai');
    assert.equal(target.apiKey, 'xai-test-key');
    assert.equal(target.model, 'grok-4.5');
  });

  test('resolves a Mistral API-key connection without rewriting its exact model id', async () => {
    const connection = makeConnection({
      slug: 'mistral',
      name: 'Mistral',
      providerType: 'mistral',
      defaultModel: 'mistral-small-2603',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'mistral',
        get: async (slug) => (slug === 'mistral' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'mistral-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'mistral');
    assert.equal(target.apiKey, 'mistral-test-key');
    assert.equal(target.model, 'mistral-small-2603');
  });

  test('resolves a Cohere API-key connection without rewriting its exact model id', async () => {
    const connection = makeConnection({
      slug: 'cohere',
      name: 'Cohere',
      providerType: 'cohere',
      defaultModel: 'command-a-plus-05-2026',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'cohere',
        get: async (slug) => (slug === 'cohere' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'cohere-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'cohere');
    assert.equal(target.apiKey, 'cohere-test-key');
    assert.equal(target.model, 'command-a-plus-05-2026');
  });

  test('resolves a Hugging Face token without rewriting its exact routing suffix', async () => {
    const modelId = 'openai/gpt-oss-120b:preferred';
    const connection = makeConnection({
      slug: 'huggingface',
      name: 'Hugging Face',
      providerType: 'huggingface',
      defaultModel: modelId,
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'huggingface',
        get: async (slug) => (slug === 'huggingface' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'hf-test-token' : null),
      },
    });

    assert.equal(target.connection.providerType, 'huggingface');
    assert.equal(target.apiKey, 'hf-test-token');
    assert.equal(target.model, modelId);
  });

  for (const provider of [
    { type: 'xiaomi', label: 'Xiaomi', modelId: 'mimo-v2.5' },
    { type: 'zai', label: 'Z.AI', modelId: 'glm-5.2' },
  ] as const) {
    test(`resolves ${provider.label} credentials without rewriting its exact model id`, async () => {
      const connection = makeConnection({
        slug: provider.type,
        name: provider.label,
        providerType: provider.type,
        defaultModel: provider.modelId,
      });

      const target = await resolveDefaultSessionTarget({
        connectionStore: {
          getDefault: async () => provider.type,
          get: async (slug) => (slug === provider.type ? connection : null),
        },
        credentialStore: {
          getSecret: async (_slug, kind) =>
            kind === 'api_key' ? `${provider.type}-test-key` : null,
        },
      });

      assert.equal(target.connection.providerType, provider.type);
      assert.equal(target.apiKey, `${provider.type}-test-key`);
      assert.equal(target.model, provider.modelId);
    });
  }

  test('resolves a SiliconFlow registry connection without rewriting its model id', async () => {
    const connection = makeConnection({
      slug: 'siliconflow',
      name: 'SiliconFlow',
      providerType: 'siliconflow',
      defaultModel: 'moonshotai/Kimi-K2.6',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'siliconflow',
        get: async (slug) => (slug === 'siliconflow' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'sf-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'siliconflow');
    assert.equal(target.apiKey, 'sf-test-key');
    assert.equal(target.model, 'moonshotai/Kimi-K2.6');
  });

  test('resolves a Vercel Gateway connection without rewriting its creator/model id', async () => {
    const connection = makeConnection({
      slug: 'vercel',
      name: 'Vercel AI Gateway',
      providerType: 'vercel',
      defaultModel: 'xai/grok-4.3',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'vercel',
        get: async (slug) => (slug === 'vercel' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'vercel-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'vercel');
    assert.equal(target.apiKey, 'vercel-test-key');
    assert.equal(target.model, 'xai/grok-4.3');
  });

  test('resolves ZenMux credentials without rewriting the exact creator/model id', async () => {
    const connection = makeConnection({
      slug: 'zenmux',
      name: 'ZenMux',
      providerType: 'zenmux',
      defaultModel: 'moonshotai/kimi-k2.5',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'zenmux',
        get: async (slug) => (slug === 'zenmux' ? connection : null),
      },
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'zenmux-test-key' : null),
      },
    });

    assert.equal(target.connection.providerType, 'zenmux');
    assert.equal(target.apiKey, 'zenmux-test-key');
    assert.equal(target.model, 'moonshotai/kimi-k2.5');
  });

  test('uses the default ready connection and requested model', async () => {
    const connection = makeConnection({
      slug: 'local',
      providerType: 'ollama',
      defaultModel: 'qwen2.5-coder',
      // Requested model must be user-enabled; discovered catalog alone is not enough.
      enabledModelIds: ['qwen2.5-coder', 'llama3.2'],
      models: [{ id: 'qwen2.5-coder' }, { id: 'llama3.2' }],
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'local',
        get: async (slug) => (slug === 'local' ? connection : null),
      },
      credentialStore: {
        getSecret: async () => null,
      },
      requestedModel: 'llama3.2',
    });

    assert.equal(target.connection.slug, 'local');
    assert.equal(target.apiKey, '');
    assert.equal(target.model, 'llama3.2');
  });

  test('uses a stored subscription access token for OAuth default connections', async () => {
    const connection = makeConnection({
      slug: 'openai-codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'openai-codex',
        get: async (slug) => (slug === 'openai-codex' ? connection : null),
      },
      credentialStore: {
        getSecret: async () =>
          JSON.stringify({
            access_token: 'oauth-access-token',
            refresh_token: 'oauth-refresh-token',
            expires_at: Date.now() + 10 * 60_000,
            account_id: 'acct_123',
          }),
      },
    });

    assert.equal(target.connection.slug, 'openai-codex');
    assert.equal(target.apiKey, 'oauth-access-token');
    assert.equal(target.model, 'gpt-5.5');
  });

  test('refreshes an expired OAuth subscription token before selecting the default target', async () => {
    const connection = makeConnection({
      slug: 'openai-codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
    });
    let stored = JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: 1_000,
      account_id: 'acct_123',
    });
    let refreshBody = '';

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'openai-codex',
        get: async (slug) => (slug === 'openai-codex' ? connection : null),
      },
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => {
          stored = value;
        },
      },
      now: () => 10_000,
      fetchFn: async (_url, init) => {
        refreshBody = String(init?.body ?? '');
        return Response.json({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        });
      },
    });

    assert.equal(target.apiKey, 'fresh-access-token');
    assert.match(refreshBody, /grant_type=refresh_token/);
    assert.match(refreshBody, /refresh_token=oauth-refresh-token/);
    assert.equal(JSON.parse(stored).access_token, 'fresh-access-token');
  });

  test('uses the GitHub Copilot account endpoint from the shared OAuth credential record', async () => {
    const connection = makeConnection({
      slug: 'github-copilot',
      providerType: 'github-copilot',
      baseUrl: 'https://api.githubcopilot.com',
      defaultModel: 'gpt-5.4',
    });
    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'github-copilot',
        get: async () => connection,
      },
      credentialStore: {
        getSecret: async () =>
          JSON.stringify({
            access_token: 'github-account-token',
            refresh_token: 'github-account-token',
            expires_at: Date.now() + 10 * 60_000,
            base_url: 'https://api.business.githubcopilot.com',
          }),
      },
    });

    assert.equal(target.apiKey, 'github-account-token');
    assert.equal(target.connection.baseUrl, 'https://api.business.githubcopilot.com');
  });

  test('rejects unusable OAuth subscription credentials instead of using the raw secret as an API key', async () => {
    const connection = makeConnection({
      slug: 'openai-codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
    });
    const expiredToken = JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: 1_000,
      account_id: 'acct_123',
    });

    for (const secret of ['not-json', expiredToken]) {
      await assert.rejects(
        resolveDefaultSessionTarget({
          connectionStore: {
            getDefault: async () => 'openai-codex',
            get: async (slug) => (slug === 'openai-codex' ? connection : null),
          },
          credentialStore: {
            getSecret: async () => secret,
            setSecret: async () => {
              throw new Error('refresh should fail before storing');
            },
          },
          now: () => 10_000,
          fetchFn: async () => new Response('refresh failed', { status: 500 }),
        }),
        /NO_REAL_CONNECTION:missing_api_key/,
      );
    }
  });

  test('fails before session creation when no default connection exists', async () => {
    await assert.rejects(
      resolveDefaultSessionTarget({
        connectionStore: {
          getDefault: async () => null,
          get: async () => null,
        },
        credentialStore: {
          getSecret: async () => null,
        },
      }),
      /NO_REAL_CONNECTION:missing_default_connection/,
    );
  });
});

describe('selectableModelIdsForTarget', () => {
  test('filters the picker to the connection enabledModelIds, keeping the current model selectable', () => {
    const connection = makeConnection({
      providerType: 'ollama',
      defaultModel: 'glm-5.2',
      enabledModelIds: ['glm-5.2'],
      models: [{ id: 'glm-5.2' }, { id: 'glm-5-air' }, { id: 'glm-4.6' }],
    });

    // The session is currently on glm-5-air: it stays selectable even though
    // the user curated it out; the rest of the catalog (glm-4.6) stays hidden.
    assert.deepEqual(selectableModelIdsForTarget({ connection, model: 'glm-5-air' }), [
      'glm-5-air',
      'glm-5.2',
    ]);
  });

  test('legacy connections without enabledModelIds collapse to the default model, never the full catalog', () => {
    const connection = makeConnection({
      providerType: 'ollama',
      defaultModel: 'glm-5.2',
      models: [{ id: 'glm-5.2' }, { id: 'glm-5-air' }],
    });

    assert.deepEqual(selectableModelIdsForTarget({ connection, model: 'glm-5.2' }), ['glm-5.2']);
  });
});

describe('listReadyModelChoices', () => {
  test('lists only enabledModelIds for connections with a curated model set', async () => {
    const zai = makeConnection({
      slug: 'zai',
      name: 'Z.ai',
      providerType: 'ollama', // authKind none → ready without a stored secret
      defaultModel: 'glm-5.2',
      enabledModelIds: ['glm-5.2'],
      models: [{ id: 'glm-5.2' }, { id: 'glm-5-air' }],
    });

    const choices = await listReadyModelChoices({
      connectionStore: {
        list: async () => [zai],
        getDefault: async () => 'zai',
      },
      credentialStore: {
        getSecret: async () => null,
      },
    });

    // glm-5-air is discovered but curated out on desktop, so the TUI picker
    // must not offer it either.
    assert.deepEqual(
      choices.map((choice) => choice.model),
      ['glm-5.2'],
    );
  });

  test('lists models across every ready connection and skips fake / not-ready', async () => {
    const zai = makeConnection({
      slug: 'zai',
      name: 'Z.ai',
      providerType: 'ollama', // authKind none → ready without a stored secret
      defaultModel: 'glm-5.2',
      enabledModelIds: ['glm-5.2', 'glm-5-air'],
      models: [{ id: 'glm-5.2' }, { id: 'glm-5-air' }],
    });
    const openai = makeConnection({
      slug: 'openai',
      name: 'OpenAI',
      providerType: 'openai', // needs an api key
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5' }],
    });
    const openaiNoKey = makeConnection({
      slug: 'openai-2',
      name: 'OpenAI 2',
      providerType: 'openai',
      defaultModel: 'gpt-5.5',
    });
    const fake = makeConnection({
      slug: 'fake',
      name: 'Fake',
      providerType: 'ollama',
      defaultModel: 'x',
    });

    const choices = await listReadyModelChoices({
      connectionStore: {
        list: async () => [zai, openai, openaiNoKey, fake],
        getDefault: async () => 'zai',
      },
      credentialStore: {
        getSecret: async (slug) => (slug === 'openai' ? 'sk-real' : null),
      },
    });

    // Two ready connections contribute; the keyless OpenAI and the fake are skipped.
    assert.deepEqual(
      choices.filter((choice) => choice.connectionSlug === 'zai').map((choice) => choice.model),
      ['glm-5.2', 'glm-5-air'],
    );
    assert.deepEqual(
      choices.filter((choice) => choice.connectionSlug === 'openai').map((choice) => choice.model),
      ['gpt-5.5'],
    );
    assert.equal(
      choices.some((choice) => choice.connectionSlug === 'openai-2'),
      false,
    );
    assert.equal(
      choices.some((choice) => choice.connectionSlug === 'fake'),
      false,
    );
    // The default connection is flagged so the picker can mark it.
    assert.equal(
      choices.find((choice) => choice.connectionSlug === 'zai')?.isDefaultConnection,
      true,
    );
    assert.equal(
      choices.find((choice) => choice.connectionSlug === 'openai')?.isDefaultConnection,
      false,
    );
    assert.equal(choices.find((choice) => choice.connectionSlug === 'zai')?.connectionName, 'Z.ai');
  });

  test('skips a connection whose credential read throws instead of failing the whole list', async () => {
    // A local keyless connection plus an API connection whose stored credentials
    // are corrupt/legacy, so reading its secret throws.
    const local = makeConnection({
      slug: 'local',
      name: 'Local',
      providerType: 'ollama', // authKind none → no secret read
      defaultModel: 'qwen',
      models: [{ id: 'qwen' }],
    });
    const broken = makeConnection({
      slug: 'openai',
      name: 'OpenAI',
      providerType: 'openai', // needs a secret → getSecret is called and throws
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5' }],
    });

    const choices = await listReadyModelChoices({
      connectionStore: {
        list: async () => [local, broken],
        getDefault: async () => 'local',
      },
      credentialStore: {
        getSecret: async (slug) => {
          if (slug === 'openai') throw new Error('credentials.json is unreadable');
          return null;
        },
      },
    });

    // The broken connection is skipped; the keyless local model still lists, so
    // startup (which awaits this) survives an unrelated corrupt credential file.
    assert.deepEqual(
      choices.map((choice) => choice.connectionSlug),
      ['local'],
    );
    assert.deepEqual(
      choices.map((choice) => choice.model),
      ['qwen'],
    );
  });
});

function makeConnection(input: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'conn',
    name: 'Connection',
    providerType: 'ollama',
    defaultModel: 'llama3.2',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}
