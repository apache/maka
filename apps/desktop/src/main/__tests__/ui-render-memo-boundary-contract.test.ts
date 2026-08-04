import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import type { SessionEvent, SessionSummary, StoredMessage } from '@maka/core';
import type { LiveTurnProjection, TurnPresentation, TurnViewModel } from '@maka/ui';
import { applyLiveTurnEvent, armLiveTurn, createTranscriptProjection } from '@maka/ui';
import { build } from 'esbuild';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createAppShellSessionUiStateController,
  type AppShellSessionUiState,
} from '../../renderer/app-shell-session-ui-state.js';
import { deriveLiveTurnSnapshot } from '../../renderer/live-turn-snapshot.js';
import { useAppShellSessionUiReads } from '../../renderer/use-app-shell-session-ui-reads.js';
import { useAppShellSessionUiSelector } from '../../renderer/use-app-shell-session-ui-selector.js';
import { useShellLiveTurn } from '../../renderer/use-shell-live-turn.js';
import { deriveAppShellTurnPresentation, useAppShellTurnPresentation } from '../../renderer/app-shell-turn-view-model.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const LUCIDE_REACT_PACKAGE = ['lucide', 'react'].join('-');

type UiRenderModule = {
  LocaleProvider(props: { locale: 'zh'; children: ReactElement }): ReactElement;
  SessionHistoryList(props: {
    sessions: SessionSummary[];
    activeId?: string;
    groups?: ReadonlyArray<{ id: string; label: string; sessions: SessionSummary[] }>;
    streamingSessionIds?: Set<string>;
    staleSessionIds?: Set<string>;
    onSelectSession(sessionId: string): void;
    rowActions?: {
      onToggleFlag(sessionId: string, next: boolean): void | Promise<void>;
      onArchive(sessionId: string): void | Promise<void>;
      onUnarchive(sessionId: string): void | Promise<void>;
      onRename(sessionId: string, name: string): void | Promise<void>;
      onDelete(sessionId: string): void | Promise<void>;
    };
  }): ReactElement | null;
  TurnView(props: {
    turn: TurnViewModel;
    liveStreaming?: {
      onStreamingSettled?(messageId?: string): void;
    };
  }): ReactElement;
  ChatSurfaceLayout(props: { children: ReactElement }): ReactElement;
  ChatView(props: Record<string, unknown>): ReactElement;
};
type RendererWindow = Window & typeof globalThis;
type MemoTestGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
type CountedTimestamp = number & { readCount(): number };

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  while (cleanupTasks.length > 0) cleanupTasks.pop()?.();
});

describe('UI render memo boundary contract', () => {
  it('memoized session metadata ignores parent updates and follows only the target streaming flag', async () => {
    const { LocaleProvider, SessionHistoryList } = await importUiRenderModule();
    const { root } = installReactRenderer();
    const sessions = [
      createSession('session-a', 'Alpha'),
      createSession('session-b', 'Beta'),
    ];
    const groups = [{ id: 'all', label: '', sessions }];
    // Omit rowActions: permanent MoreMenu mounts Astryx DropdownMenu, which
    // needs a full focusable DOM (hasAttribute). This contract only measures
    // SessionNavRow identity for formatSessionMeta under stable props.
    const stableProps = {
      SessionHistoryList,
      LocaleProvider,
      activeId: 'session-a',
      groups,
      onSelectSession: () => {},
      sessions,
      staleSessionIds: new Set<string>(),
    };

    await render(root, createElement(RenderHost, {
      ...stableProps,
      label: 'first parent render',
      streamingSessionIds: new Set<string>(),
    }));
    const initialReads = timestampReads(sessions);
    assert.ok(initialReads.every((count) => count > 0));

    const stableStreamingIds = new Set<string>();
    await render(root, createElement(RenderHost, {
      ...stableProps,
      label: 'stable parent render',
      streamingSessionIds: stableStreamingIds,
    }));
    const stableBaseline = timestampReads(sessions);

    await render(root, createElement(RenderHost, {
      ...stableProps,
      label: 'unrelated parent render',
      streamingSessionIds: stableStreamingIds,
    }));
    assert.deepEqual(timestampReads(sessions), stableBaseline);

    await render(root, createElement(RenderHost, {
      ...stableProps,
      label: 'streaming session update',
      streamingSessionIds: new Set<string>(['session-a']),
    }));
    const streamingReads = timestampReads(sessions);
    assert.ok(streamingReads[0] > stableBaseline[0]);
    assert.equal(streamingReads[1], stableBaseline[1]);
  });

  it('commits the complete streamed answer before signaling handoff once', async () => {
    const { LocaleProvider, TurnView } = await importUiRenderModule();
    const { root, container } = installReactRenderer();
    const settled: Array<{ messageId?: string; text: string }> = [];
    const finalText = 'final answer including the last tail';
    const renderTurn = (text: string, complete: boolean) => createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, {
        turn: streamingTurn(text, complete),
        liveStreaming: {
          onStreamingSettled(messageId?: string) {
            settled.push({ messageId, text: container.textContent });
          },
        },
      }),
    });

    await render(root, renderTurn('partial answer', false));
    assert.doesNotMatch(container.textContent, new RegExp(finalText));

    await render(root, renderTurn(finalText, true));
    assert.equal(container.textContent.split(finalText).length - 1, 1);
    assert.deepEqual(settled, [{
      messageId: 'stream-answer-1',
      text: container.textContent,
    }]);

    await render(root, renderTurn(finalText, true));
    assert.equal(settled.length, 1);
  });
});

