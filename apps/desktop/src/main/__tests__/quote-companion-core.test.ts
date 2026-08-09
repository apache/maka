/**
 * Focused unit tests for the quote companion's fork/guard/send orchestration and
 * event routing (extracted from `useQuoteCompanion` so the React hook stays a
 * thin shell — same pattern as `use-onboarding-snapshot.test.ts`). Covers the
 * review gaps: fork setup rejections are structured, the fork inherits the
 * parent's permission profile, an unmount mid-create must not leak a hidden
 * fork, a failed OR `{ ok: false }` send must be retryable (quotes kept), the
 * fork branches at the latest completed turn, and interaction routing must
 * resolve web/custom-tool approvals.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { SessionEvent, SessionSummary, TurnRecord, TurnStatus } from '@maka/core';
import {
  abandonPendingCompanionCopy,
  applyCompanionInteractionEvent,
  cleanupCompanionCopy,
  createCompanionDismissalGuard,
  dismissCompanionCopy,
  companionRunEventEffect,
  deriveCompanionComposerState,
  isCompanionTurnTerminal,
  latestSettledTurnId,
  performCompanionTurn,
  recoverOrphanedCompanionCopies,
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
  cleanupThrows?: boolean;
  abandonThrows?: boolean;
  sendThrows?: boolean;
  sendResult?: { ok: true } | { ok: false; reason?: string };
  /** Runs right after the fork is created (e.g. to flip `disposed`). */
  afterCreate?: () => void;
}

