import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import type { SessionEvent, SessionSummary } from '@maka/core';
import type { LiveTurnProjection, TurnViewModel } from '@maka/ui';
import { applyLiveTurnEvent, armLiveTurn } from '@maka/ui';
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
  (globalThis as MemoTestGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  cleanupTasks.push(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.HTMLIFrameElement = previousHTMLIFrameElement;
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
