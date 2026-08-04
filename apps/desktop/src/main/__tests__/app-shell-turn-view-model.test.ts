import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS } from '@maka/core';
import type { StoredMessage, UiLocale } from '@maka/core';
import { createTranscriptProjection, type TurnViewModel } from '@maka/ui';
import {
  createAppShellTurnPresentationDerivation,
  deriveAppShellTurnPresentation,
  type AppShellTurnPresentationContext,
} from '../../renderer/app-shell-turn-view-model.js';
import { latestInterruptedResumeTurnId } from '../../renderer/interrupted-resume.js';

const SESSION = 'session-1';
// The shell's pending-action set keeps its identity until an action actually
// goes pending, so the fixture holds one too.
const NO_PENDING_ACTIONS: ReadonlySet<string> = new Set<string>();

function context(overrides: Partial<AppShellTurnPresentationContext> = {}): AppShellTurnPresentationContext {
  return {
    activeId: SESSION,
    pendingTurnActions: NO_PENDING_ACTIONS,
    uiLocale: 'zh' as UiLocale,
    pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
    ...overrides,
  };
}

/**
 * The production wiring: ChatView projects the transcript and hands the turns
 * to the derivation. Driving both together is the point — the derivation's
 * cache keys on the turn objects the projection produced, so testing it
 * against hand-built turns would test a different mechanism than ships.
 */
function projector(): (messages: StoredMessage[]) => readonly TurnViewModel[] {
  const projection = createTranscriptProjection();
  return (messages) => projection.project({ sessionId: SESSION, messages });
}

function derive(messages: StoredMessage[]) {
  return deriveAppShellTurnPresentation(projector()(messages), context());
}

function failedToolMessages(input: {
  sandboxDenied: boolean;
  includeOrdinaryFailure?: boolean;
  errorClass?: string;
}): StoredMessage[] {
  const turnId = 'turn-1';
  const messages: StoredMessage[] = [
    { type: 'user', id: 'user-1', turnId, ts: 1, text: 'run it' },
    { type: 'tool_call', id: 'tool-1', turnId, ts: 2, toolName: 'Grep', args: {} },
    {
      type: 'tool_result',
      id: 'result-1',
      turnId,
      ts: 3,
      toolUseId: 'tool-1',
      isError: true,
      content: {
        kind: 'text',
        text: 'Operation not permitted',
        ...(input.sandboxDenied
          ? { sandboxDenial: { likely: true as const, backend: 'macos-seatbelt' as const } }
          : {}),
      },
    },
  ];
  if (input.includeOrdinaryFailure) {
    messages.push(
      { type: 'tool_call', id: 'tool-2', turnId, ts: 4, toolName: 'Read', args: {} },
      {
        type: 'tool_result',
        id: 'result-2',
        turnId,
        ts: 5,
        toolUseId: 'tool-2',
        isError: true,
        content: { kind: 'text', text: 'File not found' },
      },
    );
  }
  messages.push({
    type: 'turn_state',
    id: 'state-1',
    turnId,
    ts: 6,
    status: 'failed',
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    partialOutputRetained: true,
  });
  return messages;
}

describe('AppShell turn presentation interrupted recovery', () => {
  it('offers safe resume only for the latest app-restarted failed turn', () => {
    const turnId = latestInterruptedResumeTurnId([
      { turnId: 'turn-1', status: 'failed', errorClass: 'app_restarted' },
    ]);

    assert.equal(turnId, 'turn-1');
  });

  it('removes the action after a later turn completes', () => {
    const turnId = latestInterruptedResumeTurnId([
      { turnId: 'turn-1', status: 'failed', errorClass: 'app_restarted' },
      { turnId: 'turn-2', status: 'completed' },
    ]);

    assert.equal(turnId, undefined);
  });

  it('explains a turn whose sandbox boundary request the restart closed (#1612)', () => {
    const presentation = derive([
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'build it' },
      {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: 2,
        status: 'failed',
        errorClass: SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS,
        partialOutputRetained: false,
      },
    ]);

    assert.match(presentation.failedReasonLabels['turn-1'] ?? '', /「允许访问工作区以外的内容」请求已按拒绝关闭/);
    assert.match(presentation.failedRecoveryLabels['turn-1'] ?? '', /重试本轮/);
    // Answering is impossible after the restart, so this turn must not be
    // offered as a safe-resume candidate the way a plain restart is.
    assert.equal(presentation.resumeCandidateTurnId, undefined);
  });

  it('names the resume candidate so ChatView can pair it with the shell action', () => {
    const presentation = derive([
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'build it' },
      {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: 2,
        status: 'failed',
        errorClass: 'app_restarted',
        partialOutputRetained: false,
      },
    ]);

    assert.equal(presentation.resumeCandidateTurnId, 'turn-1');
  });
});

