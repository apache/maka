import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProviderType } from '@maka/core';
import { createOAuthModelConnectionsMainService } from '../oauth-model-connections-main.js';

describe('managed OAuth model connection disconnect', () => {
  it('logs out the owning account service so a deleted connection cannot be materialized again', async () => {
    const calls: string[] = [];
    const ok = async (provider: string) => {
      calls.push(provider);
      return { ok: true as const };
    };
    const service = createOAuthModelConnectionsMainService({
      connectionStore: {} as never,
      credentialStore: {} as never,
      claudeSubscription: { logout: () => ok('claude-subscription') } as never,
      openAiCodex: { logout: () => ok('openai-codex') } as never,
      githubCopilotSubscription: { logout: () => ok('github-copilot') } as never,
      xaiOAuth: { logout: () => ok('xai-oauth') } as never,
    });

    for (const providerType of [
      'claude-subscription',
      'openai-codex',
      'github-copilot',
      'xai-oauth',
    ] satisfies ProviderType[]) {
      await service.disconnectManagedOAuthConnection({ providerType });
    }
    await service.disconnectManagedOAuthConnection({ providerType: 'openai' });
    assert.deepEqual(calls, [
      'claude-subscription',
      'openai-codex',
      'github-copilot',
      'xai-oauth',
    ]);
  });

  it('fails closed when the account service cannot log out', async () => {
    const service = createOAuthModelConnectionsMainService({
      connectionStore: {} as never,
      credentialStore: {} as never,
      claudeSubscription: {} as never,
      openAiCodex: {
        logout: async () => ({
          ok: false as const,
          reason: 'storage_failed',
          message: 'Could not remove the stored OAuth credential',
        }),
      } as never,
      githubCopilotSubscription: {} as never,
      xaiOAuth: {} as never,
    });

    await assert.rejects(
      service.disconnectManagedOAuthConnection({ providerType: 'openai-codex' }),
      /Could not remove the stored OAuth credential/,
    );
  });
});
