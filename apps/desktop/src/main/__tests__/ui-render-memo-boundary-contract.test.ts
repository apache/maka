import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core';
import { build, type Plugin } from 'esbuild';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const LUCIDE_REACT_PACKAGE = ['lucide', 'react'].join('-');

type SessionHistoryModule = {
  LocaleProvider(props: { locale: 'zh'; children: ReactElement }): ReactElement;
  SessionHistoryList(props: {
    sessions: SessionSummary[];
    activeId?: string;
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
};
type RendererWindow = Window & typeof globalThis;
type MemoTestGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
type ResettableTimestamp = number & { reset(): void };

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  while (cleanupTasks.length > 0) {
    cleanupTasks.pop()?.();
  }
});

describe('UI render memo boundary contract', () => {
  it('keeps sidebar session rows from rendering on unrelated parent updates with row actions present', async () => {
    const { LocaleProvider, SessionHistoryList } = await importSessionHistoryList();
    const root = installReactRenderer();
    let rowRenderCount = 0;
    const sessions = [
      createSession('session-a', 'Alpha', () => {
        rowRenderCount += 1;
      }),
      createSession('session-b', 'Beta', () => {
        rowRenderCount += 1;
      }),
    ];
    const streamingSessionIds = new Set<string>();
    const staleSessionIds = new Set<string>();
    const rowActions = createRowActions();
    const onSelectSession = () => {};

    resetTimestampCounters(sessions);
    await render(root, createElement(RenderHost, {
      SessionHistoryList,
      LocaleProvider,
      label: 'first parent render',
      onSelectSession,
      rowActions,
      sessions,
      staleSessionIds,
      streamingSessionIds,
    }));
    assert.equal(rowRenderCount, 2);

    resetTimestampCounters(sessions);
    await render(root, createElement(RenderHost, {
      SessionHistoryList,
      LocaleProvider,
      label: 'unrelated parent render',
      onSelectSession,
      rowActions,
      sessions,
      staleSessionIds,
      streamingSessionIds,
    }));

    assert.equal(
      rowRenderCount,
      2,
      'stable session rows should not recompute row meta when only sibling parent content changes',
    );

    const nextStreamingSessionIds = new Set<string>(['session-a']);
    resetTimestampCounters(sessions);
    await render(root, createElement(RenderHost, {
      SessionHistoryList,
      LocaleProvider,
      label: 'streaming session update',
      onSelectSession,
      rowActions,
      sessions,
      staleSessionIds,
      streamingSessionIds: nextStreamingSessionIds,
    }));

    assert.equal(
      rowRenderCount,
      3,
      'streaming updates should only recompute the row whose streaming flag changed',
    );
  });
});

function RenderHost(props: {
  LocaleProvider: SessionHistoryModule['LocaleProvider'];
  SessionHistoryList: SessionHistoryModule['SessionHistoryList'];
  label: string;
  onSelectSession(sessionId: string): void;
  rowActions: NonNullable<Parameters<SessionHistoryModule['SessionHistoryList']>[0]['rowActions']>;
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
        activeId: 'session-a',
        streamingSessionIds: props.streamingSessionIds,
        staleSessionIds: props.staleSessionIds,
        onSelectSession: props.onSelectSession,
        rowActions: props.rowActions,
      }),
    ),
  });
}

function createSession(id: string, name: string, onRender: () => void): SessionSummary {
  return {
    id,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: createCountedTimestamp(1_700_000_000_000, onRender) as unknown as number,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
  };
}

function createCountedTimestamp(value: number, onRender: () => void): ResettableTimestamp {
  let counted = false;
  return {
    reset() {
      counted = false;
    },
    valueOf() {
      // The parent also reads lastMessageAt for bucketing; only row rendering
      // calls the compact timestamp formatter.
      if (!counted && new Error().stack?.includes('formatCompactTimestamp')) {
        counted = true;
        onRender();
      }
      return value;
    },
    [Symbol.toPrimitive]() {
      return this.valueOf();
    },
  } as unknown as ResettableTimestamp;
}

function resetTimestampCounters(sessions: SessionSummary[]): void {
  for (const session of sessions) {
    (session.lastMessageAt as ResettableTimestamp).reset();
  }
}

function createRowActions(): NonNullable<Parameters<SessionHistoryModule['SessionHistoryList']>[0]['rowActions']> {
  return {
    onToggleFlag() {},
    onArchive() {},
    onUnarchive() {},
    onRename() {},
    onDelete() {},
  };
}

async function importSessionHistoryList(): Promise<SessionHistoryModule> {
  const outfile = resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/session-history-list.memo-bundle.mjs');
  await build({
    stdin: {
      contents: [
        "export { SessionHistoryList } from './packages/ui/dist/session-history-list.js';",
        "export { LocaleProvider } from './packages/ui/dist/locale-context.js';",
      ].join('\n'),
      resolveDir: REPO_ROOT,
      sourcefile: 'session-history-list.memo-entry.mjs',
    },
    outfile,
    bundle: true,
    external: ['@maka/core', LUCIDE_REACT_PACKAGE, 'react', 'react-dom', 'react-dom/*', 'react/jsx-runtime'],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    plugins: [mockOverlayScrollbars()],
  });
  return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as SessionHistoryModule;
}

function mockOverlayScrollbars(): Plugin {
  return {
    name: 'mock-overlayscrollbars',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^overlayscrollbars$/ }, () => ({
        path: 'overlayscrollbars-mock',
        namespace: 'memo-test',
      }));
      buildApi.onLoad({ filter: /^overlayscrollbars-mock$/, namespace: 'memo-test' }, () => ({
        loader: 'js',
        contents: 'export function OverlayScrollbars() { return { destroy() {}, options() {} }; }',
      }));
    },
  };
}

function installReactRenderer(): Root {
  installFakeDom();
  const container = new FakeElement('div', document);
  const root = createRoot(container as unknown as Element);
  cleanupTasks.push(() => {
    act(() => {
      root.unmount();
    });
  });
  return root;
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
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLIFrameElement = globalThis.HTMLIFrameElement;
  const previousActEnvironment = (globalThis as MemoTestGlobal).IS_REACT_ACT_ENVIRONMENT;
  const fakeDocument = createFakeDocument();
  const fakeWindow = {
    document: fakeDocument,
    addEventListener: () => {},
    removeEventListener: () => {},
    HTMLElement: FakeElement,
    HTMLIFrameElement: class HTMLIFrameElement {},
  } as unknown as RendererWindow;
  Object.defineProperty(fakeDocument, 'defaultView', { value: fakeWindow });
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
  globalThis.HTMLIFrameElement = fakeWindow.HTMLIFrameElement;
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };
  (globalThis as MemoTestGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  cleanupTasks.push(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
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
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly nodeName: string;
  readonly nodeType = 1;
  readonly style = {
    setProperty() {},
    removeProperty() {},
  } as unknown as CSSStyleDeclaration;
  readonly tagName: string;
  parentNode: FakeElement | null = null;
  textContent = '';

  constructor(tagName: string, readonly ownerDocument: Document) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
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
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
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

  constructor(readonly nodeValue: string, readonly ownerDocument: Document) {}
}