describe('AppShell turn presentation sandbox denial', () => {
  it('omits the duplicate failed-turn banner for a sandbox-only tool failure', () => {
    const presentation = derive(failedToolMessages({ sandboxDenied: true }));

    assert.equal(presentation.failedReasonLabels['turn-1'], undefined);
    assert.equal(presentation.failedRecoveryLabels['turn-1'], undefined);
  });

  it('keeps the failed-turn banner for an ordinary tool failure', () => {
    const presentation = derive(failedToolMessages({
      sandboxDenied: false,
      errorClass: 'tool_failed',
    }));

    assert.equal(typeof presentation.failedReasonLabels['turn-1'], 'string');
    assert.equal(typeof presentation.failedRecoveryLabels['turn-1'], 'string');
  });

  it('keeps the failed-turn banner when a sandbox denial and ordinary failure coexist', () => {
    const presentation = derive(failedToolMessages({
      sandboxDenied: true,
      includeOrdinaryFailure: true,
      errorClass: 'tool_failed',
    }));

    assert.equal(typeof presentation.failedReasonLabels['turn-1'], 'string');
    assert.equal(typeof presentation.failedRecoveryLabels['turn-1'], 'string');
  });

  it('keeps the failed-turn banner for a separate turn-level failure', () => {
    const presentation = derive(failedToolMessages({
      sandboxDenied: true,
      errorClass: 'network',
    }));

    assert.equal(typeof presentation.failedReasonLabels['turn-1'], 'string');
    assert.equal(typeof presentation.failedRecoveryLabels['turn-1'], 'string');
  });
});

/**
 * A memoized `TurnView` compares every prop, not just `turn`. These props are
 * derived from the turns the transcript projection produced, so a turn the
 * projection kept must cost nothing here and hand the SAME objects back — that
 * is the whole reason the derivation moved off the raw message log (#2030).
 * `refreshMessages` fires at every step and tool boundary, so this is the path
 * a streaming answer actually takes.
 */
