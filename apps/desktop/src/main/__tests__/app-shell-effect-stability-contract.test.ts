import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import type { ConnectionEvent, PlanReminder, SessionEvent, StoredMessage } from '@maka/core';
import { build } from 'esbuild';
import { act, createElement, type ReactElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as AppShellEffects from '../../renderer/app-shell-effects.js';
import type * as KeepSystemAwake from '../../renderer/use-keep-system-awake.js';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

type RefBox<T> = { current: T };
type RendererWindow = Window & typeof globalThis & { maka: RendererMakaStub };
type AppShellEffectsModule = Pick<
  typeof AppShellEffects,
  'useActiveSessionEvents' | 'useAppShellBootstrapSubscriptions'
>;
type KeepSystemAwakeModule = Pick<typeof KeepSystemAwake, 'useKeepSystemAwake'>;
type CapturedSubscriptions = {
  activeSessionEvent?: (event: SessionEvent) => void;
  activeSessionSubscribeCount: number;
  connectionEvent?: (event: ConnectionEvent) => void;
  connectionSubscribeCount: number;
  planDue?: (reminder: PlanReminder) => void;
  planDueSubscribeCount: number;
  settingsExternalChanged?: () => void;
  settingsGet?(): Promise<{ system: { keepSystemAwake: boolean } }>;
};
type RendererMakaStub = {
  appWindow: {
    subscribeOpenSettings(callback: () => void): () => void;
  };
  connections: {
    subscribeEvents(callback: (event: ConnectionEvent) => void): () => void;
  };
  plans: {
    subscribeChanges(callback: () => void): () => void;
    subscribeDue(callback: (reminder: never) => void): () => void;
  };
  sessions: {
    readMessages(sessionId: string): Promise<StoredMessage[]>;
    subscribeChanges(callback: (event: { reason: string; sessionId?: string; ts: number }) => void): () => void;
    subscribeEvents(sessionId: string, callback: (event: SessionEvent) => void): () => void;
  };
  settings: {
    get(): Promise<{ system: { keepSystemAwake: boolean } }>;
    subscribeExternalChanged(callback: () => void): () => void;
    update(input: {
      system: { keepSystemAwake: boolean };
    }): Promise<{ settings: { system: { keepSystemAwake: boolean } } }>;
  };
};

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  while (cleanupTasks.length > 0) {
    cleanupTasks.pop()?.();
  }
});

describe('AppShell effect stability contract', () => {
  it('keeps bootstrap subscriptions stable while invoking the latest connection handler', async () => {
    const effects = await importAppShellEffects();
    const refs = createBootstrapRefs();
    const captured: CapturedSubscriptions = {
      activeSessionSubscribeCount: 0,
      connectionSubscribeCount: 0,
      planDueSubscribeCount: 0,
    };
    const root = installReactRenderer(captured);
    const calls: string[] = [];
    const event = { provider: 'sentinel' } as unknown as ConnectionEvent;

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
      effects,
      onConnectionEvent: () => calls.push('first'),
      refs,
      }),
    );
    assert.equal(captured.connectionSubscribeCount, 1);

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
      effects,
      onConnectionEvent: () => calls.push('second'),
      refs,
      }),
    );
    assert.equal(captured.connectionSubscribeCount, 1, 'rerendering with a new handler must not resubscribe');

    await act(async () => {
      captured.connectionEvent?.(event);
    });

    assert.deepEqual(calls, ['second']);
  });

  it('keeps active-session subscriptions stable while invoking the latest event handler', async () => {
    const effects = await importAppShellEffects();
    const captured: CapturedSubscriptions = {
      activeSessionSubscribeCount: 0,
      connectionSubscribeCount: 0,
      planDueSubscribeCount: 0,
    };
    const root = installReactRenderer(captured);
    const refs = { activeIdRef: { current: 'session-1' } };
    const calls: string[] = [];
    const event = { type: 'sentinel' } as unknown as SessionEvent;

    await render(
      root,
      createElement(ActiveSessionEventProbe, {
      effects,
      onSessionEvent: () => calls.push('first'),
      refs,
      }),
    );
    assert.equal(captured.activeSessionSubscribeCount, 1);

    await render(
      root,
      createElement(ActiveSessionEventProbe, {
      effects,
      onSessionEvent: () => calls.push('second'),
      refs,
      }),
    );
    assert.equal(captured.activeSessionSubscribeCount, 1, 'rerendering with a new handler must not resubscribe');

    await act(async () => {
      captured.activeSessionEvent?.(event);
    });

    assert.deepEqual(calls, ['second']);
  });

  it('keeps plan reminder toast actions on the latest navigation handler', async () => {
    const effects = await importAppShellEffects();
    const refs = createBootstrapRefs();
    const captured: CapturedSubscriptions = {
      activeSessionSubscribeCount: 0,
      connectionSubscribeCount: 0,
      planDueSubscribeCount: 0,
    };
    const root = installReactRenderer(captured);
    const navSections: string[] = [];
    let toastAction: (() => void) | undefined;

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
      effects,
      onConnectionEvent: () => {},
      onNavSelection: () => navSections.push('first'),
      onToastAction: (action) => {
        toastAction = action;
      },
      refs,
      }),
    );
    assert.equal(captured.planDueSubscribeCount, 1);

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
      effects,
      onConnectionEvent: () => {},
      onNavSelection: (selection) => navSections.push(selection.section),
      onToastAction: (action) => {
        toastAction = action;
      },
      refs,
      }),
    );
    assert.equal(captured.planDueSubscribeCount, 1, 'rerendering with a new handler must not resubscribe');

    await act(async () => {
      captured.planDue?.(createPlanReminder());
    });
    assert.ok(toastAction, 'plan reminder toast must expose a navigation action');

    await act(async () => {
      toastAction?.();
    });

    assert.deepEqual(navSections, ['automations']);
  });

  it('uses React effect events instead of a local latest-ref helper', async () => {
    const src = await readRendererShellSource('app-shell-effects.ts');

    assert.match(src, /\buseEffectEvent\(/);
    assert.doesNotMatch(src, /\buseLatestRef\b|\blatestOptionsRef\b/);
  });

  it('preserves a known keep-awake snapshot when a later refresh fails', async () => {
    const controller = await importKeepSystemAwake();
    let readCount = 0;
    const captured = createCapturedSubscriptions({
      settingsGet: async () => {
        readCount += 1;
        if (readCount === 1) return { system: { keepSystemAwake: true } };
        throw new Error('transient read failure');
      },
    });
    const root = installReactRenderer(captured);
    const snapshots: Array<boolean | undefined> = [];

    await render(
      root,
      createElement(KeepSystemAwakeProbe, {
        controller,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      }),
    );
    assert.equal(snapshots.at(-1), true);

    await act(async () => {
      captured.settingsExternalChanged?.();
      await Promise.resolve();
    });

    assert.equal(snapshots.at(-1), true);
  });

  it('falls back to false when the initial keep-awake read fails', async () => {
    const controller = await importKeepSystemAwake();
    const captured = createCapturedSubscriptions({
      settingsGet: async () => {
        throw new Error('initial read failure');
      },
    });
    const root = installReactRenderer(captured);
    const snapshots: Array<boolean | undefined> = [];

    await render(
      root,
      createElement(KeepSystemAwakeProbe, {
        controller,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      }),
    );

    assert.equal(snapshots.at(-1), false);
  });
});

