import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  ExternalConversationAuthority,
  ExternalConversationResolveResult,
} from '@maka/storage/external-conversation-authority';
import type { SessionCatalogProjection, SessionCreateInput } from '../protocol/index.js';
import { HostExternalConversationCoordinator } from '../server/external-conversation-coordinator.js';

describe('HostExternalConversationCoordinator', () => {
  test('reuses a durable claim when the first Host dies before Session creation', async () => {
    const authority = new MemoryAuthority();
    const sessions = new MemorySessions();
    const first = coordinator(authority, sessions, ['session-1']);
    authority.failAfterClaim = true;
    assert.deepEqual(await first.reconcile(resolveInput()), {
      ok: false,
      error: {
        code: 'persistence_failed',
        message: 'External conversation binding is unavailable',
      },
    });

    const successor = coordinator(authority, sessions, ['session-2']);
    const resolved = await successor.reconcile(resolveInput());
    assert.equal(resolved.ok, true);
    if (!resolved.ok || resolved.result.kind !== 'resolved') return;
    assert.equal(resolved.result.session.id, 'session-1');
    assert.deepEqual(sessions.createdIds, ['session-1']);
  });

  test('retires an archived binding and creates one successor Session', async () => {
    const authority = new MemoryAuthority();
    const sessions = new MemorySessions();
    authority.bindings.set('telegram:chat-1', 'session-old');
    sessions.records.set('session-old', session('session-old', true));
    const host = coordinator(authority, sessions, ['unused-proposal', 'session-new']);

    const outcome = await host.reconcile(resolveInput());
    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.result.kind !== 'resolved') return;
    assert.equal(outcome.result.session.id, 'session-new');
    assert.equal(authority.bindings.get('telegram:chat-1'), 'session-new');
    assert.deepEqual(sessions.createdIds, ['session-new']);
  });

  test('serializes concurrent resolution through one binding and one Session create', async () => {
    const authority = new MemoryAuthority();
    const sessions = new MemorySessions();
    const host = coordinator(authority, sessions, ['session-1', 'session-2']);
    const [left, right] = await Promise.all([
      host.reconcile(resolveInput()),
      host.reconcile(resolveInput()),
    ]);
    assert.equal(left.ok, true);
    assert.deepEqual(right, left);
    assert.deepEqual(sessions.createdIds, ['session-1']);
  });

  test('releases through an exact operation receipt', async () => {
    const authority = new MemoryAuthority();
    const sessions = new MemorySessions();
    authority.bindings.set('telegram:chat-1', 'session-1');
    const host = coordinator(authority, sessions, []);
    const input = {
      kind: 'release' as const,
      conversationId: 'telegram:chat-1',
      operationId: 'source-1',
    };
    assert.deepEqual(await host.reconcile(input), {
      ok: true,
      result: { kind: 'released', hadBinding: true },
    });
    authority.bindings.set('telegram:chat-1', 'session-2');
    assert.deepEqual(await host.reconcile(input), {
      ok: true,
      result: { kind: 'released', hadBinding: true },
    });
    assert.equal(authority.bindings.get('telegram:chat-1'), 'session-2');
  });
});

class MemoryAuthority implements ExternalConversationAuthority {
  readonly bindings = new Map<string, string>();
  readonly releases = new Map<string, boolean>();
  failAfterClaim = false;

  async resolve(
    conversationId: string,
    proposedSessionId: string,
  ): Promise<ExternalConversationResolveResult> {
    const existing = this.bindings.get(conversationId);
    if (existing) {
      return { kind: 'existing', binding: { sessionId: existing, updatedAt: 1 } };
    }
    this.bindings.set(conversationId, proposedSessionId);
    if (this.failAfterClaim) {
      this.failAfterClaim = false;
      throw new Error('Host died after claim');
    }
    return { kind: 'claimed', binding: { sessionId: proposedSessionId, updatedAt: 1 } };
  }

  async release(conversationId: string, operationId: string): Promise<{ hadBinding: boolean }> {
    const receiptId = `${conversationId}:${operationId}`;
    const replay = this.releases.get(receiptId);
    if (replay !== undefined) return { hadBinding: replay };
    const hadBinding = this.bindings.delete(conversationId);
    this.releases.set(receiptId, hadBinding);
    return { hadBinding };
  }

  async remove(conversationId: string, expectedSessionId: string): Promise<boolean> {
    if (this.bindings.get(conversationId) !== expectedSessionId) return false;
    return this.bindings.delete(conversationId);
  }

  async purgeSession(sessionId: string): Promise<number> {
    let removed = 0;
    for (const [conversationId, boundSessionId] of this.bindings) {
      if (boundSessionId !== sessionId) continue;
      this.bindings.delete(conversationId);
      removed += 1;
    }
    return removed;
  }
}

class MemorySessions {
  readonly records = new Map<string, SessionCatalogProjection>();
  readonly createdIds: string[] = [];

  async get(sessionId: string): Promise<SessionCatalogProjection | null> {
    return this.records.get(sessionId) ?? null;
  }

  async create(input: SessionCreateInput) {
    const existing = this.records.get(input.sessionId);
    if (existing) return { ok: true as const, result: existing };
    const created = session(input.sessionId, false);
    this.records.set(input.sessionId, created);
    this.createdIds.push(input.sessionId);
    return { ok: true as const, result: created };
  }
}

function coordinator(
  authority: ExternalConversationAuthority,
  sessions: MemorySessions,
  ids: string[],
) {
  return new HostExternalConversationCoordinator({
    authority,
    sessions,
    newId: () => {
      const id = ids.shift();
      if (!id) throw new Error('Missing test Session id');
      return id;
    },
    requestDrain() {},
  });
}

function resolveInput() {
  return {
    kind: 'resolve' as const,
    conversationId: 'telegram:chat-1',
    session: {
      cwd: '/workspace',
      name: 'Telegram conversation',
      labels: ['bot', 'telegram'],
      modelTarget: { kind: 'default' as const },
      permissionMode: 'explore' as const,
    },
  };
}

function session(id: string, archived: boolean): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Bot conversation',
    isFlagged: false,
    isArchived: archived,
    labels: ['bot'],
    labelsTruncated: false,
    hasUnread: false,
    status: archived ? 'archived' : 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