// #1985: the shell subscribes to session UI state at one granularity, so a
// per-token write to `liveTurnBySession` re-rendered every subtree. The chat
// transcript is the only surface that needs the full projection; everything
// else reads low-entropy values that a text delta cannot change. This pins that
// split at the subscription, which is what keeps the sidebar and composer still
// while an answer streams.
describe('AppShell session UI subscription boundary', () => {
  // Drives `useAppShellSessionUiReads` — the shell's real read of the store,
  // not a copy of its selector list — against a projection subscriber standing
  // in for the chat surface. Both directions are pinned here: the shell must
  // still follow the two changes that mean something, and must not follow the
  // deltas that do not. Adding a token-rate selection to that hook fails this.
  it('re-renders the shell for the arm and the first token, then for no delta after', async () => {
    const controller = createAppShellSessionUiStateController();
    const { root } = installReactRenderer();
    let shellRenders = 0;
    let projectionRenders = 0;

    function ShellReader(): null {
      useAppShellSessionUiReads(controller, LIVE_SESSION_ID);
      shellRenders += 1;
      return null;
    }

    function ProjectionConsumer(): null {
      useAppShellSessionUiSelector(controller, selectTestProjection, LIVE_SESSION_ID);
      projectionRenders += 1;
      return null;
    }

    await render(
      root,
      createElement('div', null, createElement(ShellReader), createElement(ProjectionConsumer)),
    );
    const shellBaseline = shellRenders;
    const projectionBaseline = projectionRenders;

    // Arming a turn is a semantic change: no turn in flight → waiting.
    await act(async () => {
      controller.setLiveTurnBySession((current) => ({ ...current, [LIVE_SESSION_ID]: armLiveTurn('turn-1') }));
    });
    assert.equal(shellRenders, shellBaseline + 1, 'the shell must follow the arm');

    // The first delta is also semantic: waiting → streamed, and text appears.
    await act(async () => {
      streamLiveText(controller, 'Hel', 2);
    });
    assert.equal(shellRenders, shellBaseline + 2, 'the shell must follow the first token');

    // Every further delta only grows text the chat surface owns.
    const chunks = ['lo', ' there', ', here is', ' the answer'];
    for (const [index, chunk] of chunks.entries()) {
      await act(async () => {
        streamLiveText(controller, chunk, 3 + index);
      });
    }

    assert.equal(
      projectionRenders,
      projectionBaseline + 2 + chunks.length,
      'the chat surface must follow every delta',
    );
    assert.equal(
      shellRenders,
      shellBaseline + 2,
      'no delta after the first may re-render the shell',
    );
  });

  // `useSyncExternalStore` calls `getSnapshot` several times for ONE store
  // state — in the subscription callback, during render, and again in a passive
  // effect. A selector that derives a fresh value therefore has to be memoized
  // per store state, or every call hands React a new identity and it re-renders
  // forever. That idempotence belongs to this hook; a caller-supplied `isEqual`
  // is an optimization, not the thing standing between the app and a freeze.
  it('holds a comparator-less derived selector to one render per store change', async () => {
    const controller = createAppShellSessionUiStateController();
    const { root } = installReactRenderer();
    let renders = 0;

    function Reader(): null {
      useAppShellSessionUiSelector(controller, selectTestStopPendingIds);
      renders += 1;
      return null;
    }

    await render(root, createElement(Reader));
    const baseline = renders;

    await act(async () => {
      controller.setStopPendingBySession((current) => ({ ...current, [LIVE_SESSION_ID]: true }));
    });

    assert.equal(renders, baseline + 1, 'one store change must cost exactly one render');
  });

  // The one branch where the snapshot cache must yield without the store moving.
  it('follows the newly selected session when activeId changes under a still store', async () => {
    const controller = createAppShellSessionUiStateController();
    const { root } = installReactRenderer();
    controller.setLiveTurnBySession(() => ({
      [LIVE_SESSION_ID]: armLiveTurn('turn-a'),
      other: { ...armLiveTurn('turn-b'), phase: 'streamed' as const },
    }));
    const seen: Array<string | undefined> = [];

    function Reader(props: { activeId: string }): null {
      seen.push(useAppShellSessionUiReads(controller, props.activeId).activeLiveTurnSnapshot.turnId);
      return null;
    }

    await render(root, createElement(Reader, { activeId: LIVE_SESSION_ID }));
    assert.equal(seen.at(-1), 'turn-a');

    await render(root, createElement(Reader, { activeId: 'other' }));
    assert.equal(seen.at(-1), 'turn-b', 'the first render after a switch must read the new session');
  });
});

