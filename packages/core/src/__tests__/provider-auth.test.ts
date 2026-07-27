import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  PROVIDER_AUTH_ACTIONS,
  deriveProviderAuthContract,
  deriveProviderAuthContractFromConnection,
  isProviderAuthState,
} from '../provider-auth.js';
import type { LlmConnection } from '../llm-connections.js';

describe('ProviderAuth contract', () => {
  test('Ollama Cloud requires its own API key and exposes remote model discovery', () => {
    const missing = deriveProviderAuthContract({
      providerType: 'ollama-cloud',
      hasSecret: false,
    });
    const configured = deriveProviderAuthContract({
      providerType: 'ollama-cloud',
      hasSecret: true,
    });

    expect(missing.setupMode).toBe('api_key');
    expect(missing.requiresSecret).toBe(true);
    expect(missing.sendMayUseWithoutSecret).toBe(false);
    expect(missing.actionAvailability.fetch_models).toBe('hidden');
    expect(configured.actionAvailability.test_credentials).toBe('available');
    expect(configured.actionAvailability.fetch_models).toBe('available');
  });

  test('DeepInfra uses the shared API-key credential and model-discovery flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'deepinfra',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('deepinfra');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('Groq uses the shared API-key credential and model-discovery flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'groq',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('groq');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('OpenRouter uses the shared API-key credential and model-discovery flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openrouter',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('openrouter');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('Cloudflare Workers AI uses API-token auth with honest snapshot model discovery', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'cloudflare-workers-ai',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('cloudflare-workers-ai');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('Volcengine Ark Coding Plan uses an isolated API key and hides unsupported refresh', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'volcengine-coding-plan',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('volcengine-coding-plan');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('Tencent Token Plan uses an independent API key and fallback-model flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'tencent-token-plan',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('tencent-token-plan');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('Alibaba Token Plan variants use an independent API key and fallback-model flow', () => {
    for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
      const contract = deriveProviderAuthContract({ providerType, hasSecret: true });

      expect(contract.providerType).toBe(providerType);
      expect(contract.setupMode).toBe('api_key');
      expect(contract.requiresSecret).toBe(true);
      expect(contract.actionAvailability.test_credentials).toBe('available');
      expect(contract.actionAvailability.fetch_models).toBe('hidden');
    }
  });

  for (const providerType of [
    'xiaomi-token-plan-cn',
    'xiaomi-token-plan-sgp',
    'xiaomi-token-plan-ams',
  ] as const) {
    test(`${providerType} uses an independent API key and fallback-model flow`, () => {
      const contract = deriveProviderAuthContract({
        providerType,
        hasSecret: true,
      });

      expect(contract.providerType).toBe(providerType);
      expect(contract.setupMode).toBe('api_key');
      expect(contract.requiresSecret).toBe(true);
      expect(contract.actionAvailability.test_credentials).toBe('available');
      expect(contract.actionAvailability.fetch_models).toBe('hidden');
    });
  }

  test('Tencent Coding Plan uses the shared API-key credential and fallback-model flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'tencent-coding-plan',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('tencent-coding-plan');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('Alibaba Coding Plan (China) uses an independent API key and fallback-model flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'alibaba-coding-plan-cn',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('alibaba-coding-plan-cn');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('Alibaba Coding Plan (global) uses an independent API key and fallback-model flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'alibaba-coding-plan',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('alibaba-coding-plan');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('StepFun Global uses an independent API-key credential and model-discovery flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'stepfun-ai',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('stepfun-ai');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('StepFun China uses the shared API-key credential and model-discovery flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'stepfun',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('stepfun');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('StepFun Step Plan China uses an independent API-key credential and snapshot-model flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'stepfun-step-plan',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('stepfun-step-plan');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('StepFun Step Plan Global uses an independent API-key credential and snapshot-model flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'stepfun-ai-step-plan',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('stepfun-ai-step-plan');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('Volcengine Ark China uses the shared API-key credential and snapshot-model flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'volcengine-ark',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('volcengine-ark');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
  });

  test('Together AI uses the shared API-key credential flow under its stable provider id', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'togetherai',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('togetherai');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
  });

  test('Fireworks AI uses the shared API-key credential flow', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'fireworks-ai',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('fireworks-ai');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('Vercel Gateway requires one stored key and exposes its public model discovery action', () => {
    const missing = deriveProviderAuthContract({
      providerType: 'vercel',
      hasSecret: false,
    });
    expect(missing.setupMode).toBe('api_key');
    expect(missing.requiresSecret).toBe(true);
    expect(missing.actionAvailability.test_credentials).toBe('hidden');
    expect(missing.actionAvailability.fetch_models).toBe('hidden');

    const configured = deriveProviderAuthContract({
      providerType: 'vercel',
      hasSecret: true,
    });
    expect(configured.providerType).toBe('vercel');
    expect(configured.actionAvailability.test_credentials).toBe('available');
    expect(configured.actionAvailability.fetch_models).toBe('available');
  });

  test('ZenMux requires one stored key while keeping its public bounded discovery available', () => {
    const missing = deriveProviderAuthContract({ providerType: 'zenmux', hasSecret: false });
    expect(missing.setupMode).toBe('api_key');
    expect(missing.requiresSecret).toBe(true);
    expect(missing.actionAvailability.test_credentials).toBe('hidden');
    expect(missing.actionAvailability.fetch_models).toBe('hidden');

    const configured = deriveProviderAuthContract({ providerType: 'zenmux', hasSecret: true });
    expect(configured.providerType).toBe('zenmux');
    expect(configured.actionAvailability.test_credentials).toBe('available');
    expect(configured.actionAvailability.fetch_models).toBe('available');
  });

  test('MiniMax Coding Plan uses the shared API-key credential flow under its own provider id', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'minimax-coding-plan',
      hasSecret: true,
    });

    expect(contract.providerType).toBe('minimax-coding-plan');
    expect(contract.setupMode).toBe('api_key');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('model-key providers expose credential actions only after a secret exists', () => {
    const missing = deriveProviderAuthContract({
      providerType: 'openai',
      hasSecret: false,
    });

    expect(missing.setupMode).toBe('api_key');
    expect(missing.state).toBe('not_configured');
    expect(missing.validationStatus).toBe('not_run');
    expect(missing.requiresSecret).toBe(true);
    expect(missing.sendMayUseWithoutSecret).toBe(false);
    expect(missing.actionAvailability.save_secret).toBe('available');
    expect(missing.actionAvailability.test_credentials).toBe('hidden');
    expect(missing.actionAvailability.fetch_models).toBe('hidden');
    expect(missing.actionAvailability.start_oauth).toBe('hidden');

    const configured = deriveProviderAuthContract({
      providerType: 'openai',
      hasSecret: true,
    });

    expect(configured.state).toBe('configured');
    expect(configured.actionAvailability.test_credentials).toBe('available');
    expect(configured.actionAvailability.fetch_models).toBe('available');
    expect(configured.actionAvailability.revoke_auth).toBe('available');
    expect(configured.copy.detail).toContain('等待验证');
    expect(configured.copy.detail.includes('尚未验证')).toBe(false);
  });

  test('credential validation success is not runtime operational readiness', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'zai-coding-plan',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    expect(contract.state).toBe('validated');
    expect(contract.validationStatus).toBe('verified');
    expect(contract.copy.detail).toContain('不代表消息发送');
    expect(contract.copy.detail).toContain('流式响应');
    expect(contract.copy.detail).toContain('中断恢复');
  });

  test('auth failures preserve distinct repair states without raw provider errors', () => {
    const needsReauth = deriveProviderAuthContract({
      providerType: 'anthropic',
      hasSecret: true,
      lastTestStatus: 'needs_reauth',
    });
    const error = deriveProviderAuthContract({
      providerType: 'anthropic',
      hasSecret: true,
      lastTestStatus: 'error',
    });

    expect(needsReauth.state).toBe('needs_reauth');
    expect(needsReauth.copy.detail).toContain('鉴权失败');
    expect(error.state).toBe('error');
    expect(error.copy.detail).toContain('概括后的错误信息');
    expect(JSON.stringify(error.copy).includes('401')).toBe(false);
    expect(JSON.stringify(error.copy).includes('sk-')).toBe(false);
  });

  test('wired OAuth subscription providers expose real validation actions after login', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'claude-subscription',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    expect(contract.setupMode).toBe('oauth');
    expect(contract.state).toBe('validated');
    expect(contract.validationStatus).toBe('verified');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.sendMayUseWithoutSecret).toBe(false);
    expect(contract.actionAvailability.save_secret).toBe('hidden');
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
    expect(contract.actionAvailability.start_oauth).toBe('hidden');
    expect(contract.actionAvailability.refresh_oauth).toBe('available');
    expect(contract.actionAvailability.revoke_auth).toBe('available');
    expect(contract.copy.label).toContain('OAuth 已验证');
    expect(contract.copy.detail).toContain('账号令牌和端点验证通过');
    expect(contract.copy.detail.includes('API key 连接仍是聊天模型的可用路径')).toBe(false);
  });

  test('wired OAuth subscription providers route missing login to the OAuth setup path', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai-codex',
      hasSecret: false,
    });

    expect(contract.setupMode).toBe('oauth');
    expect(contract.state).toBe('not_configured');
    expect(contract.validationStatus).toBe('not_run');
    expect(contract.actionAvailability.start_oauth).toBe('available');
    expect(contract.actionAvailability.test_credentials).toBe('hidden');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
    expect(contract.copy.label).toContain('等待 OAuth 登录');
    expect(contract.copy.detail).toContain('用于聊天发送');
  });

  test('xAI OAuth exposes the runnable account-login contract', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'xai-oauth',
      hasSecret: false,
    });

    expect(contract.setupMode).toBe('oauth');
    expect(contract.state).toBe('not_configured');
    expect(contract.actionAvailability.start_oauth).toBe('available');
    expect(contract.actionAvailability.refresh_oauth).toBe('hidden');
    expect(contract.actionAvailability.revoke_auth).toBe('hidden');
  });

  test('unwired OAuth providers stay preview-only and do not expose live actions', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'gemini-cli',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    expect(contract.setupMode).toBe('oauth_preview');
    expect(contract.state).toBe('preview_only');
    expect(contract.validationStatus).toBe('not_run');
    expect(contract.requiresSecret).toBe(true);
    expect(contract.sendMayUseWithoutSecret).toBe(false);
    expect(contract.actionAvailability.save_secret).toBe('hidden');
    expect(contract.actionAvailability.test_credentials).toBe('hidden');
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
    expect(contract.actionAvailability.start_oauth).toBe('preview_only');
    expect(contract.actionAvailability.refresh_oauth).toBe('preview_only');
    expect(contract.actionAvailability.revoke_auth).toBe('preview_only');
    expect(contract.copy.label).toContain('账号登录预览');
    expect(contract.copy.detail).toContain('普通模型密钥连接仍可在聊天模型中使用');
    expect(contract.copy.label.includes('待接入')).toBe(false);
    expect(contract.copy.detail.includes('尚未开放')).toBe(false);
  });

  test('no-auth local providers can send without secret but are still not validated runtime probes', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'ollama',
      hasSecret: false,
    });

    expect(contract.setupMode).toBe('none');
    expect(contract.state).toBe('configured');
    expect(contract.validationStatus).toBe('not_required');
    expect(contract.requiresSecret).toBe(false);
    expect(contract.sendMayUseWithoutSecret).toBe(true);
    expect(contract.actionAvailability.save_secret).toBe('hidden');
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
    expect(contract.copy.detail).toContain('本地服务');
  });

  test('LM Studio uses the shared no-auth configuration flow under its own provider id', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'lm-studio',
      hasSecret: false,
    });

    expect(contract.providerType).toBe('lm-studio');
    expect(contract.setupMode).toBe('none');
    expect(contract.requiresSecret).toBe(false);
    expect(contract.sendMayUseWithoutSecret).toBe(true);
    expect(contract.actionAvailability.save_secret).toBe('hidden');
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
  });

  test('LocalAI keeps API-key setup available without making the key required', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'localai',
      hasSecret: false,
    });

    expect(contract.setupMode).toBe('api_key');
    expect(contract.state).toBe('configured');
    expect(contract.validationStatus).toBe('not_required');
    expect(contract.requiresSecret).toBe(false);
    expect(contract.sendMayUseWithoutSecret).toBe(true);
    expect(contract.actionAvailability.save_secret).toBe('available');
    expect(contract.actionAvailability.test_credentials).toBe('available');
    expect(contract.actionAvailability.fetch_models).toBe('available');
    expect(contract.copy.detail).toContain('可选');
  });

  test('LocalAI preserves endpoint validation failures without making its optional key required', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'localai',
      hasSecret: true,
      lastTestStatus: 'needs_reauth',
    });

    expect(contract.state).toBe('needs_reauth');
    expect(contract.validationStatus).toBe('needs_reauth');
    expect(contract.requiresSecret).toBe(false);
    expect(contract.sendMayUseWithoutSecret).toBe(true);
    expect(contract.copy.label).toContain('需要重新授权');
  });

  test('disabled providers hide actions regardless of stored credential state', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai',
      enabled: false,
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    expect(contract.state).toBe('disabled');
    expect(contract.validationStatus).toBe('verified');
    expect(Object.values(contract.actionAvailability).every((value) => value === 'hidden')).toBe(
      true,
    );
  });

  test('disabled OAuth preview providers do not expose preview actions', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'claude-subscription',
      enabled: false,
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    expect(contract.setupMode).toBe('oauth');
    expect(contract.state).toBe('disabled');
    expect(contract.validationStatus).toBe('verified');
    expect(Object.values(contract.actionAvailability).every((value) => value === 'hidden')).toBe(
      true,
    );
  });

  test('connection wrapper consumes only metadata plus caller-supplied secret presence', () => {
    const connection: LlmConnection = {
      slug: 'zai',
      name: 'Z.ai',
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-4.7',
      enabled: true,
      lastTestStatus: 'verified',
      createdAt: 1,
      updatedAt: 2,
    };

    const contract = deriveProviderAuthContractFromConnection(connection, true);

    expect(contract.providerType).toBe('zai-coding-plan');
    expect(contract.state).toBe('validated');
    expect(contract.validationStatus).toBe('verified');
  });

  test('locks provider auth state guard', () => {
    expect(isProviderAuthState('validated')).toBe(true);
    expect(isProviderAuthState('operational')).toBe(false);
  });

  test('action availability map covers every closed action key', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai',
      hasSecret: true,
    });

    expect(Object.keys(contract.actionAvailability).sort()).toEqual(
      [...PROVIDER_AUTH_ACTIONS].sort(),
    );
  });
});