function BootstrapSubscriptionProbe(props: {
  effects: AppShellEffectsModule;
  onConnectionEvent(event: ConnectionEvent): void;
  onNavSelection?(selection: { section: string }): void;
  onToastAction?(onClick: (() => void) | undefined): void;
  refs: ReturnType<typeof createBootstrapRefs>;
}) {
  props.effects.useAppShellBootstrapSubscriptions({
    uiLocale: 'zh',
    activeIdRef: props.refs.activeIdRef,
    applyE2eFixture: async () => {},
    bootstrapSessions: async () => {},
    clearPendingTurnActionsForSession: () => {},
    clearSessionRendererState: () => {},
    createSession: () => {},
    handleConnectionEvent: props.onConnectionEvent,
    openSettings: () => {},
    pendingPermissionModeChangesRef: props.refs.pendingPermissionModeChangesRef,
    pendingSessionModelChangesRef: props.refs.pendingSessionModelChangesRef,
    pendingTurnActionTimersRef: props.refs.pendingTurnActionTimersRef,
    pendingTurnActionsRef: props.refs.pendingTurnActionsRef,
    projectPickerPendingRef: props.refs.projectPickerPendingRef,
    projectPickerRequestRef: props.refs.projectPickerRequestRef,
    refreshAppInfo: async () => {},
    refreshConnections: async () => {},
    refreshMemoryActive: async () => {},
    refreshMessages: async () => true,
    refreshPlanReminders: async () => {},
    refreshShellSettings: async () => {},
    refreshSkills: async () => {},
    refreshManagedSkillSources: async () => {},
    refreshBundledSkillCatalog: async () => {},
    refreshSessions: async () => [],
    rendererMountedRef: props.refs.rendererMountedRef,
    setActiveId: () => {},
    setMessages: () => {},
    setNavSelection: (selection) => {
      props.onNavSelection?.(selection);
    },
    setSessionEventHealthBySession: () => {},
    toastApi: {
      error: () => {},
      info: () => {},
      toast: (payload) => {
        props.onToastAction?.(payload.action?.onClick);
      },
    },
  });
  return null;
}

function ActiveSessionEventProbe(props: {
  effects: AppShellEffectsModule;
  onSessionEvent(sessionId: string, event: SessionEvent): void;
  refs: { activeIdRef: RefBox<string | undefined> };
}) {
  props.effects.useActiveSessionEvents({
    uiLocale: 'zh',
    activeId: 'session-1',
    activeIdRef: props.refs.activeIdRef,
    handleEvent: props.onSessionEvent,
    markSessionReadLocally: () => {},
    setMessageLoadErrorBySession: () => {},
    setMessageLoadPending: () => {},
    setMessages: () => {},
    setSessionEventHealthBySession: () => {},
    toastApi: {
      error: () => {},
    },
  });
  return null;
}

