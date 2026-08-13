import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXTERNAL_CONVERSATION_OPERATION_SPECS } from '../protocol/external-conversation.js';
import { operationAllowsRemoteOwner } from '../protocol/operations.js';
import {
  authorizeRuntimeHostOperation,
  createRuntimeHostConnectionAuthority,
} from '../server/connection-authority.js';

const reconcile = EXTERNAL_CONVERSATION_OPERATION_SPECS['external-conversation.reconcile'];

describe('external-conversation protocol', () => {
  test('is available to a remote Desktop owner', () => {
    assert.equal(operationAllowsRemoteOwner('external-conversation.reconcile'), true);
  });

  test('requires remote Host-path authority only when creating from a Host path', () => {
    const authority = createRuntimeHostConnectionAuthority({
      principalKind: 'remote_owner',
      principalId: 'remote-client',
      credentialId: 'remote-credential',
      operationGrants: ['external-conversation.reconcile'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const frame = (
      workspace?:
        | { readonly kind: 'project'; readonly projectId: string }
        | { readonly kind: 'host_path'; readonly path: string },
    ) => ({
      kind: 'request' as const,
      requestId: 'request-1',
      operation: 'external-conversation.reconcile' as const,
      input: {
        kind: 'resolve' as const,
        conversationId: 'telegram:chat-1',
        ...(workspace
          ? {
              session: {
                workspace,
                modelTarget: { kind: 'default' as const },
              },
            }
          : {}),
      },
    });

    assert.equal(authorizeRuntimeHostOperation(authority, frame()), true);
    assert.equal(
      authorizeRuntimeHostOperation(authority, frame({ kind: 'project', projectId: 'project-1' })),
      true,
    );
    assert.equal(
      authorizeRuntimeHostOperation(
        authority,
        frame({ kind: 'host_path', path: '/host/workspace' }),
      ),
      false,
    );
  });

  test('decodes resolve and release without accepting a Client-selected Session id', () => {
    assert.deepEqual(
      reconcile.decodeInput({
        kind: 'resolve',
        conversationId: 'slack:channel:C1:thread:123.456',
      }),
      {
        kind: 'resolve',
        conversationId: 'slack:channel:C1:thread:123.456',
      },
    );
    assert.deepEqual(
      reconcile.decodeInput({
        kind: 'resolve',
        conversationId: 'slack:channel:C1:thread:123.456',
        session: {
          workspace: { kind: 'host_path', path: '/workspace' },
          name: 'Slack thread',
          labels: ['bot', 'slack'],
          modelTarget: { kind: 'default' },
          permissionMode: 'explore',
        },
      }),
      {
        kind: 'resolve',
        conversationId: 'slack:channel:C1:thread:123.456',
        session: {
          workspace: { kind: 'host_path', path: '/workspace' },
          name: 'Slack thread',
          labels: ['bot', 'slack'],
          modelTarget: { kind: 'default' },
          permissionMode: 'explore',
        },
      },
    );
    assert.deepEqual(
      reconcile.decodeInput({
        kind: 'release',
        conversationId: 'slack:channel:C1:thread:123.456',
        operationId: 'bot_reset_1',
      }),
      {
        kind: 'release',
        conversationId: 'slack:channel:C1:thread:123.456',
        operationId: 'bot_reset_1',
      },
    );

    assert.throws(() =>
      reconcile.decodeInput({
        kind: 'resolve',
        conversationId: 'telegram:chat-1',
        session: {
          sessionId: 'client-selected',
          workspace: { kind: 'host_path', path: '/workspace' },
          modelTarget: { kind: 'default' },
        },
      }),
    );
  });

  test('keeps release retries entity-safe and the conversation identity bounded', () => {
    assert.throws(() =>
      reconcile.decodeInput({
        kind: 'release',
        conversationId: 'telegram:chat-1',
        operationId: 'contains:transport:punctuation',
      }),
    );
    assert.throws(() =>
      reconcile.decodeInput({
        kind: 'release',
        conversationId: 'x'.repeat(4 * 1024 + 1),
        operationId: 'bot_reset_1',
      }),
    );
  });
});
