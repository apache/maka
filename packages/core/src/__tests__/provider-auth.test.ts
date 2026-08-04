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
