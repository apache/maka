/**
 * Focused unit tests for the quote companion's fork/guard/send orchestration and
 * event routing (extracted from `useQuoteCompanion` so the React hook stays a
 * thin shell — same pattern as `use-onboarding-snapshot.test.ts`). Covers the
 * review gaps: fork setup rejections are structured, the read-only guardrail
 * must fail CLOSED to `explore`, a created fork is exposed for hiding before the
 * permission round-trip, an unmount mid-create must not leak a hidden fork, a
 * failed OR `{ ok: false }` send must be retryable (quotes kept), the fork
 * branches at the latest settled turn, and interaction routing must resolve
 * web/custom-tool approvals.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionEvent, SessionSummary, StoredMessage, TurnRecord, TurnStatus } from '@maka/core';
import {
  applyCompanionInteractionEvent,
  deriveCompanionComposerState,
  isCompanionTurnTerminal,
  latestSettledTurnId,
  performCompanionTurn,
  type CompanionSessionApi,
} from '../../renderer/quote-companion-core.js';

function summary(id: string, permissionMode: string, model = 'm', slug = 'conn'): SessionSummary {
  return {
    id,
    name: id,
    permissionMode,
    model,
    llmConnectionSlug: slug,
    backend: 'anthropic',
    labels: [],
  } as unknown as SessionSummary;
}

function turn(turnId: string, status: TurnStatus): TurnRecord {
  return { turnId, status, partialOutputRetained: false };
}

interface FakeControl {
  turns?: TurnRecord[];
  listTurnsThrows?: boolean;
  branchThrows?: boolean;
  createThrows?: boolean;
  /** permissionMode `setPermissionMode` returns (default = the requested mode). */
  afterSetMode?: string;
  setModeThrows?: boolean;
  cleanupThrows?: boolean;
  sendThrows?: boolean;
  sendResult?: { ok: true } | { ok: false; reason?: string };
  /** Runs right after the fork is created (e.g. to flip `disposed`). */
  afterCreate?: () => void;
}

function makeApi(control: FakeControl = {}) {
  const calls = {
    removed: [] as string[],
    sent: [] as { id: string; cmd: { turnId: string; text: string; quotes?: unknown } }[],
    setMode: [] as [string, string][],
    branchedFrom: [] as string[],
    created: 0,
  };
  const forge = (): SessionSummary => {
    calls.created++;
    const forked = summary('fork-1', 'execute'); // inherits the parent's elevated mode
    control.afterCreate?.();
    return forked;
  };
  const api: CompanionSessionApi = {
    readMessages: async () => [{ turnId: 'x' } as unknown as StoredMessage],
    listTurns: async () => {
      if (control.listTurnsThrows) throw new Error('listTurns failed');
      return control.turns ?? [turn('main-turn-1', 'completed')];
    },
    branchFromTurn: async (_id, input) => {
      calls.branchedFrom.push(input.sourceTurnId);
      if (control.branchThrows) throw new Error('branchFromTurn failed');
      return forge();
    },
    create: async () => {
      if (control.createThrows) throw new Error('create failed');
      return forge();
    },
    setPermissionMode: async (id, mode) => {
      calls.setMode.push([id, mode]);
      if (control.setModeThrows) throw new Error('setPermissionMode failed');
      return summary(id, control.afterSetMode ?? mode);
    },
    cleanupQuoteCompanion: async (id) => {
      calls.removed.push(id);
      if (control.cleanupThrows) throw new Error('cleanup failed');
    },
    send: async (id, cmd) => {
      calls.sent.push({ id, cmd });
      if (control.sendThrows) throw new Error('send failed');
      return control.sendResult ?? { ok: true };
    },
  };
  return { api, calls };
}

function recorder() {
  const events: string[] = [];
  return {
    events,
    onForkCreated: (session: SessionSummary) => events.push(`created:${session.id}`),
    onForkCommitted: (session: SessionSummary) => events.push(`committed:${session.id}`),
    onBeforeSend: (forkId: string) => events.push(`beforeSend:${forkId}`),
    onQuotesConsumed: () => events.push('consumed'),
  };
}

const base = {
  sourceSession: summary('main', 'execute'),
  name: '追问：excerpt',
  turnId: 'T1',
  text: 'hello',
  quotes: [{ text: 'excerpt' }] as { text: string }[],
  existingForkId: null as string | null,
};

