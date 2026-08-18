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
    assert.equal(resolved.result.disposition, 'created');
    assert.deepEqual(sessions.createdIds, ['session-1']);
  });

  test('keeps a crash-window claim until create defaults arrive', async () => {
    const authority = new MemoryAuthority();
    const sessions = new MemorySessions();
    authority.bindings.set('telegram:chat-1', 'session-claimed');
    const host = coordinator(authority, sessions, ['unused', 'unused-again']);

    assert.deepEqual(await host.reconcile({ kind: 'resolve', conversationId: 'telegram:chat-1' }), {
      ok: true,
      result: { kind: 'create_required' },
    });
    const outcome = await host.reconcile(resolveInput());
    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.result.kind !== 'resolved') return;
    assert.equal(outcome.result.session.id, 'session-claimed');
    assert.deepEqual(sessions.createdIds, ['session-claimed']);
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

  test('reads an existing binding without requiring Session create defaults', async () => {
    const authority = new MemoryAuthority();
    const sessions = new MemorySessions();
    authority.bindings.set('telegram:chat-1', 'session-1');
    sessions.records.set('session-1', session('session-1', false));
    const host = coordinator(authority, sessions, []);

    const outcome = await host.reconcile({
      kind: 'resolve',
      conversationId: 'telegram:chat-1',
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.result.kind !== 'resolved') return;
    assert.equal(outcome.result.disposition, 'existing');
    assert.equal(outcome.result.session.id, 'session-1');
  });

  test('asks for create defaults only when no live binding exists', async () => {
    const authority = new MemoryAuthority();
    const host = coordinator(authority, new MemorySessions(), []);
    assert.deepEqual(await host.reconcile({ kind: 'resolve', conversationId: 'telegram:chat-1' }), {
      ok: true,
      result: { kind: 'create_required' },
    });
  });

  test('drops a binding only after Session storage confirms removal', async () => {
    const authority = new MemoryAuthority();
    const sessions = new MemorySessions();
    authority.bindings.set('telegram:chat-1', 'session-removed');
    sessions.removedIds.add('session-removed');
    const host = coordinator(authority, sessions, []);

    assert.deepEqual(await host.reconcile({ kind: 'resolve', conversationId: 'telegram:chat-1' }), {
      ok: true,
      result: { kind: 'create_required' },
    });
    assert.equal(authority.bindings.has('telegram:chat-1'), false);
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
    assert.equal(right.ok, true);
    if (
      !left.ok ||
      !right.ok ||
      left.result.kind !== 'resolved' ||
      right.result.kind !== 'resolved'
    ) {
      return;
    }
    assert.equal(left.result.disposition, 'created');
    assert.equal(right.result.disposition, 'existing');
    assert.equal(right.result.session.id, left.result.session.id);
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

  async lookup(conversationId: string) {
    const sessionId = this.bindings.get(conversationId);
    return sessionId ? { sessionId, updatedAt: 1 } : undefined;
  }

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

  async listBoundSessionIds(): Promise<string[]> {
    return [...new Set(this.bindings.values())].sort();
  }
}

class MemorySessions {
  readonly records = new Map<string, SessionCatalogProjection>();
  readonly createdIds: string[] = [];
  readonly removedIds = new Set<string>();

  async probe(sessionId: string) {
    const record = this.records.get(sessionId);
    if (record) return { kind: 'present' as const, session: record };
    return this.removedIds.has(sessionId)
      ? { kind: 'removed' as const }
      : { kind: 'absent' as const };
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
      workspace: { kind: 'host_path' as const, path: '/workspace' },
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
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
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