describe('AppShell turn presentation prop identity', () => {
  const transcript: StoredMessage[] = [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'first' },
    { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'first answer', modelId: 'model-1' },
    { type: 'turn_state', id: 'state-1', turnId: 'turn-1', ts: 3, status: 'completed', partialOutputRetained: false },
    { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 4, text: 'second' },
    { type: 'assistant', id: 'assistant-2', turnId: 'turn-2', ts: 5, text: 'second answer', modelId: 'model-1' },
    { type: 'turn_state', id: 'state-2', turnId: 'turn-2', ts: 6, status: 'completed', partialOutputRetained: false },
  ];

  /** turn-3 was regenerated from turn-1, so both ends carry a lineage badge. */
  const regenerated: StoredMessage[] = [
    ...transcript,
    {
      type: 'turn_state',
      id: 'state-3',
      turnId: 'turn-3',
      ts: 7,
      status: 'completed',
      regeneratedFromTurnId: 'turn-1',
      partialOutputRetained: false,
    },
    { type: 'user', id: 'user-3', turnId: 'turn-3', ts: 7, text: 'first, again' },
    { type: 'assistant', id: 'assistant-3', turnId: 'turn-3', ts: 8, text: 'another answer', modelId: 'model-1' },
  ];

  function driver() {
    const project = projector();
    const derivation = createAppShellTurnPresentationDerivation();
    return (messages: StoredMessage[], overrides?: Partial<AppShellTurnPresentationContext>) =>
      derivation.derive(project(messages), context(overrides));
  }

  it('keeps every per-turn prop identical across a refresh that changed nothing', () => {
    const drive = driver();
    const before = drive(regenerated);
    // A refresh re-reads the ledger over IPC: same values, all-new objects.
    const after = drive(structuredClone(regenerated));

    assert.equal(after, before, 'a refresh that changed nothing must not move the presentation at all');
    for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
      assert.equal(
        after.footerActionsByTurn[turnId],
        before.footerActionsByTurn[turnId],
        `${turnId} footer actions must keep identity`,
      );
    }
    for (const turnId of ['turn-1', 'turn-3']) {
      assert.ok(before.lineageBadgesByTurn[turnId], `${turnId} must have a lineage badge to pin`);
      assert.equal(
        after.lineageBadgesByTurn[turnId],
        before.lineageBadgesByTurn[turnId],
        `${turnId} lineage badges must keep identity`,
      );
    }
  });

  it('keeps an untouched turn\'s lineage badges when the transcript grows', () => {
    // A new turn forces a fresh presentation, so this is the path where the
    // per-turn cache actually has to answer — the whole-result short circuit
    // above cannot cover it.
    const drive = driver();
    const before = drive(regenerated);
    const after = drive([
      ...structuredClone(regenerated),
      { type: 'user', id: 'user-4', turnId: 'turn-4', ts: 9, text: 'fourth' },
    ]);

    assert.notEqual(after, before);
    for (const turnId of ['turn-1', 'turn-3']) {
      assert.ok(before.lineageBadgesByTurn[turnId]);
      assert.equal(
        after.lineageBadgesByTurn[turnId],
        before.lineageBadgesByTurn[turnId],
        `${turnId} lineage badges must keep identity`,
      );
      assert.equal(after.footerActionsByTurn[turnId], before.footerActionsByTurn[turnId]);
    }
  });

  it('moves only the turn whose derived props actually changed', () => {
    const drive = driver();
    const before = drive(transcript);
    const after = drive([
      ...structuredClone(transcript),
      { type: 'user', id: 'user-3', turnId: 'turn-3', ts: 7, text: 'third' },
    ]);

    assert.notEqual(after, before);
    assert.equal(after.footerActionsByTurn['turn-1'], before.footerActionsByTurn['turn-1']);
    assert.equal(after.footerActionsByTurn['turn-2'], before.footerActionsByTurn['turn-2']);
    assert.ok(after.footerActionsByTurn['turn-3'], 'the new turn gets its own footer actions');
  });

  it('moves a turn whose footer actions genuinely changed', () => {
    const drive = driver();
    const before = drive(transcript);
    // An answer that lost its text disables `copy` — a real footer change.
    const emptied = structuredClone(transcript);
    emptied[4] = { type: 'assistant', id: 'assistant-2', turnId: 'turn-2', ts: 5, text: '', modelId: 'model-1' };
    const after = drive(emptied);

    assert.equal(after.footerActionsByTurn['turn-1'], before.footerActionsByTurn['turn-1']);
    assert.notEqual(after.footerActionsByTurn['turn-2'], before.footerActionsByTurn['turn-2']);
  });

  it('moves a turn whose lineage changed even though the turn itself did not', () => {
    // The turn object is the cache key, but a later regeneration adds a reverse
    // badge and an `alreadyRegenerated` tooltip to a turn whose own messages
    // never moved. Keying on the turn alone would freeze both.
    const drive = driver();
    const before = drive(transcript);
    assert.equal(before.lineageBadgesByTurn['turn-1'], undefined);

    const after = drive(regenerated);
    assert.ok(after.lineageBadgesByTurn['turn-1'], 'the regenerated-from turn gains a reverse badge');
    assert.notEqual(
      after.footerActionsByTurn['turn-1'],
      before.footerActionsByTurn['turn-1'],
      'its footer now says the answer was already regenerated',
    );
    assert.equal(after.footerActionsByTurn['turn-2'], before.footerActionsByTurn['turn-2']);
  });

  it('drops a forward badge when its target turn leaves the transcript', () => {
    // turn-3's own messages are unchanged; only whether its origin still exists
    // moved. A badge pointing at a turn that is gone is unclickable.
    const drive = driver();
    const before = drive(regenerated);
    assert.ok(before.lineageBadgesByTurn['turn-3']?.some((badge) => badge.direction === 'forward'));

    const after = drive(regenerated.filter((message) => message.turnId !== 'turn-1'));
    assert.equal(
      after.lineageBadgesByTurn['turn-3']?.some((badge) => badge.direction === 'forward') ?? false,
      false,
      'the forward badge must go with its target',
    );
  });

  it('moves only the turn whose action went pending', () => {
    const drive = driver();
    const before = drive(transcript);
    const after = drive(transcript, {
      pendingTurnActions: new Set([`${SESSION}:turn-2:regenerate`]),
    });

    assert.equal(after.footerActionsByTurn['turn-1'], before.footerActionsByTurn['turn-1']);
    assert.notEqual(after.footerActionsByTurn['turn-2'], before.footerActionsByTurn['turn-2']);
  });

  it('relabels everything when the locale changes', () => {
    const drive = driver();
    const before = drive(transcript);
    const after = drive(transcript, { uiLocale: 'en' as UiLocale });

    assert.notEqual(after.footerActionsByTurn['turn-1'], before.footerActionsByTurn['turn-1']);
    assert.notDeepEqual(
      after.footerActionsByTurn['turn-1']?.map((action) => action.label),
      before.footerActionsByTurn['turn-1']?.map((action) => action.label),
    );
  });
});