describe('latestSettledTurnId', () => {
  it('picks the latest non-running turn (skips a trailing running turn)', () => {
    assert.equal(
      latestSettledTurnId([turn('a', 'completed'), turn('b', 'completed'), turn('c', 'running')]),
      'b',
    );
    assert.equal(latestSettledTurnId([turn('a', 'running')]), undefined);
    assert.equal(latestSettledTurnId([]), undefined);
  });
});

describe('deriveCompanionComposerState', () => {
  it('keeps Stop and Escape available before the first token', () => {
    assert.deepEqual(
      deriveCompanionComposerState(true, {
        turnId: 'waiting-turn',
        phase: 'waiting',
        steps: [],
      }),
      { streaming: true, processing: true },
    );
  });

  it('keeps the turn interruptible after streaming starts without the wait presentation', () => {
    assert.deepEqual(
      deriveCompanionComposerState(true, {
        turnId: 'streaming-turn',
        phase: 'streamed',
        steps: [],
      }),
      { streaming: true, processing: false },
    );
  });

  it('leaves the Composer idle once the turn is terminal or no longer in flight', () => {
    assert.deepEqual(
      deriveCompanionComposerState(true, {
        turnId: 'terminal-turn',
        phase: 'streamed',
        terminal: true,
        steps: [],
      }),
      { streaming: false, processing: false },
    );
    assert.deepEqual(deriveCompanionComposerState(false, undefined), {
      streaming: false,
      processing: false,
    });
  });
});

describe('performCompanionTurn', () => {
  it('happy path: forks at the settled turn, confirms explore, sends, then commits + consumes', async () => {
    const { api, calls } = makeApi({
      turns: [turn('t-old', 'completed'), turn('t-settled', 'completed'), turn('t-running', 'running')],
      afterSetMode: 'explore',
    });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'sent', forkId: 'fork-1' });
    assert.deepEqual(calls.branchedFrom, ['t-settled']); // NOT the running turn
    assert.deepEqual(calls.setMode, [['fork-1', 'explore']]);
    assert.equal(calls.sent.length, 1);
    assert.deepEqual(calls.sent[0].cmd.quotes, [{ text: 'excerpt' }]);
    assert.deepEqual(calls.removed, []);
    // Quotes are consumed only AFTER the send is accepted.
    assert.deepEqual(rec.events, [
      'created:fork-1',
      'committed:fork-1',
      'beforeSend:fork-1',
      'consumed',
    ]);
  });

  it('reports the created id before awaiting the permission pin', async () => {
    const events: string[] = [];
    const { api } = makeApi({ afterSetMode: 'explore' });
    const originalSetPermissionMode = api.setPermissionMode;
    api.setPermissionMode = async (...args) => {
      events.push('pin-started');
      return originalSetPermissionMode(...args);
    };
    const result = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...base,
      onForkCreated: (session) => events.push(`created:${session.id}`),
      onForkCommitted: (session) => events.push(`committed:${session.id}`),
      onBeforeSend: () => events.push('send-started'),
      onQuotesConsumed: () => {},
    });
    assert.equal(result.status, 'sent');
    assert.deepEqual(events, [
      'created:fork-1',
      'pin-started',
      'committed:fork-1',
      'send-started',
    ]);
  });

  it('structures listTurns rejection and never creates or sends', async () => {
    const { api, calls } = makeApi({ listTurnsThrows: true });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'fork_setup_failed' });
    assert.equal(calls.created, 0);
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('structures branchFromTurn rejection and never pins or sends', async () => {
    const { api, calls } = makeApi({ branchThrows: true });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'fork_setup_failed' });
    assert.deepEqual(calls.setMode, []);
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('structures fallback create rejection and never pins or sends', async () => {
    const { api, calls } = makeApi({ turns: [], createThrows: true });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'fork_setup_failed' });
    assert.deepEqual(calls.setMode, []);
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('fail-closed: setPermissionMode throwing removes the fork and never sends', async () => {
    const { api, calls } = makeApi({ setModeThrows: true });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'permission_pin_failed' });
    assert.deepEqual(calls.removed, ['fork-1']);
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, ['created:fork-1']);
  });

  it('does not release a hidden fork when authoritative cleanup fails', async () => {
    const { api } = makeApi({ setModeThrows: true, cleanupThrows: true });
    const events: string[] = [];

    const result = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...base,
      onForkCreated: (session) => events.push(`created:${session.id}`),
      onForkCleanupSucceeded: (sessionId) => events.push(`cleaned:${sessionId}`),
      onForkCommitted: () => {},
      onBeforeSend: () => {},
      onQuotesConsumed: () => {},
    });
    await Promise.resolve();

    assert.deepEqual(result, { status: 'error', code: 'permission_pin_failed' });
    assert.deepEqual(events, ['created:fork-1']);
  });

  it('fail-closed: a fork not confirmed `explore` is removed and never sends', async () => {
    const { api, calls } = makeApi({ afterSetMode: 'execute' }); // stayed elevated
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'permission_pin_failed' });
    assert.deepEqual(calls.removed, ['fork-1']);
    assert.equal(calls.sent.length, 0);
  });

  it('unmount during create: removes the just-created fork and aborts (no send)', async () => {
    let disposed = false;
    const { api, calls } = makeApi({ afterSetMode: 'explore', afterCreate: () => {
      disposed = true;
    } });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => disposed, ...base, ...rec });
    assert.equal(result.status, 'disposed');
    assert.deepEqual(calls.removed, ['fork-1']);
    assert.deepEqual(calls.setMode, []); // bailed before pinning
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('send rejection (thrown) is retryable: arms but does NOT consume the staged quotes', async () => {
    const { api } = makeApi({ afterSetMode: 'explore', sendThrows: true });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'send_failed' });
    assert.equal(rec.events.includes('consumed'), false);
    assert.deepEqual(rec.events, [
      'created:fork-1',
      'committed:fork-1',
      'beforeSend:fork-1',
    ]);
  });

  it('non-throwing send rejection ({ ok: false }) surfaces an error and keeps quotes', async () => {
    const { api, calls } = makeApi({ afterSetMode: 'explore', sendResult: { ok: false } });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'send_rejected' });
    assert.equal(calls.sent.length, 1); // the send resolved, just not ok
    assert.equal(rec.events.includes('consumed'), false);
  });

  it('existing fork: skips creation + permission pin and sends directly', async () => {
    const { api, calls } = makeApi();
    const rec = recorder();
    const result = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...base,
      existingForkId: 'fork-existing',
      ...rec,
    });
    assert.deepEqual(result, { status: 'sent', forkId: 'fork-existing' });
    assert.equal(calls.created, 0);
    assert.deepEqual(calls.setMode, []);
    assert.deepEqual(rec.events, ['beforeSend:fork-existing', 'consumed']);
  });
});