// The snapshot is where the shell's turn state is decided, and `useShellLiveTurn`
// is the only place its two Stop witnesses meet (#1987): the local arm and the
// runtime's `runningTurnIds`. Drive both through the real adapter, from a
// projection the reducer can actually produce.
describe('live-turn snapshot', () => {
  function renderTurnActive(
    projection: LiveTurnProjection | undefined,
    runningTurnIds: readonly string[] | undefined,
  ): Promise<boolean> {
    const { root } = installReactRenderer();
    let turnActive = false;

    function Reader(): null {
      turnActive = useShellLiveTurn({
        liveTurn: deriveLiveTurnSnapshot(projection),
        activeSession: { id: LIVE_SESSION_ID, runningTurnIds } as SessionSummary,
      }).turnActive;
      return null;
    }

    return render(root, createElement(Reader)).then(() => turnActive);
  }

  /** What a finished turn actually leaves behind: a `complete` over real steps. */
  function settledTurn(): LiveTurnProjection {
    const streamed = applyLiveTurnEvent(armLiveTurn('turn-1'), {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: 'answer',
    });
    return applyLiveTurnEvent(streamed, {
      type: 'complete',
      id: 'event-2',
      turnId: 'turn-1',
      ts: 2,
    } as SessionEvent) as LiveTurnProjection;
  }

  it('releases the turn once its own turn ends, even while the runtime still lists it', async () => {
    // The projection sees the terminal event first, so a session summary
    // fetched before that write must not light Stop back up.
    assert.equal(await renderTurnActive(settledTurn(), ['turn-1']), false);
  });

  it('holds the turn while a sibling turn is still running', async () => {
    // Dropping `turnId` from the snapshot would let the arm's own id mask this.
    assert.equal(await renderTurnActive(settledTurn(), ['turn-1', 'turn-2']), true);
  });

  it('holds the turn from the local arm alone, before the runtime knows of it', async () => {
    assert.equal(await renderTurnActive(armLiveTurn('turn-1'), []), true);
  });

  it('withholds the handoff message id until the text step closes', () => {
    const streaming = applyLiveTurnEvent(armLiveTurn('turn-1'), {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: 'partial',
    });

    const midStream = deriveLiveTurnSnapshot(streaming);
    assert.equal(midStream.hasStreamingText, true);
    assert.equal(midStream.streamingMessageId, undefined, 'an open text step has nothing to hand off');

    const closed = applyLiveTurnEvent(streaming, {
      type: 'text_complete',
      id: 'event-2',
      turnId: 'turn-1',
      ts: 2,
      messageId: 'message-1',
      text: 'partial answer',
    });

    assert.equal(deriveLiveTurnSnapshot(closed).streamingMessageId, 'message-1');
  });
});

/**
 * #2030: the transcript projection keeps a settled turn's object identity
 * across deltas and refreshes, but that only reaches the DOM if the per-turn
 * props are derived FROM those turns and stay stable too. Testing the
 * projection alone leaves the wiring between it and the renderer untested — a
 * pass added downstream of the projection (a `.map(turn => ({ ...turn }))`)
 * restores the original defect while every projection test stays green. This
 * measures the real ChatView.
 */
