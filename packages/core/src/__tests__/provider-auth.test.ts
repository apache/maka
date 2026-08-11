import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import { deriveProviderAuthContract } from '../provider-auth.js';

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
  });

  test('maps verified credentials to validation state', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'zai-coding-plan',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    expect(contract.state).toBe('validated');
    expect(contract.validationStatus).toBe('verified');
  });

  test('maps authentication failures to distinct repair states', () => {
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
    expect(error.state).toBe('error');
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
    expect(contract.actionAvailability.fetch_models).toBe('hidden');
    expect(contract.actionAvailability.start_oauth).toBe('hidden');
    expect(contract.actionAvailability.refresh_oauth).toBe('available');
    expect(contract.actionAvailability.revoke_auth).toBe('available');
  });

  test('a discovery-capable wired OAuth provider keeps fetch_models available after login', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai-codex',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    expect(contract.setupMode).toBe('oauth');
    expect(contract.actionAvailability.fetch_models).toBe('available');
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
  });

  test('disabled providers hide actions regardless of stored credential state', () => {
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
});