describe('isCompanionTurnTerminal', () => {
  it('error, abort, and every complete event are terminal', () => {
    assert.equal(isCompanionTurnTerminal({ type: 'error' } as SessionEvent), true);
    assert.equal(isCompanionTurnTerminal({ type: 'abort' } as SessionEvent), true);
    assert.equal(
      isCompanionTurnTerminal({ type: 'complete', stopReason: 'end_turn' } as SessionEvent),
      true,
    );
    assert.equal(
      isCompanionTurnTerminal({ type: 'complete', stopReason: 'permission_handoff' } as SessionEvent),
      true,
    );
    assert.equal(isCompanionTurnTerminal({ type: 'text_delta' } as SessionEvent), false);
  });
});

describe('applyCompanionInteractionEvent', () => {
  const req = {
    type: 'sandbox_boundary_request',
    requestId: 'r1',
    toolUseId: 'tu1',
  } as unknown as SessionEvent;

  it('enqueues a request and ignores a duplicate requestId', () => {
    let queues = applyCompanionInteractionEvent({}, 'S', req);
    assert.equal(queues.S.length, 1);
    queues = applyCompanionInteractionEvent(queues, 'S', req);
    assert.equal(queues.S.length, 1);
  });

  it('a legacy permission_handoff complete clears the pending prompt', () => {
    const withPrompt = applyCompanionInteractionEvent({}, 'S', req);
    const afterHandoff = applyCompanionInteractionEvent(
      withPrompt,
      'S',
      { type: 'complete', stopReason: 'permission_handoff' } as SessionEvent,
    );
    assert.deepEqual(afterHandoff.S, []);
  });

  it('a terminal complete clears the queue', () => {
    const withPrompt = applyCompanionInteractionEvent({}, 'S', req);
    const cleared = applyCompanionInteractionEvent(
      withPrompt,
      'S',
      { type: 'complete', stopReason: 'end_turn' } as SessionEvent,
    );
    assert.equal(cleared.S.length, 0);
  });
});