describe('ChatView transcript render boundary', () => {
  const SESSION_ID = 'session-chat';

  it('re-renders only the tail turn while an answer streams', async () => {
    const { LocaleProvider, ChatSurfaceLayout, ChatView } = await importUiRenderModule();
    const { root, container } = installReactRenderer();
    const messages = transcriptMessages();
    const presentation = countingPresentation();

    const renderAt = (text: string) => render(root, createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ChatSurfaceLayout, {
        children: createElement(ChatView, {
          messages,
          activeSession: chatSession(SESSION_ID),
          liveTurn: streamingLiveTurn(text),
          shellRunUpdates: SHELL_RUN_UPDATES,
          deriveTurnPresentation: presentation.derive,
          onNew: () => {},
        }),
      }),
    }));

    await renderAt('he');
    const baseline = presentation.footerReads();
    assert.ok(baseline['turn-1']! > 0, 'a settled turn must render its footer at least once');
    const observerBaseline = observerCounts();
    // Exact, not `> 0`: the rail's observer becomes unreachable if the selector
    // format or `CSS.escape` shifts, or if the rail stops rendering, and a
    // loose guard would then assert nothing while still passing.
    assert.deepEqual(
      observerBaseline,
      { construct: 1, observe: 3, disconnect: 0 },
      'the prompt rail must build one observer over all three turns',
    );

    // Only the live text moves. `messages` and `shellRunUpdates` keep identity,
    // exactly as they do between two deltas in the app.
    for (const text of ['hel', 'hell', 'hello']) await renderAt(text);

    const after = presentation.footerReads();
    assert.equal(after['turn-1'], baseline['turn-1'], 'turn-1 owns the background Bash and must not re-render');
    assert.equal(after['turn-2'], baseline['turn-2'], 'an unrelated settled turn must not re-render');
    // Positively: the tail turn DID advance and the text reached the DOM, so
    // "nothing rendered at all" cannot pass this test.
    assert.ok(after['turn-3']! > baseline['turn-3']!, 'the tail turn must re-render for its own delta');
    assert.match(container.textContent, /hello/);
    // A settled turn's presentation is derived once and answered from the turn
    // identity after that.
    assert.equal(presentation.derivations()['turn-1'], 1, 'a settled turn is derived once, not once per token');
    assert.equal(presentation.derivations()['turn-2'], 1);
    // The prompt rail's transcript-wide IntersectionObserver must not be torn
    // down and rebuilt per token: which turns exist did not change.
    assert.deepEqual(observerCounts(), observerBaseline, 'a delta must not rebuild the prompt rail observer');
  });

  it('re-renders nothing when a refresh republishes the same transcript', async () => {
    // The other half of #2030, and the one the delta case cannot see:
    // `refreshMessages` fires at every step and tool boundary and hands down a
    // freshly deserialized array, so every message object is new and only the
    // value comparison can recover identity.
    const { LocaleProvider, ChatSurfaceLayout, ChatView } = await importUiRenderModule();
    const { root } = installReactRenderer();
    const presentation = countingPresentation();

    const renderRefresh = () => render(root, createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ChatSurfaceLayout, {
        children: createElement(ChatView, {
          messages: structuredClone(transcriptMessages()),
          activeSession: chatSession(SESSION_ID),
          shellRunUpdates: SHELL_RUN_UPDATES,
          deriveTurnPresentation: presentation.derive,
          onNew: () => {},
        }),
      }),
    }));

    await renderRefresh();
    const baseline = presentation.footerReads();
    assert.ok(baseline['turn-1']! > 0);

    for (let index = 0; index < 3; index += 1) await renderRefresh();

    const after = presentation.footerReads();
    assert.deepEqual(after, baseline, 'a refresh that changed nothing must not re-render a single turn');
    assert.deepEqual(
      presentation.derivations(),
      { 'turn-1': 1, 'turn-2': 1, 'turn-3': 1 },
      'a refresh that changed nothing must not re-derive a single turn',
    );
  });

  // The shell's half of the same seam: ChatView calls this back during render,
  // so the cache it keys on the projected turns has to outlive the render that
  // built it. A derivation rebuilt per render would answer every call from an
  // empty cache and quietly restore the defect.
  it('keeps one turn-presentation derivation across renders', async () => {
    const { root } = installReactRenderer();
    const turns = createTranscriptProjection().project({
      sessionId: SESSION_ID,
      messages: transcriptMessages(),
    });
    const seen: TurnPresentation[] = [];

    function Reader(): null {
      const derive = useAppShellTurnPresentation({
        activeId: SESSION_ID,
        pendingTurnActions: NO_PENDING_TURN_ACTIONS,
        uiLocale: 'zh',
        pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
      });
      seen.push(derive(turns));
      return null;
    }

    await render(root, createElement(Reader));
    await render(root, createElement(Reader));

    assert.ok(seen.length >= 2, 'the hook must have run on both renders');
    assert.equal(seen.at(-1), seen[0], 'the second render must reuse the first derivation');
    assert.ok(seen[0]!.footerActionsByTurn['turn-1'], 'the derivation must produce real footer actions');
  });

  it('renders every per-turn field the real derivation produces', async () => {
    // The render-boundary tests above drive ChatView through a stand-in whose
    // maps are empty apart from the footer actions, so the derivation and the
    // rendering are only ever exercised in separate frames. Everything the
    // presentation carries — failure copy, lineage badges, and which turn may
    // offer the resume — reaches the DOM through wires nothing else walks.
    const { LocaleProvider, ChatSurfaceLayout, ChatView } = await importUiRenderModule();
    const { root, container } = installReactRenderer();
    const messages = restartedLineageMessages();
    const turns = createTranscriptProjection().project({ sessionId: SESSION_ID, messages });
    const presentation = deriveAppShellTurnPresentation(turns, {
      activeId: SESSION_ID,
      pendingTurnActions: NO_PENDING_TURN_ACTIONS,
      uiLocale: 'zh',
      pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
    });

    const reason = presentation.failedReasonLabels['turn-2'];
    const recovery = presentation.failedRecoveryLabels['turn-2'];
    const badge = presentation.lineageBadgesByTurn['turn-1']?.[0]?.label;
    assert.ok(reason && recovery && badge, 'the fixture must exercise all three label maps');
    assert.equal(presentation.resumeCandidateTurnId, 'turn-2');

    const renderChat = (safeResumeAction?: { pending: boolean; detail?: string; onResume: () => void }) =>
      render(root, createElement(LocaleProvider, {
        locale: 'zh',
        children: createElement(ChatSurfaceLayout, {
          children: createElement(ChatView, {
            messages,
            activeSession: chatSession(SESSION_ID),
            deriveTurnPresentation: () => presentation,
            ...(safeResumeAction ? { safeResumeAction } : {}),
            onNew: () => {},
          }),
        }),
      }));

    await renderChat({ pending: false, detail: 'RESUME-DETAIL', onResume: () => {} });
    assert.ok(container.textContent.includes(reason), 'the failed reason must reach the DOM');
    assert.ok(container.textContent.includes(badge), 'the lineage badge must reach the DOM');
    // The shell hands one resume action to ChatView unconditionally; only the
    // turn the derivation named may offer it.
    assert.equal(container.textContent.split('RESUME-DETAIL').length - 1, 1);

    // With no resume action the recovery hint takes that slot instead.
    await renderChat();
    assert.ok(container.textContent.includes(recovery), 'the recovery hint must reach the DOM');
    assert.doesNotMatch(container.textContent, /RESUME-DETAIL/);
  });

  it('shows the newly selected session on the first render after a switch', async () => {
    const { LocaleProvider, ChatSurfaceLayout, ChatView } = await importUiRenderModule();
    const { root, container } = installReactRenderer();

    const renderSession = (sessionId: string, answer: string) => render(root, createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ChatSurfaceLayout, {
        children: createElement(ChatView, {
          // Same turn and message ids, different content — what a revision
          // lineage actually produces.
          messages: transcriptMessages(answer),
          activeSession: chatSession(sessionId),
          onNew: () => {},
        }),
      }),
    }));

    await renderSession(SESSION_ID, 'answer from the first session');
    assert.match(container.textContent, /answer from the first session/);

    await renderSession('session-other', 'answer from the second session');
    assert.match(container.textContent, /answer from the second session/);
    assert.doesNotMatch(container.textContent, /answer from the first session/);
  });
});

