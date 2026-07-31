import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { deleteConnectionWithCredential } from '../delete-connection-with-credential.js';

function connection(): LlmConnection {
  return {
    slug: 'codex-subscription',
    name: 'Codex OAuth',
    providerType: 'openai-codex',
    defaultModel: 'gpt-5.6-sol',
    enabled: true,
    enabledModelIds: ['gpt-5.6-sol'],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('deleteConnectionWithCredential', () => {
  it('disconnects an account-managed connection before removing its catalog row', async () => {
    const calls: string[] = [];
    await deleteConnectionWithCredential(
      {
        connectionStore: {
          get: async () => connection(),
          delete: async (slug) => {
            calls.push(`delete:${slug}`);
          },
        },
        credentialStore: {
          deleteSecret: async (slug) => {
            calls.push(`credential:${slug}`);
          },
        },
        disconnectManagedOAuthConnection: async (item) => {
          calls.push(`disconnect:${item.providerType}`);
        },
      },
      'codex-subscription',
    );

    assert.deepEqual(calls, [
      'disconnect:openai-codex',
      'delete:codex-subscription',
      'credential:codex-subscription',
    ]);
  });

  it('does not remove the connection when account logout fails', async () => {
    const calls: string[] = [];
    await assert.rejects(
      deleteConnectionWithCredential(
        {
          connectionStore: {
            get: async () => connection(),
            delete: async () => {
              calls.push('delete');
            },
          },
          credentialStore: {
            deleteSecret: async () => {
              calls.push('credential');
            },
          },
          disconnectManagedOAuthConnection: async () => {
            calls.push('disconnect');
            throw new Error('logout failed');
          },
        },
        'codex-subscription',
      ),
      /logout failed/,
    );

    assert.deepEqual(calls, ['disconnect']);
  });

  it('keeps deletion idempotent when the catalog row is already gone', async () => {
    const calls: string[] = [];
    await deleteConnectionWithCredential(
      {
        connectionStore: {
          get: async () => null,
          delete: async (slug) => {
            calls.push(`delete:${slug}`);
          },
        },
        credentialStore: {
          deleteSecret: async (slug) => {
            calls.push(`credential:${slug}`);
          },
        },
        disconnectManagedOAuthConnection: async () => {
          calls.push('disconnect');
        },
      },
      'missing',
    );

    assert.deepEqual(calls, ['delete:missing', 'credential:missing']);
  });
});
