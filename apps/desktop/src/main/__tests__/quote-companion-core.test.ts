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
import { afterEach, describe, it } from 'node:test';
import type { SessionEvent, SessionSummary, StoredMessage, TurnRecord, TurnStatus } from '@maka/core';
import {
  abandonPendingCompanionCopy,
  applyCompanionInteractionEvent,
  cleanupCompanionCopy,
  createCompanionDismissalGuard,
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
  loseFirstBranchResponse?: boolean;
  createdId?: string;
  /** permissionMode `setPermissionMode` returns (default = the requested mode). */
  afterSetMode?: string;
  setModeThrows?: boolean;
  cleanupThrows?: boolean;
  abandonThrows?: boolean;
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
    branchedFrom: [] as Array<{ sourceTurnId: string; copyId: string }>,
    abandoned: [] as string[],
    created: 0,
  };
  const api: CompanionSessionApi = {
    readMessages: async () => [{ turnId: 'x' } as unknown as StoredMessage],
    listTurns: async () => {
      if (control.listTurnsThrows) throw new Error('listTurns failed');
      return control.turns ?? [turn('main-turn-1', 'completed')];
    },
    branchFromTurn: async (_id, input) => {
      calls.branchedFrom.push(input);
      if (control.branchThrows) throw new Error('branchFromTurn failed');
      const forked = summary(control.createdId ?? input.copyId, 'execute');
      calls.created++;
      control.afterCreate?.();
      if (control.loseFirstBranchResponse) {
        control.loseFirstBranchResponse = false;
        throw new Error('Committed response was lost');
      }
      return forked;
    },
    setPermissionMode: async (id, mode) => {
      calls.setMode.push([id, mode]);
      if (control.setModeThrows) throw new Error('setPermissionMode failed');
      return summary(id, control.afterSetMode ?? mode);
    },
    cleanupSessionCopy: async (id) => {
      calls.removed.push(id);
      if (control.cleanupThrows) throw new Error('cleanup failed');
    },
    abandonSessionCopy: async (id) => {
      calls.abandoned.push(id);
      if (control.abandonThrows) throw new Error('abandon acknowledgement lost');
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

afterEach(async () => {
  const { api } = makeApi();
  for (const sourceSessionId of ['main', 'quote-retry-source', 'quote-abandon-source']) {
    await abandonPendingCompanionCopy(api, sourceSessionId);
  }
});

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

describe('companion dismissal guard', () => {
  it('ignores a StrictMode effect replay but accepts the current mount dismissal', () => {
    const guard = createCompanionDismissalGuard();
    const replayedCleanup = guard.beginMount();
    const activeCleanup = guard.beginMount();

    assert.equal(replayedCleanup(), false);
    assert.equal(activeCleanup(), true);
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
    assert.equal(result.status, 'sent');
    assert.deepEqual(calls.branchedFrom.map(({ sourceTurnId }) => sourceTurnId), ['t-settled']);
    assert.deepEqual(calls.setMode, [[calls.branchedFrom[0]!.copyId, 'explore']]);
    assert.equal(calls.sent.length, 1);
    assert.deepEqual(calls.sent[0].cmd.quotes, [{ text: 'excerpt' }]);
    assert.deepEqual(calls.removed, []);
    // Quotes are consumed only AFTER the send is accepted.
    assert.deepEqual(rec.events, [
      `created:${calls.branchedFrom[0]!.copyId}`,
      `committed:${calls.branchedFrom[0]!.copyId}`,
      `beforeSend:${calls.branchedFrom[0]!.copyId}`,
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
      `created:${(result as { forkId: string }).forkId}`,
      'pin-started',
      `committed:${(result as { forkId: string }).forkId}`,
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

  it('retries a lost companion Branch with its original target and settled boundary', async () => {
    const control: FakeControl = {
      turns: [turn('quote-boundary-1', 'completed')],
      loseFirstBranchResponse: true,
      afterSetMode: 'explore',
    };
    const { api, calls } = makeApi(control);
    const input = {
      ...base,
      sourceSession: summary('quote-retry-source', 'execute'),
    };

    assert.deepEqual(
      await performCompanionTurn({ api, isDisposed: () => false, ...input, ...recorder() }),
      { status: 'error', code: 'fork_setup_failed' },
    );
    control.turns = [turn('quote-boundary-1', 'completed'), turn('quote-boundary-2', 'completed')];
    const retried = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...input,
      ...recorder(),
    });

    assert.equal(retried.status, 'sent');
    assert.equal(calls.branchedFrom.length, 2);
    assert.deepEqual(calls.branchedFrom[1], calls.branchedFrom[0]);
    assert.equal(calls.branchedFrom[1]?.sourceTurnId, 'quote-boundary-1');
  });

  it('durably abandons an unresolved companion target before a new action', async () => {
    const control: FakeControl = {
      turns: [turn('quote-abandon-boundary', 'completed')],
      loseFirstBranchResponse: true,
      afterSetMode: 'explore',
    };
    const { api, calls } = makeApi(control);
    const sourceSession = summary('quote-abandon-source', 'execute');
    const input = { ...base, sourceSession };

    await performCompanionTurn({ api, isDisposed: () => false, ...input, ...recorder() });
    const abandonedCopyId = calls.branchedFrom[0]!.copyId;
    assert.equal(await abandonPendingCompanionCopy(api, sourceSession.id), true);
    assert.deepEqual(calls.abandoned, [abandonedCopyId]);

    const next = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...input,
      ...recorder(),
    });
    assert.equal(next.status, 'sent');
    assert.notEqual(calls.branchedFrom[1]?.copyId, abandonedCopyId);
  });

  it('never reuses a target after its cleanup acknowledgement becomes ambiguous', async () => {
    const control: FakeControl = {
      turns: [turn('quote-ambiguous-abandon-boundary', 'completed')],
      loseFirstBranchResponse: true,
      abandonThrows: true,
      afterSetMode: 'explore',
    };
    const { api, calls } = makeApi(control);
    const sourceSession = summary('quote-ambiguous-abandon-source', 'execute');
    const input = { ...base, sourceSession };

    await performCompanionTurn({ api, isDisposed: () => false, ...input, ...recorder() });
    const firstCopyId = calls.branchedFrom[0]?.copyId;
    assert.equal(await abandonPendingCompanionCopy(api, sourceSession.id), false);

    control.abandonThrows = false;
    const retried = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...input,
      ...recorder(),
    });
    assert.equal(retried.status, 'sent');
    assert.notEqual(calls.branchedFrom[1]?.copyId, firstCopyId);
    await cleanupCompanionCopy(api, sourceSession.id, calls.branchedFrom[1]!.copyId);
  });

  it('completes the copy lease by copy id when an embedded fork has another id', async () => {
    const control: FakeControl = {
      createdId: 'embedded-fork',
      afterSetMode: 'explore',
    };
    const { api, calls } = makeApi(control);
    const sourceSession = summary('embedded-source', 'execute');
    const input = { ...base, sourceSession };
    const sent = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...input,
      ...recorder(),
    });
    assert.equal(sent.status, 'sent');
    const firstCopyId = calls.branchedFrom[0]?.copyId;

    assert.equal(await cleanupCompanionCopy(api, sourceSession.id, 'embedded-fork'), true);
    assert.deepEqual(calls.removed, ['embedded-fork']);

    control.createdId = 'embedded-fork-2';
    await performCompanionTurn({ api, isDisposed: () => false, ...input, ...recorder() });
    assert.notEqual(calls.branchedFrom[1]?.copyId, firstCopyId);
    await cleanupCompanionCopy(api, sourceSession.id, 'embedded-fork-2');
  });

  it('does not create a companion before the source has a settled turn', async () => {
    const { api, calls } = makeApi({ turns: [] });
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
    assert.deepEqual(calls.removed, [calls.branchedFrom[0]!.copyId]);
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, [`created:${calls.branchedFrom[0]!.copyId}`]);
  });

  it('does not release a hidden fork when authoritative cleanup fails', async () => {
    const { api, calls } = makeApi({ setModeThrows: true, cleanupThrows: true });
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
    assert.deepEqual(events, [`created:${calls.branchedFrom[0]!.copyId}`]);
  });

  it('fail-closed: a fork not confirmed `explore` is removed and never sends', async () => {
    const { api, calls } = makeApi({ afterSetMode: 'execute' }); // stayed elevated
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'permission_pin_failed' });
    assert.deepEqual(calls.removed, [calls.branchedFrom[0]!.copyId]);
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
    assert.deepEqual(calls.removed, [calls.branchedFrom[0]!.copyId]);
    assert.deepEqual(calls.setMode, []); // bailed before pinning
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('send rejection (thrown) is retryable: arms but does NOT consume the staged quotes', async () => {
    const { api, calls } = makeApi({ afterSetMode: 'explore', sendThrows: true });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'send_failed' });
    assert.equal(rec.events.includes('consumed'), false);
    assert.deepEqual(rec.events, [
      `created:${calls.branchedFrom[0]!.copyId}`,
      `committed:${calls.branchedFrom[0]!.copyId}`,
      `beforeSend:${calls.branchedFrom[0]!.copyId}`,
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