const SHELL_RUN_UPDATES = [{
  sessionId: 'session-chat',
  ownership: { kind: 'local' as const },
  sourceTurnId: 'turn-1',
  sourceToolCallId: 'bash-1',
  result: chatShellRun(9),
}];

/**
 * A regenerated turn that died to an app restart: the lineage gives turn-1 a
 * forward badge, and the failure makes turn-2 the one turn that may resume.
 */
function restartedLineageMessages(): StoredMessage[] {
  return [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'run a job' },
    { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'first answer', modelId: 'model-1' },
    // Also failed, but not to a restart: it renders a failure banner of its own,
    // so offering the resume on every failed turn is observable.
    {
      type: 'turn_state',
      id: 'state-1',
      turnId: 'turn-1',
      ts: 3,
      status: 'failed',
      errorClass: 'tool_failed',
      partialOutputRetained: true,
    },
    { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 3, text: 'again' },
    { type: 'assistant', id: 'assistant-2', turnId: 'turn-2', ts: 4, text: 'partial answer', modelId: 'model-1' },
    {
      type: 'turn_state',
      id: 'state-2',
      turnId: 'turn-2',
      ts: 5,
      status: 'failed',
      errorClass: 'app_restarted',
      regeneratedFromTurnId: 'turn-1',
      partialOutputRetained: false,
    },
  ];
}

