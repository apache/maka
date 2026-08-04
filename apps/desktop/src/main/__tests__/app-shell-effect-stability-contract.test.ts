import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import type {
  ConnectionEvent,
  PlanReminder,
  ProjectRecord,
  SessionEvent,
  SessionEventStreamSnapshot,
  SessionStatus,
  SessionSummary,
  StoredMessage,
} from '@maka/core';
import { build } from 'esbuild';
import { act, createElement, type ReactElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as AppShellEffects from '../../renderer/app-shell-effects.js';
import type * as KeepSystemAwake from '../../renderer/use-keep-system-awake.js';
import type * as ProjectContext from '../../renderer/use-project-context.js';
import type { WindowCommand } from '../../preload/bridge-contract.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

type RefBox<T> = { current: T };
type RendererWindow = Window & typeof globalThis & { maka: RendererMakaStub };
type AppShellEffectsModule = Pick<
  typeof AppShellEffects,
  'useActiveSessionEvents' | 'useAppShellBootstrapSubscriptions' | 'useSessionEventHealthPolling'
>;
type KeepSystemAwakeModule = Pick<typeof KeepSystemAwake, 'useKeepSystemAwake'>;
type ProjectContextModule = Pick<typeof ProjectContext, 'useAppShellProjectContext'>;
type CapturedSubscriptions = {
  activeSessionEvent?: (event: SessionEvent) => void;
  activeSessionSubscribeCount: number;
  connectionEvent?: (event: ConnectionEvent) => void;
  connectionSubscribeCount: number;
  planDue?: (reminder: PlanReminder) => void;
  planDueSubscribeCount: number;
  sessionChange?: (event: { reason: string; sessionId?: string; ts: number; turnId?: string }) => void;
  settingsExternalChanged?: () => void;
  settingsGet?(): Promise<{ system: { keepSystemAwake: boolean } }>;
  windowCommand?: (command: WindowCommand) => void;
  windowCommandSubscribeCount: number;
};
type RendererMakaStub = {
  app: {
    info(): Promise<{
      projectId: string | null | undefined;
      projectPath: string;
      projectGit: { isGitRepo: boolean };
    }>;
    sessionProjectInfo(sessionId: string): Promise<{
      projectPath: string;
      projectGit: { isGitRepo: boolean };
    }>;
  };
  connections: {
    subscribeEvents(callback: (event: ConnectionEvent) => void): () => void;
  };
  plans: {
    subscribeChanges(callback: () => void): () => void;
    subscribeDue(callback: (reminder: never) => void): () => void;
  };
  projects: {
    list(): Promise<ProjectRecord[]>;
  };
  sessions: {
    readMessages(sessionId: string): Promise<StoredMessage[]>;
    subscribeChanges(callback: (event: { reason: string; sessionId?: string; ts: number; turnId?: string }) => void): () => void;
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

// The fake DOM drives the polling contract below: `useSessionEventHealthPolling`
// arms `window.setInterval` and a `visibilitychange` listener, so both have to be
// observable rather than silently swallowed by a no-op stub.
type FakeClock = {
  documentListeners: Map<string, Set<() => void>>;
  intervals: Map<number, { callback: () => void; delayMs: number }>;
  now: number;
};

const FAKE_CLOCK_START = 1_000;

let fakeClock: FakeClock = createFakeClock();

function createFakeClock(): FakeClock {
  return {
    documentListeners: new Map(),
    intervals: new Map(),
    now: FAKE_CLOCK_START,
  };
}

function advanceFakeClock(byMs: number): void {
  fakeClock.now += byMs;
}

function runFakeIntervals(): void {
  for (const { callback } of [...fakeClock.intervals.values()]) callback();
}

function dispatchFakeDocumentEvent(type: string): void {
  for (const listener of [...(fakeClock.documentListeners.get(type) ?? [])]) listener();
}

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  while (cleanupTasks.length > 0) {
    cleanupTasks.pop()?.();
  }
});

const appShellEffects = importAppShellEffects();
const keepSystemAwake = importKeepSystemAwake();
const projectContext = importProjectContext();

describe('AppShell effect stability contract', () => {
  it('refreshes the project catalog when a background session creates a project', async () => {
    const effects = await appShellEffects;
    const refs = createBootstrapRefs();
    const captured = createCapturedSubscriptions();
    const root = installReactRenderer(captured);
    let projectRefreshes = 0;

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
        effects,
        onConnectionEvent: () => {},
        onProjectRefresh: () => {
          projectRefreshes += 1;
        },
        refs,
      }),
    );

    await act(async () => {
      captured.sessionChange?.({ reason: 'created', sessionId: 'background-session', ts: 1 });
      await Promise.resolve();
    });

    assert.equal(projectRefreshes, 1);
  });

  it('refreshes the project catalog after startup migration changes session associations', async () => {
    const effects = await appShellEffects;
    const refs = createBootstrapRefs();
    const captured = createCapturedSubscriptions();
    const root = installReactRenderer(captured);
    let projectRefreshes = 0;

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
        effects,
        onConnectionEvent: () => {},
        onProjectRefresh: () => {
          projectRefreshes += 1;
        },
        refs,
      }),
    );

    await act(async () => {
      captured.sessionChange?.({ reason: 'migrated', ts: 1 });
      await Promise.resolve();
    });

    assert.equal(projectRefreshes, 1);
  });

  // The wiring that answers a send: `onRunStarted` broadcasts a `sessions:changed`
  // naming the turn, and it must reach the arm through the real subscription
  // handler. Without it the arm stays unconfirmed and a stale session list
  // retires it, taking the Stop affordance and the first-token wait with it.
  it('confirms the armed turn a session change names', async () => {
    const effects = await appShellEffects;
    const refs = createBootstrapRefs();
    const captured = createCapturedSubscriptions();
    const root = installReactRenderer(captured);
    const confirmed: Array<[string, string]> = [];

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
        effects,
        onConnectionEvent: () => {},
        onConfirmLiveTurn: (sessionId: string, turnId: string) => confirmed.push([sessionId, turnId]),
        refs,
      }),
    );

    await act(async () => {
      captured.sessionChange?.({ reason: 'status-change', sessionId: 'session-1', ts: 1, turnId: 'turn-1' });
      await Promise.resolve();
    });

    assert.deepEqual(confirmed, [['session-1', 'turn-1']]);
  });

  // A change with no turn to name is a plain catalog invalidation. Treating it
  // as an answer would confirm whatever arm happened to be in flight.
  it('does not confirm anything for a change that names no turn', async () => {
    const effects = await appShellEffects;
    const refs = createBootstrapRefs();
    const captured = createCapturedSubscriptions();
    const root = installReactRenderer(captured);
    const confirmed: Array<[string, string]> = [];

    await render(
      root,
      createElement(BootstrapSubscriptionProbe, {
        effects,
        onConnectionEvent: () => {},
        onConfirmLiveTurn: (sessionId: string, turnId: string) => confirmed.push([sessionId, turnId]),
        refs,
      }),
    );

    await act(async () => {
      captured.sessionChange?.({ reason: 'message-appended', sessionId: 'session-1', ts: 1 });
      await Promise.resolve();
    });

    assert.deepEqual(confirmed, []);
  });

  it('keeps bootstrap subscriptions stable while invoking the latest connection handler', async () => {
    const effects = await appShellEffects;
    const refs = createBootstrapRefs();
    const captured: CapturedSubscriptions = {
      activeSessionSubscribeCount: 0,
      connectionSubscribeCount: 0,
      planDueSubscribeCount: 0,
      windowCommandSubscribeCount: 0,
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
    const effects = await appShellEffects;
    const captured: CapturedSubscriptions = {
      activeSessionSubscribeCount: 0,
      connectionSubscribeCount: 0,
      planDueSubscribeCount: 0,
      windowCommandSubscribeCount: 0,
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

  it('keeps the window-command subscription stable while routing native-menu commands', async () => {
    const effects = await appShellEffects;
    const refs = createBootstrapRefs();
    const captured: CapturedSubscriptions = {
      activeSessionSubscribeCount: 0,
      connectionSubscribeCount: 0,
      planDueSubscribeCount: 0,
      windowCommandSubscribeCount: 0,
    };
    const root = installReactRenderer(captured);
    const commands: string[] = [];
    const run = () =>
      render(
        root,
        createElement(BootstrapSubscriptionProbe, {
          effects,
          onConnectionEvent: () => {},
          onCreateSession: () => commands.push('newTask'),
          onOpenSettings: () => commands.push('openSettings'),
          onOpenHelp: () => commands.push('openHelp'),
          refs,
        }),
      );

    await run();
    assert.equal(captured.windowCommandSubscribeCount, 1);

    await run();
    assert.equal(captured.windowCommandSubscribeCount, 1, 'rerendering with a new handler must not resubscribe');

    await act(async () => {
      captured.windowCommand?.({ id: 'newTask' });
      captured.windowCommand?.({ id: 'openSettings' });
      captured.windowCommand?.({ id: 'openHelp' });
      await Promise.resolve();
    });

    assert.deepEqual(commands, ['newTask', 'openSettings', 'openHelp']);
  });

  it('keeps plan reminder toast actions on the latest navigation handler', async () => {
    const effects = await appShellEffects;
    const refs = createBootstrapRefs();
    const captured: CapturedSubscriptions = {
      activeSessionSubscribeCount: 0,
      connectionSubscribeCount: 0,
      planDueSubscribeCount: 0,
      windowCommandSubscribeCount: 0,
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

  it('does not arm event-health polling for an idle active session', async () => {
    const effects = await appShellEffects;
    const root = installReactRenderer(createCapturedSubscriptions());
    const healthRef = createSessionHealthRef();
    let writes = 0;

    await render(
      root,
      createElement(SessionEventHealthPollingProbe, {
        activeId: 'session-1',
        effects,
        healthRef,
        onHealthWrite: () => {
          writes += 1;
        },
        sessionStatus: 'active',
      }),
    );

    assert.equal(fakeClock.intervals.size, 0, 'an idle session must not arm a polling interval');
    assert.equal(
      fakeClock.documentListeners.get('visibilitychange')?.size ?? 0,
      0,
      'an idle session must not listen for visibility changes',
    );
    assert.equal(writes, 0, 'an idle session has nothing to observe, so it must not probe at all');

    advanceFakeClock(60_000);
    await act(async () => {
      runFakeIntervals();
    });

    assert.equal(writes, 0, 'an idle session must stay silent as time passes');
  });

  it('re-arms when an idle session starts running and disarms once it settles', async () => {
    const effects = await appShellEffects;
    const root = installReactRenderer(createCapturedSubscriptions());
    const healthRef = createSessionHealthRef();
    const renderWithStatus = (sessionStatus: SessionStatus) =>
      render(
        root,
        createElement(SessionEventHealthPollingProbe, {
          activeId: 'session-1',
          effects,
          healthRef,
          sessionStatus,
        }),
      );

    await renderWithStatus('active');
    assert.equal(fakeClock.intervals.size, 0);

    await renderWithStatus('running');
    assert.equal(fakeClock.intervals.size, 1, 'a session that starts running must re-arm on its own');
    assert.equal(fakeClock.documentListeners.get('visibilitychange')?.size, 1);

    await renderWithStatus('active');
    assert.equal(fakeClock.intervals.size, 0, 'settling back to idle must disarm the interval');
    assert.equal(
      fakeClock.documentListeners.get('visibilitychange')?.size ?? 0,
      0,
      'settling back to idle must drop the visibility listener',
    );
  });

  it('keeps polling a running session and refreshes once its stream goes stale', async () => {
    const effects = await appShellEffects;
    const root = installReactRenderer(createCapturedSubscriptions());
    const healthRef = createSessionHealthRef();
    let refreshedMessages = 0;
    let refreshedSessions = 0;

    await render(
      root,
      createElement(SessionEventHealthPollingProbe, {
        activeId: 'session-1',
        effects,
        healthRef,
        onRefreshMessages: () => {
          refreshedMessages += 1;
        },
        onRefreshSessions: () => {
          refreshedSessions += 1;
        },
        sessionStatus: 'running',
      }),
    );

    assert.equal(fakeClock.intervals.size, 1, 'a running session must poll its event stream');
    assert.equal(healthRef.current['session-1']?.status, 'connected');

    advanceFakeClock(16_000);
    await act(async () => {
      runFakeIntervals();
    });

    assert.equal(healthRef.current['session-1']?.status, 'stale');
    assert.equal(refreshedSessions, 1);
    assert.equal(refreshedMessages, 1);

    // Returning to a backgrounded window must probe too, not merely register a
    // listener — assert the probe ran rather than that the handler exists.
    const checkedAtBeforeReturn = healthRef.current['session-1']?.checkedAt;
    advanceFakeClock(1_000);
    await act(async () => {
      dispatchFakeDocumentEvent('visibilitychange');
    });

    assert.notEqual(
      healthRef.current['session-1']?.checkedAt,
      checkedAtBeforeReturn,
      'becoming visible again must re-check the stream',
    );
  });

  it('preserves a known keep-awake snapshot when a later refresh fails', async () => {
    const controller = await keepSystemAwake;
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
    const controller = await keepSystemAwake;
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

  it('does not claim an archived project when main has no resolved selection', async () => {
    const context = await projectContext;
    const captured = createCapturedSubscriptions();
    const root = installReactRenderer(captured);
    const archived = makeProject('archived-project', '/workspace/archived', 2);
    window.maka.projects.list = async () => [archived];
    const snapshots: Array<string | null | undefined> = [];

    await render(
      root,
      createElement(ProjectContextProbe, {
        context,
        onSelectedProjectId: (projectId) => snapshots.push(projectId),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(snapshots.at(-1), undefined);
  });

  it('hydrates project selection from main instead of legacy composer defaults', async () => {
    const context = await projectContext;
    const captured = createCapturedSubscriptions();
    const root = installReactRenderer(captured);
    const project = makeProject('available-project', '/workspace/available');
    window.maka.projects.list = async () => [project];
    window.maka.app.info = async () => ({
      appVersion: 'test',
      electronVersion: 'test',
      nodeVersion: 'test',
      chromeVersion: 'test',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: 'test',
      workspacePath: '/workspace',
      projectId: project.id,
      projectPath: '/workspace/available',
      projectGit: { isGitRepo: false },
      buildMode: 'dev',
      buildCommit: null,
    });
    const snapshots: Array<string | null | undefined> = [];

    await render(
      root,
      createElement(ProjectContextProbe, {
        context,
        onSelectedProjectId: (projectId) => snapshots.push(projectId),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(snapshots.at(-1), project.id);
  });

  it('resolves a session project alias to the surviving active project', async () => {
    const context = await projectContext;
    const captured = createCapturedSubscriptions();
    const root = installReactRenderer(captured);
    const project = {
      ...makeProject('surviving-project', '/workspace/relocated'),
      aliases: ['merged-project'],
    };
    window.maka.projects.list = async () => [project];
    const snapshots: Array<string | undefined> = [];

    await render(
      root,
      createElement(ProjectContextProbe, {
        context,
        sessionId: 'session-1',
        sessionCwd: '/workspace/relocated',
        sessionProjectId: 'merged-project',
        onSelectedProjectId: () => {},
        onCurrentProjectId: (projectId) => snapshots.push(projectId),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(snapshots.at(-1), project.id);
  });
});

function BootstrapSubscriptionProbe(props: {
  effects: AppShellEffectsModule;
  onConnectionEvent(event: ConnectionEvent): void;
  onProjectRefresh?(): void;
  onNavSelection?(selection: { section: string }): void;
  onToastAction?(onClick: (() => void) | undefined): void;
  onConfirmLiveTurn?(sessionId: string, turnId: string): void;
  onCreateSession?(): void;
  onOpenSettings?(): void;
  onOpenHelp?(): void;
  refs: ReturnType<typeof createBootstrapRefs>;
}) {
  props.effects.useAppShellBootstrapSubscriptions({
    uiLocale: 'zh',
    activeIdRef: props.refs.activeIdRef,
    applyE2eFixture: async () => {},
    bootstrapSessions: async () => {},
    clearPendingTurnActionsForSession: () => {},
    confirmLiveTurn: (sessionId: string, turnId: string) => props.onConfirmLiveTurn?.(sessionId, turnId),
    clearSessionRendererState: () => {},
    createSession: () => props.onCreateSession?.(),
    handleConnectionEvent: props.onConnectionEvent,
    openHelp: () => props.onOpenHelp?.(),
    openSettings: () => props.onOpenSettings?.(),
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
    refreshProjects: async () => {
      props.onProjectRefresh?.();
      return [];
    },
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

function SessionEventHealthPollingProbe(props: {
  activeId?: string;
  effects: AppShellEffectsModule;
  healthRef: RefBox<Record<string, SessionEventStreamSnapshot>>;
  onHealthWrite?(): void;
  onRefreshMessages?(): void;
  onRefreshSessions?(): void;
  sessionStatus?: SessionStatus;
}) {
  props.effects.useSessionEventHealthPolling({
    activeId: props.activeId,
    activeInteraction: undefined,
    activeSession: props.sessionStatus
      ? ({ id: props.activeId, status: props.sessionStatus } as SessionSummary)
      : undefined,
    activeStreamingLive: false,
    hasInFlightLiveTools: false,
    refreshMessages: async () => {
      props.onRefreshMessages?.();
      return true;
    },
    refreshSessions: async () => {
      props.onRefreshSessions?.();
      return [];
    },
    sessionEventHealthBySessionRef: props.healthRef,
    // Mirrors the real controller, which syncs the ref inside `replaceState`.
    setSessionEventHealthBySession: (updater) => {
      props.onHealthWrite?.();
      props.healthRef.current = updater(props.healthRef.current);
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

function ProjectContextProbe(props: {
  context: ProjectContextModule;
  sessionId?: string;
  sessionCwd?: string;
  sessionProjectId?: string | null;
  onSelectedProjectId(projectId: string | null | undefined): void;
  onCurrentProjectId?(projectId: string | undefined): void;
}) {
  const state = props.context.useAppShellProjectContext({
    uiLocale: 'zh',
    rendererMountedRef: { current: true },
    sessionId: props.sessionId,
    sessionCwd: props.sessionCwd,
    sessionProjectId: props.sessionProjectId,
    onProjectSelected: () => {},
    toastApi: {
      success: () => {},
      error: () => {},
    },
  });
  useEffect(() => {
    props.onSelectedProjectId(state.selectedProjectId);
  }, [props, state.selectedProjectId]);
  useEffect(() => {
    props.onCurrentProjectId?.(state.currentProject?.id);
  }, [props, state.currentProject]);
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

async function importProjectContext(): Promise<ProjectContextModule> {
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/project-context-'));
  const outfile = resolve(outdir, 'use-project-context.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/use-project-context.ts')],
    outfile,
    bundle: true,
    external: ['react'],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as ProjectContextModule;
}

function createCapturedSubscriptions(
  overrides: Partial<CapturedSubscriptions> = {},
): CapturedSubscriptions {
  return {
    activeSessionSubscribeCount: 0,
    connectionSubscribeCount: 0,
    planDueSubscribeCount: 0,
    windowCommandSubscribeCount: 0,
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

function createSessionHealthRef(
  subscribedAt = FAKE_CLOCK_START,
): RefBox<Record<string, SessionEventStreamSnapshot>> {
  return {
    current: {
      'session-1': {
        sessionId: 'session-1',
        status: 'connected',
        subscribedAt,
        checkedAt: subscribedAt,
      },
    },
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
    app: {
      info: async () => ({
        projectId: undefined,
        projectPath: '/workspace/relocated',
        projectGit: { isGitRepo: false },
      }),
      sessionProjectInfo: async () => ({
        projectPath: '/workspace/relocated',
        projectGit: { isGitRepo: false },
      }),
    },
    appWindow: {
      subscribeCommand(callback: (command: WindowCommand) => void) {
        captured.windowCommandSubscribeCount += 1;
        captured.windowCommand = callback;
        return noop;
      },
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
    projects: {
      list: async () => [],
    },
    sessions: {
      readMessages: async () => [],
      subscribeChanges(callback: (event: { reason: string; sessionId?: string; ts: number; turnId?: string }) => void) {
        captured.sessionChange = callback;
        return noop;
      },
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

function makeProject(id: string, path: string, archivedAt?: number): ProjectRecord {
  return {
    id,
    name: id,
    locations: [{ path, isWorktree: false }],
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    available: true,
    preferredPath: path,
  };
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
  const previousDateNow = Date.now;
  fakeClock = createFakeClock();
  let nextIntervalId = 1;
  const fakeDocument = createFakeDocument();
  const fakeWindow = {
    document: fakeDocument,
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: (callback: () => void, delayMs: number) => {
      const id = nextIntervalId++;
      fakeClock.intervals.set(id, { callback, delayMs });
      return id;
    },
    clearInterval: (id: number) => {
      fakeClock.intervals.delete(id);
    },
    HTMLElement: class HTMLElement {},
    HTMLIFrameElement: class HTMLIFrameElement {},
  } as unknown as RendererWindow;
  Date.now = () => fakeClock.now;
  cleanupTasks.push(() => {
    Date.now = previousDateNow;
  });
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
    visibilityState: 'visible',
    addEventListener(type: string, listener: () => void) {
      const listeners = fakeClock.documentListeners.get(type) ?? new Set<() => void>();
      listeners.add(listener);
      fakeClock.documentListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: () => void) {
      fakeClock.documentListeners.get(type)?.delete(listener);
    },
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