function makeApi(control: FakeControl = {}) {
  const calls = {
    lifecycle: [] as string[],
    removed: [] as string[],
    sent: [] as {
      id: string;
      cmd: {
        turnId: string;
        text: string;
        quotes?: unknown;
        attachmentItems?: unknown;
      };
    }[],
    branchedFrom: [] as Array<{
      sourceTurnId: string;
      name?: string;
      copyId: string;
      sideConversation?: boolean;
    }>,
    abandoned: [] as string[],
    created: 0,
  };
  const api: CompanionSessionApi = {
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
    cleanupSessionCopy: async (id) => {
      calls.lifecycle.push(`cleanup:${id}`);
      calls.removed.push(id);
      if (control.cleanupThrows) throw new Error('cleanup failed');
    },
    abandonSessionCopy: async (id) => {
      calls.abandoned.push(id);
      if (control.abandonThrows) throw new Error('abandon acknowledgement lost');
    },
    stop: async (id) => {
      calls.lifecycle.push(`stop:${id}`);
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
  panelId: 'panel-main',
  name: '追问：excerpt',
  turnId: 'T1',
  text: 'hello',
  quotes: [{ text: 'excerpt' }] as { text: string }[],
  existingForkId: null as string | null,
};

afterEach(async () => {
  const { api } = makeApi();
  for (const sourceSessionId of ['main', 'quote-retry-source', 'quote-abandon-source']) {
    await abandonPendingCompanionCopy(api, sourceSessionId, base.panelId);
  }
});

describe('latestSettledTurnId', () => {
  it('picks the latest completed turn and excludes failed or aborted parent work', () => {
    assert.equal(
      latestSettledTurnId([
        turn('a', 'completed'),
        turn('b', 'completed'),
        turn('c', 'failed'),
        turn('d', 'aborted'),
        turn('e', 'running'),
      ]),
      'b',
    );
    assert.equal(
      latestSettledTurnId([
        turn('a', 'failed'),
        turn('b', 'aborted'),
        turn('c', 'running'),
      ]),
      undefined,
    );
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

  it('stops a live companion before dismissing its durable copy', async () => {
    const { api, calls } = makeApi();

    assert.equal(
      await dismissCompanionCopy(api, 'source-session', 'panel-1', 'companion-session'),
      true,
    );
    assert.deepEqual(calls.lifecycle, [
      'stop:companion-session',
      'cleanup:companion-session',
    ]);
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
  it('abandons every panel-scoped copy orphaned by a renderer reload', async () => {
    const control: FakeControl = { loseFirstBranchResponse: true };
    const { api, calls } = makeApi(control);
    const sourceSession = summary('quote-reload-source', 'execute');
    const first = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...base,
      sourceSession,
      panelId: 'panel-before-reload',
      ...recorder(),
    });
    assert.equal(first.status, 'error');
    const orphanedCopyId = calls.branchedFrom[0]?.copyId;

    await recoverOrphanedCompanionCopies(api);

    assert.deepEqual(calls.abandoned, [orphanedCopyId]);
    const afterReload = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...base,
      sourceSession,
      panelId: 'panel-after-reload',
      ...recorder(),
    });
    assert.equal(afterReload.status, 'sent');
    assert.notEqual(calls.branchedFrom[1]?.copyId, orphanedCopyId);
    await cleanupCompanionCopy(
      api,
      sourceSession.id,
      'panel-after-reload',
      calls.branchedFrom[1]!.copyId,
    );
  });

  it('happy path: forks at the completed turn, preserves permission, sends, then commits + consumes', async () => {
    const { api, calls } = makeApi({
      turns: [turn('t-old', 'completed'), turn('t-settled', 'completed'), turn('t-running', 'running')],
    });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.equal(result.status, 'sent');
    assert.deepEqual(
      calls.branchedFrom.map(({ sourceTurnId, name, sideConversation }) => ({
        sourceTurnId,
        name,
        sideConversation,
      })),
      [{ sourceTurnId: 't-settled', name: base.name, sideConversation: true }],
    );
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

  it('reports and commits the created id before sending', async () => {
    const events: string[] = [];
    const { api } = makeApi();
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
      `committed:${(result as { forkId: string }).forkId}`,
      'send-started',
    ]);
  });

  it('forwards staged attachments through the same session send command', async () => {
    const { api, calls } = makeApi();
    const rec = recorder();
    const attachmentItems = [
      { approvalId: 'attachment-1', name: 'notes.txt', mimeType: 'text/plain' },
    ];
    const result = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...base,
      ...rec,
      attachmentItems,
    });
    assert.equal(result.status, 'sent');
    assert.deepEqual(calls.sent[0].cmd.attachmentItems, attachmentItems);
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

  it('structures branchFromTurn rejection and never sends', async () => {
    const { api, calls } = makeApi({ branchThrows: true });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'fork_setup_failed' });
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('retries a lost companion Branch with its original target and settled boundary', async () => {
    const control: FakeControl = {
      turns: [turn('quote-boundary-1', 'completed')],
      loseFirstBranchResponse: true,
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
    };
    const { api, calls } = makeApi(control);
    const sourceSession = summary('quote-abandon-source', 'execute');
    const input = { ...base, sourceSession };

    await performCompanionTurn({ api, isDisposed: () => false, ...input, ...recorder() });
    const abandonedCopyId = calls.branchedFrom[0]!.copyId;
    assert.equal(
      await abandonPendingCompanionCopy(api, sourceSession.id, base.panelId),
      true,
    );
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
    };
    const { api, calls } = makeApi(control);
    const sourceSession = summary('quote-ambiguous-abandon-source', 'execute');
    const input = { ...base, sourceSession };

    await performCompanionTurn({ api, isDisposed: () => false, ...input, ...recorder() });
    const firstCopyId = calls.branchedFrom[0]?.copyId;
    assert.equal(
      await abandonPendingCompanionCopy(api, sourceSession.id, base.panelId),
      false,
    );

    control.abandonThrows = false;
    const retried = await performCompanionTurn({
      api,
      isDisposed: () => false,
      ...input,
      ...recorder(),
    });
    assert.equal(retried.status, 'sent');
    assert.notEqual(calls.branchedFrom[1]?.copyId, firstCopyId);
    await cleanupCompanionCopy(
      api,
      sourceSession.id,
      base.panelId,
      calls.branchedFrom[1]!.copyId,
    );
  });

  it('completes the copy lease by copy id when an embedded fork has another id', async () => {
    const control: FakeControl = {
      createdId: 'embedded-fork',
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

    assert.equal(
      await cleanupCompanionCopy(
        api,
        sourceSession.id,
        base.panelId,
        'embedded-fork',
      ),
      true,
    );
    assert.deepEqual(calls.removed, ['embedded-fork']);

    control.createdId = 'embedded-fork-2';
    await performCompanionTurn({ api, isDisposed: () => false, ...input, ...recorder() });
    assert.notEqual(calls.branchedFrom[1]?.copyId, firstCopyId);
    await cleanupCompanionCopy(
      api,
      sourceSession.id,
      base.panelId,
      'embedded-fork-2',
    );
  });

  it('does not create or send before the source has a completed turn', async () => {
    const { api, calls } = makeApi({ turns: [] });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'fork_setup_failed' });
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('unmount during create: removes the just-created fork and aborts (no send)', async () => {
    let disposed = false;
    const { api, calls } = makeApi({ afterCreate: () => {
      disposed = true;
    } });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => disposed, ...base, ...rec });
    assert.equal(result.status, 'disposed');
    assert.deepEqual(calls.removed, [calls.branchedFrom[0]!.copyId]);
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(rec.events, []);
  });

  it('send rejection (thrown) is retryable: arms but does NOT consume the staged quotes', async () => {
    const { api, calls } = makeApi({ sendThrows: true });
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
    const { api, calls } = makeApi({ sendResult: { ok: false } });
    const rec = recorder();
    const result = await performCompanionTurn({ api, isDisposed: () => false, ...base, ...rec });
    assert.deepEqual(result, { status: 'error', code: 'send_rejected' });
    assert.equal(calls.sent.length, 1); // the send resolved, just not ok
    assert.equal(rec.events.includes('consumed'), false);
  });

  it('existing fork: skips creation and sends directly', async () => {
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

describe('companionRunEventEffect', () => {
  const errorEvent = (
    turnId: string,
    reason: string | undefined,
    message = 'Provider failed',
  ): SessionEvent =>
    ({
      type: 'error',
      id: `error-${turnId}`,
      turnId,
      ts: 1,
      recoverable: false,
      ...(reason ? { reason } : {}),
      message,
    }) as SessionEvent;

  it('uses the main-chat localized error classification for the active turn', () => {
    assert.deepEqual(
      companionRunEventEffect(errorEvent('active', 'network'), 'active', false, 'zh'),
      {
        kind: 'active',
        terminal: true,
        error: '网络错误',
      },
    );
    assert.deepEqual(
      companionRunEventEffect(errorEvent('active', 'auth'), 'active', false, 'en'),
      {
        kind: 'active',
        terminal: true,
        error: 'Authentication failed',
      },
    );
  });

  it('ignores a late error from an older turn', () => {
    assert.deepEqual(
      companionRunEventEffect(errorEvent('old-turn', 'network'), 'new-turn', false, 'zh'),
      { kind: 'ignore' },
    );
  });

  it('suppresses a late error after Stop while still settling the active turn', () => {
    assert.deepEqual(
      companionRunEventEffect(errorEvent('active', 'network'), 'active', true, 'zh'),
      {
        kind: 'active',
        terminal: true,
        error: null,
      },
    );
  });

  it('keeps unknown provider text behind the safe localized fallback', () => {
    const effect = companionRunEventEffect(
      errorEvent('active', 'future_provider_failure', 'token=provider-secret'),
      'active',
      false,
      'zh',
    );
    assert.deepEqual(effect, {
      kind: 'active',
      terminal: true,
      error: '对话运行失败，请稍后重试。',
    });
    assert.equal(JSON.stringify(effect).includes('provider-secret'), false);
  });

  it('clears an earlier error for user-stop terminal events', () => {
    assert.deepEqual(
      companionRunEventEffect(
        {
          type: 'complete',
          id: 'complete-stop',
          turnId: 'active',
          ts: 2,
          stopReason: 'user_stop',
        },
        'active',
        true,
        'zh',
      ),
      {
        kind: 'active',
        terminal: true,
        error: null,
      },
    );
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