/** A transcript whose first turn owns a background Bash the store leads. */
function transcriptMessages(answer = 'first answer'): StoredMessage[] {
  return [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'run a job' },
    { type: 'tool_call', id: 'bash-1', turnId: 'turn-1', ts: 2, toolName: 'Bash', args: { command: 'job', pty: true } },
    { type: 'tool_result', id: 'result-1', turnId: 'turn-1', ts: 3, toolUseId: 'bash-1', isError: false, content: chatShellRun(1) },
    { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 4, text: answer, modelId: 'model-1' },
    { type: 'turn_state', id: 'state-1', turnId: 'turn-1', ts: 5, status: 'completed', partialOutputRetained: false },
    { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 6, text: 'second' },
    { type: 'assistant', id: 'assistant-2', turnId: 'turn-2', ts: 7, text: 'second answer', modelId: 'model-1' },
    { type: 'turn_state', id: 'state-2', turnId: 'turn-2', ts: 8, status: 'completed', partialOutputRetained: false },
    { type: 'user', id: 'user-3', turnId: 'turn-3', ts: 9, text: 'third' },
  ];
}

function chatShellRun(revision: number) {
  return {
    kind: 'shell_run' as const,
    ref: 'maka://runtime/background-tasks/pty-1',
    mode: 'pty' as const,
    status: 'running' as const,
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty' as const,
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}

function chatSession(id: string): SessionSummary {
  return { ...createSession(id, 'Chat'), lastMessageAt: 1 };
}

/**
 * Each delta closes its text step. An open step is what production streams,
 * but the assistant stream reveals an open step through a timer-driven
 * typewriter this fake DOM cannot advance, so the text would never reach
 * `textContent` and the positive half of the assertion could not be made. What
 * is under test — which turns the projection moves and which TurnViews re-render
 * — is the same either way.
 */
function streamingLiveTurn(text: string): LiveTurnProjection {
  return {
    turnId: 'turn-3',
    phase: 'streamed',
    steps: [{
      stepId: 'step-1',
      contentOrder: ['text'],
      text: { text, truncated: false, complete: true },
      tools: [],
    }],
  };
}

/**
 * Stands in for the shell's real derivation (`app-shell-turn-view-model.ts`):
 * it caches per turn OBJECT, which is the contract the projection exists to
 * support, and counts both how often a turn had to be derived and how often
 * its footer array was read. `TurnFooterActions` maps over the array, so an
 * index read is a render of that turn — the same measurement idiom as
 * `CountedTimestamp`, applied to a prop the test owns rather than to the turn,
 * which ChatView builds itself.
 */
function countingPresentation(): {
  derive(turns: readonly TurnViewModel[]): Record<string, unknown>;
  derivations(): Record<string, number>;
  footerReads(): Record<string, number>;
} {
  const derivations: Record<string, number> = {};
  const reads: Record<string, number> = {};
  const cache = new WeakMap<TurnViewModel, readonly unknown[]>();
  return {
    derive(turns) {
      const footerActionsByTurn: Record<string, readonly unknown[]> = {};
      for (const turn of turns) {
        let actions = cache.get(turn);
        if (!actions) {
          derivations[turn.turnId] = (derivations[turn.turnId] ?? 0) + 1;
          reads[turn.turnId] ??= 0;
          const list = [{ id: 'copy' as const, label: '复制', enabled: true }];
          actions = new Proxy(list, {
            get(target, property, receiver) {
              if (property === '0') reads[turn.turnId] = (reads[turn.turnId] ?? 0) + 1;
              return Reflect.get(target, property, receiver);
            },
          });
          cache.set(turn, actions);
        }
        footerActionsByTurn[turn.turnId] = actions;
      }
      return {
        footerActionsByTurn,
        failedReasonLabels: {},
        failedRecoveryLabels: {},
        lineageBadgesByTurn: {},
      };
    },
    derivations: () => ({ ...derivations }),
    footerReads: () => ({ ...reads }),
  };
}

const NO_PENDING_TURN_ACTIONS: ReadonlySet<string> = new Set<string>();

interface ObserverLifecycle {
  construct: number;
  observe: number;
  disconnect: number;
}

const intersectionLifecycle: ObserverLifecycle = { construct: 0, observe: 0, disconnect: 0 };
const resizeLifecycle: ObserverLifecycle = { construct: 0, observe: 0, disconnect: 0 };

function resetObserverLifecycle(lifecycle: ObserverLifecycle): void {
  lifecycle.construct = 0;
  lifecycle.observe = 0;
  lifecycle.disconnect = 0;
}

/** The prompt rail's observer only — a ResizeObserver must not stand in for it. */
function observerCounts(): ObserverLifecycle {
  return { ...intersectionLifecycle };
}

const LIVE_SESSION_ID = 'session-live';

const selectTestProjection = (state: AppShellSessionUiState, sessionId: string) =>
  state.liveTurnBySession[sessionId];
/** Derives a fresh array on every call, and deliberately ships no comparator. */
const selectTestStopPendingIds = (state: AppShellSessionUiState) => Object.keys(state.stopPendingBySession);

function streamLiveText(
  controller: ReturnType<typeof createAppShellSessionUiStateController>,
  text: string,
  ts: number,
): void {
  const event: SessionEvent = {
    type: 'text_delta',
    id: `event-${ts}`,
    turnId: 'turn-1',
    ts,
    messageId: 'message-1',
    text,
  };
  controller.setLiveTurnBySession((current) => {
    const next = applyLiveTurnEvent(current[LIVE_SESSION_ID], event);
    return next ? { ...current, [LIVE_SESSION_ID]: next } : current;
  });
}

function streamingTurn(text: string, complete: boolean): TurnViewModel {
  return {
    turnId: 'stream-turn-1',
    status: 'running',
    partialOutputRetained: false,
    tools: [],
    notes: [],
    timeline: [{
      kind: 'text',
      text,
      messageId: 'stream-answer-1',
      live: true,
      complete,
    }],
    startedAt: 1,
  };
}

function RenderHost(props: {
  LocaleProvider: UiRenderModule['LocaleProvider'];
  SessionHistoryList: UiRenderModule['SessionHistoryList'];
  activeId: string;
  groups: ReadonlyArray<{ id: string; label: string; sessions: SessionSummary[] }>;
  label: string;
  onSelectSession(sessionId: string): void;
  sessions: SessionSummary[];
  staleSessionIds: Set<string>;
  streamingSessionIds: Set<string>;
}) {
  return createElement(props.LocaleProvider, {
    locale: 'zh',
    children: createElement(
      'div',
      null,
      createElement('p', null, props.label),
      createElement(props.SessionHistoryList, {
        sessions: props.sessions,
        groups: props.groups,
        activeId: props.activeId,
        streamingSessionIds: props.streamingSessionIds,
        staleSessionIds: props.staleSessionIds,
        onSelectSession: props.onSelectSession,
      }),
    ),
  });
}

function createSession(id: string, name: string): SessionSummary {
  return {
    id,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: createCountedTimestamp(1_700_000_000_000),
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
  };
}

function createCountedTimestamp(value: number): CountedTimestamp {
  let reads = 0;
  return {
    readCount: () => reads,
    valueOf() {
      reads += 1;
      return value;
    },
    [Symbol.toPrimitive]() {
      return this.valueOf();
    },
  } as unknown as CountedTimestamp;
}

function timestampReads(sessions: SessionSummary[]): number[] {
  return sessions.map((session) =>
    (session.lastMessageAt as CountedTimestamp).readCount()
  );
}

async function importUiRenderModule(): Promise<UiRenderModule> {
  const outfile = resolve(
    REPO_ROOT,
    'apps/desktop/dist/main/__tests__/ui-render-contract.bundle.mjs',
  );
  await build({
    stdin: {
      contents: [
        "export { SessionHistoryList } from './packages/ui/dist/session-history-list.js';",
        "export { LocaleProvider } from './packages/ui/dist/locale-context.js';",
        "export { TurnView } from './packages/ui/dist/chat-turn.js';",
        "export { ChatView } from './packages/ui/dist/chat-view.js';",
        "export { ChatSurfaceLayout } from './packages/ui/dist/chat-surface-layout.js';",
      ].join('\n'),
      resolveDir: REPO_ROOT,
      sourcefile: 'ui-render-contract.entry.mjs',
    },
    outfile,
    bundle: true,
    external: [
      '@maka/core',
      LUCIDE_REACT_PACKAGE,
      'react',
      'react-dom',
      'react-dom/*',
      'react/jsx-runtime',
    ],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as UiRenderModule;
}

function installReactRenderer(): { root: Root; container: FakeElement } {
  installFakeDom();
  const container = new FakeElement('div', document);
  const root = createRoot(container as unknown as Element);
  cleanupTasks.push(() => {
    act(() => root.unmount());
  });
  return { root, container };
}

async function render(root: Root, element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function installFakeDom(): void {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLIFrameElement = globalThis.HTMLIFrameElement;
  const previousActEnvironment = (globalThis as MemoTestGlobal).IS_REACT_ACT_ENVIRONMENT;
  const fakeDocument = createFakeDocument();
  const fakeWindow = {
    document: fakeDocument,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
    HTMLElement: FakeElement,
    HTMLIFrameElement: class HTMLIFrameElement {},
    // `useDelayedFlag` schedules the turn-wait cues through the window. Timers
    // are real here; the tests below assert only on the undelayed values, and
    // the timers are unref'd so a pending reveal cannot hold the process open.
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms).unref(),
    clearTimeout: (handle: NodeJS.Timeout) => clearTimeout(handle),
  } as unknown as RendererWindow;
  Object.defineProperty(fakeDocument, 'defaultView', { value: fakeWindow });
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
  globalThis.HTMLIFrameElement = fakeWindow.HTMLIFrameElement;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  // The transcript surface observes geometry and escapes turn ids into
  // selectors. Nothing can be measured here, but the observers count their own
  // lifecycle: the prompt rail rebuilds a transcript-wide IntersectionObserver
  // whenever its effect re-runs, which is exactly the per-token work #2030
  // removed, and an observer that is never constructed cannot show that.
  const previousResizeObserver = globalThis.ResizeObserver;
  const previousIntersectionObserver = globalThis.IntersectionObserver;
  const previousCss = (globalThis as { CSS?: unknown }).CSS;
  // Counted per observer kind: sharing one tally let a ResizeObserver from
  // anywhere in the tree satisfy an assertion about the prompt rail, so the
  // guard stayed green even when the rail observed nothing at all.
  const countingObserver = (lifecycle: ObserverLifecycle) => class {
    constructor() { lifecycle.construct += 1; }
    observe(): void { lifecycle.observe += 1; }
    unobserve(): void {}
    disconnect(): void { lifecycle.disconnect += 1; }
    takeRecords(): [] { return []; }
  };
  resetObserverLifecycle(resizeLifecycle);
  resetObserverLifecycle(intersectionLifecycle);
  globalThis.ResizeObserver = countingObserver(resizeLifecycle) as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver = countingObserver(intersectionLifecycle) as unknown as typeof IntersectionObserver;
  (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value, supports: () => false };
  (globalThis as MemoTestGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  cleanupTasks.push(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.HTMLIFrameElement = previousHTMLIFrameElement;
    globalThis.ResizeObserver = previousResizeObserver;
    globalThis.IntersectionObserver = previousIntersectionObserver;
    (globalThis as { CSS?: unknown }).CSS = previousCss;
    (globalThis as MemoTestGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
}

function createFakeDocument(): Document {
  const fakeDocument = {
    nodeType: 9,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement(tagName: string) {
      return new FakeElement(tagName, fakeDocument as unknown as Document);
    },
    createElementNS(_namespace: string, tagName: string) {
      return new FakeElement(tagName, fakeDocument as unknown as Document);
    },
    createTextNode(text: string) {
      return new FakeText(text, fakeDocument as unknown as Document);
    },
  };
  Object.defineProperty(fakeDocument, 'documentElement', {
    value: new FakeElement('html', fakeDocument as unknown as Document),
  });
  return fakeDocument as unknown as Document;
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly dataset: Record<string, string> = {};
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly nodeName: string;
  readonly nodeType = 1;
  readonly style = {
    setProperty() {},
    removeProperty() {},
  } as unknown as CSSStyleDeclaration;
  readonly tagName: string;
  parentNode: FakeElement | null = null;

  constructor(tagName: string, readonly ownerDocument: Document) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes.splice(0);
    if (value !== '') this.appendChild(new FakeText(value, this.ownerDocument));
  }

  addEventListener(): void {}

  /**
   * Attribute-equality selectors only (`[name="value"]`), which is all the
   * chat surface uses to find its `[data-turn-id]` anchors. Returning `null`
   * unconditionally made the prompt rail's whole observer path unreachable, so
   * three commits' worth of behaviour tested green against a DOM that could
   * not express it.
   */
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const match = /^\[([\w-]+)="(.*)"\]$/.exec(selector);
    if (!match) return [];
    const [, name, value] = match;
    const found: FakeElement[] = [];
    const visit = (node: FakeElement | FakeText): void => {
      if (node.nodeType !== 1) return;
      const element = node as FakeElement;
      if (element.getAttribute(name!) === value) found.push(element);
      for (const child of element.childNodes) visit(child);
    };
    for (const child of this.childNodes) visit(child);
    return found;
  }

  getElementsByClassName(): FakeElement[] {
    return [];
  }

  getElementsByTagName(): FakeElement[] {
    return [];
  }

  contains(): boolean {
    return false;
  }

  closest(): FakeElement | null {
    return null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getBoundingClientRect(): { top: number; bottom: number; height: number; left: number; right: number; width: number } {
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends FakeElement | FakeText>(node: T): T {
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  insertBefore<T extends FakeElement | FakeText>(node: T, before: FakeElement | FakeText | null): T {
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) return this.appendChild(node);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  removeChild<T extends FakeElement | FakeText>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  removeEventListener(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeText {
  readonly nodeName = '#text';
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;

  constructor(public nodeValue: string, readonly ownerDocument: Document) {}

  get textContent(): string {
    return this.nodeValue;
  }

  set textContent(value: string) {
    this.nodeValue = value;
  }
}