describe('ProviderAuth contract unknown-providerType fallback', () => {
  // A connection persisted on another branch may carry a providerType this
  // build's PROVIDER_REGISTRY doesn't know. The contract must
  // surface a non-real, non-actionable state instead of crashing on
  // `defaults.modelDiscovery` / `defaults.authKind`. Mirrors `isFakeBackend`.
  test('enabled unknown provider → not_configured, no actions, no secret required', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'branch-only-provider' as never,
      enabled: true,
      hasSecret: true,
    });

    expect(contract.providerType).toBe('branch-only-provider');
    expect(contract.setupMode).toBe('none');
    expect(contract.state).toBe('not_configured');
    expect(contract.requiresSecret).toBe(false);
    expect(contract.sendMayUseWithoutSecret).toBe(false);
    expect(contract.validationStatus).toBe('not_required');
    for (const action of PROVIDER_AUTH_ACTIONS) {
      expect(contract.actionAvailability[action]).toBe('hidden');
    }
    expect(contract.copy.label).toContain('branch-only-provider');
  });

  test('disabled unknown provider → disabled state', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'branch-only-provider' as never,
      enabled: false,
      hasSecret: false,
    });

    expect(contract.state).toBe('disabled');
  });

  test('deriveProviderAuthContractFromConnection tolerates an unknown providerType', () => {
    const contract = deriveProviderAuthContractFromConnection(
      {
        providerType: 'branch-only-provider' as never,
        enabled: true,
        lastTestStatus: undefined,
      } as never,
      true,
    );

    expect(contract.state).toBe('not_configured');
    expect(contract.setupMode).toBe('none');
  });
});