function KeepSystemAwakeProbe(props: {
  controller: KeepSystemAwakeModule;
  onSnapshot(snapshot: boolean | undefined): void;
}) {
  const state = props.controller.useKeepSystemAwake();
  useEffect(() => {
    props.onSnapshot(state.keepSystemAwake);
  }, [props, state.keepSystemAwake]);
  return null;
}

async function importAppShellEffects(): Promise<AppShellEffectsModule> {
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/app-shell-effects-'));
  const outfile = resolve(outdir, 'app-shell-effects.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/app-shell-effects.ts')],
    outfile,
    bundle: true,
    external: ['react'],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as AppShellEffectsModule;
}

async function importKeepSystemAwake(): Promise<KeepSystemAwakeModule> {
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/keep-system-awake-'));
  const outfile = resolve(outdir, 'use-keep-system-awake.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/use-keep-system-awake.ts')],
    outfile,
    bundle: true,
    alias: {
      '@maka/ui': resolve(REPO_ROOT, 'packages/ui/src/use-mounted-ref.ts'),
    },
    external: ['react'],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as KeepSystemAwakeModule;
}

function createCapturedSubscriptions(
  overrides: Partial<CapturedSubscriptions> = {},
): CapturedSubscriptions {
  return {
    activeSessionSubscribeCount: 0,
    connectionSubscribeCount: 0,
    planDueSubscribeCount: 0,
    ...overrides,
  };
}

function createBootstrapRefs() {
  return {
    activeIdRef: { current: 'session-1' as string | undefined },
    pendingPermissionModeChangesRef: { current: new Set<string>() },
    pendingSessionModelChangesRef: { current: new Set<string>() },
    pendingTurnActionTimersRef: {
      current: new Map<string, ReturnType<typeof setTimeout>>(),
    },
    pendingTurnActionsRef: { current: new Set<string>() },
    projectPickerPendingRef: { current: false },
    projectPickerRequestRef: { current: 0 },
    rendererMountedRef: { current: false },
  };
}

function createPlanReminder(): PlanReminder {
  return {
    id: 'reminder-1',
    title: 'Review automations',
    note: '',
    schedule: { kind: 'once', runAt: 1 },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    runCount: 0,
  };
}

function installReactRenderer(captured: CapturedSubscriptions): Root {
  installFakeDom();
  installFakeMaka(captured);
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

function installFakeMaka(captured: CapturedSubscriptions): void {
  window.maka = {
    appWindow: {
      subscribeOpenSettings: () => noop,
    },
    connections: {
      subscribeEvents(callback: (event: ConnectionEvent) => void) {
        captured.connectionSubscribeCount += 1;
        captured.connectionEvent = callback;
        return noop;
      },
    },
    plans: {
      subscribeChanges: () => noop,
      subscribeDue(callback: (reminder: PlanReminder) => void) {
        captured.planDueSubscribeCount += 1;
        captured.planDue = callback;
        return noop;
      },
    },
    sessions: {
      readMessages: async () => [],
      subscribeChanges: () => noop,
      subscribeEvents(_sessionId: string, callback: (event: SessionEvent) => void) {
        captured.activeSessionSubscribeCount += 1;
        captured.activeSessionEvent = callback;
        return noop;
      },
    },
    settings: {
      get: captured.settingsGet ?? (async () => ({ system: { keepSystemAwake: false } })),
      subscribeExternalChanged(callback: () => void) {
        captured.settingsExternalChanged = callback;
        return noop;
      },
      update: async ({ system }: { system: { keepSystemAwake: boolean } }) => ({
        settings: { system },
      }),
    },
  } as unknown as RendererWindow['maka'];
}

function installFakeDom(): void {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousActEnvironment = (
    globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT;
  const fakeDocument = createFakeDocument();
  const fakeWindow = {
    document: fakeDocument,
    addEventListener: () => {},
    removeEventListener: () => {},
    HTMLElement: class HTMLElement {},
    HTMLIFrameElement: class HTMLIFrameElement {},
  } as unknown as RendererWindow;
  Object.defineProperty(fakeDocument, 'defaultView', { value: fakeWindow });
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  cleanupTasks.push(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
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
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly nodeName: string;
  readonly nodeType = 1;
  readonly tagName: string;
  parentNode: FakeElement | null = null;
  textContent = '';

  constructor(
    tagName: string,
    readonly ownerDocument: Document,
  ) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  addEventListener(): void {}

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

  removeAttribute(): void {}

  removeChild<T extends FakeElement | FakeText>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
    node.parentNode = null;
    return node;
  }

  removeEventListener(): void {}

  setAttribute(): void {}
}

class FakeText {
  readonly nodeName = '#text';
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;

  constructor(
    readonly nodeValue: string,
    readonly ownerDocument: Document,
  ) {}
}

function noop(): void {}
