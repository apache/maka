import { useEffect, useEffectEvent, useLayoutEffect } from 'react';
import { useHotkeys } from '@astryxdesign/core/hooks';
import type { ConnectionEvent } from '@maka/core/connections';
import type { SessionChangedEvent, SessionSummary, StoredMessage } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import type { ThemePalette, ThemePreference } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import { generalizedErrorMessageChinese } from '@maka/core/redaction';
import { sessionExpectsEventStream } from '@maka/core/session-event-health';
import { type ShellRunUpdate } from '@maka/core/events';
import type { LiveTurnProjection, NavSelection, SessionViewMode } from '@maka/ui';
import { messageReadErrorMessage } from './app-shell-copy';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';
import { applyTheme, applyThemePalette } from './theme';
import { startTitlebarModalSync } from './titlebar-modal-sync';
import { safeLocalStorageSet } from './browser-storage';
import type { NavigationState } from './nav-selection.js';
import { writeSessionListViewMode } from './session-list-layout.js';
import {
  createSessionEventStreamSubscription,
  evaluateSessionEventStreamSnapshot,
  recordSessionEventStreamChange,
  recordSessionEventStreamEvent,
} from './session-event-health';
import {
  persistableSessionWorkbarPanels,
  type SessionWorkbarPanelsState,
} from './session-workbar-tabs.js';
import type {
  DesktopRuntimeHostProfileChangedEvent,
  WindowCommand,
} from '../preload/bridge-contract.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import {
  mergeShellRunNotification,
  mergeShellRunUpdates,
  ShellRunHydration,
  type ShellRunUpdatesBySession,
} from './shell-run-update-state.js';
import {
  createDesktopTranscriptRangeController,
  DesktopTranscriptRangeStore,
  type DesktopTranscriptRangeController,
} from './desktop-transcript-range-store.js';

type RefBox<T> = { current: T };
const LAYOUT_PERSIST_DEBOUNCE_MS = 200;

type SessionEventHealthUpdater = (
  updater: (current: Record<string, SessionEventStreamSnapshot>) => Record<string, SessionEventStreamSnapshot>,
) => void;

type ToastApi = {
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
  toast(options: {
    title: string;
    description?: string;
    variant?: 'info' | 'error' | 'success' | 'warning';
    duration?: number;
    action?: { label: string; onClick: () => void };
  }): void;
};

export function useAppShellNavRefSync(options: { navSelection: NavSelection; navSelectionRef: RefBox<NavSelection> }) {
  useEffect(() => {
    options.navSelectionRef.current = options.navSelection;
  }, [options.navSelection]);
}

export function useAppShellHostEffects(options: {
  activeId: string | undefined;
  setLiveBrowserSessionIds: (sessionIds: string[]) => void;
}) {
  // Tag the document with the host OS so glass-material CSS rules
  // (sidebar vibrancy passthrough)
  // can light up only on macOS, where `BrowserWindow({ vibrancy: 'sidebar' })`
  // paints the native blur material behind the renderer. Other platforms
  // keep their opaque chrome since vibrancy is a no-op there.
  useEffect(() => {
    let cancelled = false;
    void window.maka.app
      .info()
      .then((info) => {
      if (cancelled) return;
      document.documentElement.setAttribute('data-os', info.platform);
      })
      .catch(() => {
      /* swallow — leaves data-os unset, CSS falls back to opaque chrome */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // P3 embedded browser: track which sessions have a live view (panel mounts
  // only for those) and tell main which session this window shows (so it can
  // validate browser:* IPC targets).
  useEffect(() => {
    const off = window.maka.browser.onLive((payload) => options.setLiveBrowserSessionIds(payload.sessionIds));
    return off;
  }, []);

  useEffect(() => {
    window.maka.browser.setActiveSession(options.activeId ?? null);
  }, [options.activeId]);

  // Modal-open titlebar dimming/hiding is driven by observing the top layer
  // (`dialog:modal`) rather than the shell's own modal state, so dialogs
  // mounted deep in module pages — the scheduled-task form above all — are
  // covered too. See titlebar-modal-sync.ts.
  useEffect(() => startTitlebarModalSync(), []);
}

export function useAppShellPersistenceEffects(options: {
  navigationState: NavigationState;
  sessionListCollapsed: boolean;
  sessionListWidth: number;
  sessionListViewMode: SessionViewMode;
  workbarCollapsed: boolean;
  workbarWidth: number;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  workbarPanelsState: SessionWorkbarPanelsState;
  themePalette: ThemePalette;
  themePref: ThemePreference;
}) {
  // Keep <html class="dark"> in sync with the active preference. The Settings
  // modal also calls applyTheme on local change so the effect is immediate,
  // but this keeps the listener for 'auto' alive at the app level.
  useEffect(() => {
    const unsubscribe = applyTheme(options.themePref);
    return unsubscribe;
  }, [options.themePref]);

  // PR-THEME-APPLY-AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): re-apply the
  // palette data attribute whenever the persisted setting changes, so
  // switching themes in Settings is immediately visible. Previously the
  // attribute was only set once at mount, so a palette change required a
  // restart before the new colors took effect.
  useEffect(() => {
    applyThemePalette(options.themePalette);
  }, [options.themePalette]);

  // PR-FE-BUG-HUNT-5 (kenji bug-hunt 2026-06-24 LOW): pointer drag on
  // the sidebar resizer fires `setSessionListWidth` on every move
  // event — at ~60Hz over a long drag, that's a couple hundred
  // localStorage writes for a single resize gesture. The setting
  // converges to the user's final width at rest; intermediate
  // values aren't load-bearing. 200ms trailing debounce keeps the
  // last-render value in storage without flushing every pixel.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      safeLocalStorageSet('maka-chat-list-width-v1', String(options.sessionListWidth));
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [options.sessionListWidth]);

  useEffect(() => {
    safeLocalStorageSet('maka-chat-list-collapsed-v1', options.sessionListCollapsed ? 'true' : 'false');
  }, [options.sessionListCollapsed]);

  useEffect(() => {
    writeSessionListViewMode(options.sessionListViewMode);
  }, [options.sessionListViewMode]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      safeLocalStorageSet('maka-session-workbar-width-v1', String(options.workbarWidth));
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [options.workbarWidth]);

  useEffect(() => {
    safeLocalStorageSet('maka-session-workbar-collapsed-v1', options.workbarCollapsed ? 'true' : 'false');
  }, [options.workbarCollapsed]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      safeLocalStorageSet(
        'maka-session-bottom-panel-height-v1',
        String(options.bottomPanelHeight),
      );
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [options.bottomPanelHeight]);

  useEffect(() => {
    safeLocalStorageSet(
      'maka-session-bottom-panel-open-v1',
      options.bottomPanelOpen ? 'true' : 'false',
    );
  }, [options.bottomPanelOpen]);

  useEffect(() => {
    safeLocalStorageSet(
      'maka-session-workbar-panels-v3',
      JSON.stringify(persistableSessionWorkbarPanels(options.workbarPanelsState)),
    );
  }, [options.workbarPanelsState]);

  // Persist the active destination and each hub's last selected module.
  // Strict localStorage availability check — Vite dev sometimes runs through
  // a worker where it isn't defined.
  useEffect(() => {
    safeLocalStorageSet('maka-nav-selection-v1', JSON.stringify(options.navigationState));
  }, [options.navigationState]);
}

export function useAppShellBootstrapSubscriptions(options: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  applyE2eFixture: () => Promise<void>;
  bootstrapSessions: () => Promise<void>;
  clearPendingTurnActionsForSession: (sessionId: string) => void;
  /** Releases a send's pending claim once the authority names that turn. */
  confirmLiveTurn: (sessionId: string, turnId: string) => void;
  clearSessionRendererState: (sessionId: string) => void;
  createSession: () => Promise<void> | void;
  handleConnectionEvent: (event: ConnectionEvent) => void;
  openHelp: () => void;
  openSettings: () => void;
  pendingPermissionModeChangesRef: RefBox<Set<string>>;
  pendingSessionModelChangesRef: RefBox<Set<string>>;
  pendingTurnActionTimersRef: RefBox<Map<string, ReturnType<typeof setTimeout>>>;
  pendingTurnActionsRef: RefBox<Set<string>>;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
  refreshConnections: () => Promise<void>;
  refreshMemoryActive: (failureContext?: 'load') => Promise<void>;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshScheduledTasks: (options?: { shouldShowError?: () => boolean }) => Promise<void>;
  refreshProjects: () => Promise<unknown>;
  refreshShellSettings: () => Promise<void>;
  refreshSkills: (options?: { shouldShowError?: () => boolean }) => Promise<void>;
  refreshManagedSkillSources: (options?: { shouldShowError?: () => boolean }) => Promise<void>;
  refreshBundledSkillCatalog: (options?: { shouldShowError?: () => boolean }) => Promise<void>;
  refreshSessions: () => Promise<SessionSummary[]>;
  rendererMountedRef: RefBox<boolean>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessages: (messages: StoredMessage[]) => void;
  setNavSelection: (selection: NavSelection) => void;
  setSessionEventHealthBySession: SessionEventHealthUpdater;
  toastApi: ToastApi;
}) {
  const runDeferredStartupRefreshes = useEffectEvent(() => {
    void options.refreshSessions();
    void options.refreshSkills();
    void options.refreshManagedSkillSources();
    void options.refreshBundledSkillCatalog();
    void options.refreshScheduledTasks();
    void options.applyE2eFixture();
  });
  const handleConnectionSubscriptionEvent = useEffectEvent((event: ConnectionEvent) => {
    options.handleConnectionEvent(event);
  });
  const handleRuntimeHostChange = useEffectEvent((event: DesktopRuntimeHostProfileChangedEvent) => {
    if ((event.removed || event.readiness === 'unavailable') && event.hostId) {
      const activeSessionId = options.activeIdRef.current;
      if (activeSessionId && desktopSessionHostId(activeSessionId) === event.hostId) {
        options.setActiveId(undefined);
        options.setMessages([]);
        options.clearSessionRendererState(activeSessionId);
      }
    }
    void options.refreshSessions();
    if (event.readiness !== 'ready') return;
    if (!event.isDefault) return;
    void options.refreshProjects();
    void options.refreshConnections();
    void options.refreshMemoryActive('load');
    void options.refreshSkills();
    void options.refreshManagedSkillSources();
    void options.refreshBundledSkillCatalog();
    void options.refreshScheduledTasks();
  });
  // PR-2088: the macOS application menu routes New Task / Settings / Keyboard
  // Shortcuts here through one channel. The renderer already owns these
  // implementations; the menu is only a second entry surface. The keydown
  // path (useHotkeys below) stays active on every platform: on macOS AppKit
  // resolves the menu accelerator before the web contents sees the keydown,
  // so a real keypress dispatches exactly once, while CDP-injected test keys
  // still reach this handler for the renderer path.
  const handleWindowCommand = useEffectEvent((command: WindowCommand) => {
    if (command.id === 'newTask') void options.createSession();
    else if (command.id === 'openSettings') options.openSettings();
    else if (command.id === 'openHelp') options.openHelp();
  });
  const handleSessionChange = useEffectEvent(
    (event: SessionChangedEvent) => {
      // The authority has spoken about a specific turn — whether it started,
      // failed to start, or ended. That confirms the send's arm, and the
      // session's status becomes readable as an answer about it again.
      if (event.sessionId && event.turnId) {
        options.confirmLiveTurn(event.sessionId, event.turnId);
      }
      void options.refreshSessions();
      if (event.reason === 'created' || event.reason === 'migrated') {
        void options.refreshProjects();
      }
    if (event.sessionId) {
      options.setSessionEventHealthBySession((current) => {
        const previous = current[event.sessionId!];
        if (!previous) return current;
        return {
          ...current,
          [event.sessionId!]: recordSessionEventStreamChange(previous, event.ts),
        };
      });
    }
    if (
      event.sessionId &&
      (event.reason === 'turn-status-change' || event.reason === 'message-appended' || event.reason === 'deleted')
    ) {
      options.clearPendingTurnActionsForSession(event.sessionId);
    }
    const changedSessionId = event.sessionId;
    if (event.reason === 'message-appended' && changedSessionId && changedSessionId === options.activeIdRef.current) {
      void options.refreshMessages(changedSessionId);
    }
    if (event.reason === 'rebound') {
      const copy = getDesktopConversationCopy(options.uiLocale).actions;
      options.toastApi.info(copy.modelReboundTitle, copy.modelReboundDescription(event.modelId));
    }
    if (event.reason === 'deleted' && event.sessionId && event.sessionId === options.activeIdRef.current) {
      const deletedSessionId = event.sessionId;
      options.setActiveId(undefined);
      options.setMessages([]);
      options.clearSessionRendererState(deletedSessionId);
    }
    },
  );
  const handleScheduledTaskChange = useEffectEvent(() => {
    void options.refreshScheduledTasks();
  });
  const handleScheduledTaskDue = useEffectEvent((task: { id: string; title: string }) => {
    const copy = getShellRemainingCopy(options.uiLocale).notifications;
    void options.refreshScheduledTasks();
    options.toastApi.toast({
      title: copy.scheduledTask,
      description: task.title,
      variant: 'info',
      duration: 8000,
      action: {
        label: copy.viewScheduledTasks,
        onClick: () => options.setNavSelection({ section: 'automations', module: 'scheduled-tasks' }),
      },
    });
  });
  // Both shortcuts fire while the composer has focus — they always did, and
  // that is the point of a global new-task / settings key — so both opt out of
  // the hook's default "stay silent while typing" rule.
  //
  // The shiftKey bail keeps the original "plain N only" contract: useHotkeys
  // ignores shift state unless the combo names it, and there is no way to spell
  // "must NOT be shifted", so the entry matches ⇧⌘N and the handler declines
  // it. Net app behavior is unchanged (⇧⌘N did nothing before and does nothing
  // now); the only residual difference is that the hook has already called
  // preventDefault() by the time we decline.
  useHotkeys([
    {
      keys: 'mod+,',
      allowInInputs: true,
      onPress: () => options.openSettings(),
    },
    {
      keys: 'mod+n',
      allowInInputs: true,
      onPress: (event) => {
        if (event.shiftKey) return;
        void options.createSession();
      },
    },
  ]);
  const markRendererMounted = useEffectEvent(() => {
    options.rendererMountedRef.current = true;
  });
  const cleanupPendingRefs = useEffectEvent(() => {
    options.rendererMountedRef.current = false;
    options.projectPickerRequestRef.current += 1;
    options.projectPickerPendingRef.current = false;
    for (const timeoutHandle of options.pendingTurnActionTimersRef.current.values()) {
      clearTimeout(timeoutHandle);
    }
    options.pendingTurnActionTimersRef.current.clear();
    options.pendingTurnActionsRef.current.clear();
    options.pendingPermissionModeChangesRef.current.clear();
    options.pendingSessionModelChangesRef.current.clear();
  });

  useEffect(() => {
    // The default Host seeds sessions + connections through onboarding.
    // `refreshSessions` below expands that seed across every ready Host.
    // `refreshShellSettings` is
    // waited because it drives theme + locale before first paint settles.
    // Everything else is fire-and-forget on a rAF to keep the critical
    // render path as short as possible.
    void options.refreshShellSettings();
    // Non-critical: defer to next frame so the first paint isn't blocked.
    const startupFrame = requestAnimationFrame(runDeferredStartupRefreshes);
    const unsubscribeConnections = window.maka.connections.subscribeEvents(handleConnectionSubscriptionEvent);
    const unsubscribeRuntimeHostChanges =
      window.maka.runtimeHostProfiles.subscribeChanges(handleRuntimeHostChange);
    const refreshRuntimeHostSettingsMirrors = () => {
      void options.refreshShellSettings();
      void options.refreshConnections();
    };
    const unsubscribeSettingsExternal = window.maka.settings.subscribeExternalChanged(
      refreshRuntimeHostSettingsMirrors,
    );
    const unsubscribeClientSettings = window.maka.settings.subscribeClientChanged(
      () => void options.refreshShellSettings(),
    );
    const unsubscribeSessionChanges = window.maka.sessions.subscribeChanges(handleSessionChange);
    const unsubscribeScheduledTaskChanges = window.maka.scheduledTasks.subscribeChanges(handleScheduledTaskChange);
    const unsubscribeScheduledTaskDue = window.maka.scheduledTasks.subscribeDue(handleScheduledTaskDue);
    const unsubscribeWindowCommand = window.maka.appWindow.subscribeCommand(handleWindowCommand);
    markRendererMounted();
    return () => {
      cancelAnimationFrame(startupFrame);
      cleanupPendingRefs();
      unsubscribeConnections();
      unsubscribeRuntimeHostChanges();
      unsubscribeSettingsExternal();
      unsubscribeClientSettings();
      unsubscribeSessionChanges();
      unsubscribeScheduledTaskChanges();
      unsubscribeScheduledTaskDue();
      unsubscribeWindowCommand();
    };
  }, []);
}

function desktopSessionHostId(sessionId: string): string | undefined {
  try {
    return parseDesktopSessionKey(sessionId).hostId;
  } catch {
    return undefined;
  }
}

export function useActiveSessionEvents(options: {
  uiLocale: UiLocale;
  activeId: string | undefined;
  activeIdRef: RefBox<string | undefined>;
  handleEvent: (sessionId: string, event: SessionEvent) => void;
  markSessionReadLocally: (sessionId: string, readMessages: readonly StoredMessage[]) => void;
  beginObservationSeed?: (sessionId: string) => number;
  completeObservationSeed?: (sessionId: string, generation?: number) => void;
  setMessageLoadErrorBySession: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  setMessageLoadPending: (pending: boolean) => void;
  setMessages: (messages: StoredMessage[]) => void;
  transcriptRangeRef: RefBox<DesktopTranscriptRangeController | undefined>;
  setSessionEventHealthBySession: SessionEventHealthUpdater;
  toastApi: Pick<ToastApi, 'error'>;
}) {
  const activeId = options.activeId;
  const applyTranscript = useEffectEvent((
    sessionId: string,
    store: DesktopTranscriptRangeStore,
    isDisposed: () => boolean,
  ) => {
    if (!isDisposed() && options.activeIdRef.current === sessionId) {
      const snapshot = store.snapshot();
      const next = [...snapshot.messages];
      options.markSessionReadLocally(sessionId, next);
      options.setMessages(next);
      if (snapshot.ready) options.setMessageLoadPending(false);
    }
  });
  const applyReadError = useEffectEvent((sessionId: string, error: unknown, isDisposed: () => boolean) => {
    if (!isDisposed() && options.activeIdRef.current === sessionId) {
      const message = messageReadErrorMessage(error, options.uiLocale);
      options.setMessageLoadErrorBySession((current) => ({
        ...current,
        [sessionId]: message,
      }));
      options.setMessageLoadPending(false);
      options.toastApi.error(getDesktopConversationCopy(options.uiLocale).actions.messageReadFailedTitle, message);
    }
  });
  const handleSessionEvent = useEffectEvent((sessionId: string, event: SessionEvent) => {
    options.setSessionEventHealthBySession((current) => {
      const previous = current[sessionId];
      if (!previous) return current;
      return {
        ...current,
        [sessionId]: recordSessionEventStreamEvent(previous, Date.now()),
      };
    });
    options.handleEvent(sessionId, event);
  });
  const beginObservationSeed = useEffectEvent((sessionId: string) => {
    return options.beginObservationSeed?.(sessionId) ?? 0;
  });
  const completeObservationSeed = useEffectEvent((
    sessionId: string,
    generation?: number,
  ) => {
    options.completeObservationSeed?.(sessionId, generation);
  });
  const markSessionEventStreamClosed = useEffectEvent((sessionId: string) => {
    options.setSessionEventHealthBySession((current) => {
      const previous = current[sessionId];
      if (!previous) return current;
      return {
        ...current,
        [sessionId]: {
          ...previous,
          status: 'closed',
          checkedAt: Date.now(),
          staleSince: undefined,
        },
      };
    });
  });

  useLayoutEffect(() => {
    if (!activeId) return;
    const observationGeneration = beginObservationSeed(activeId);
    let disposed = false;
    const transcript = new DesktopTranscriptRangeStore(activeId);
    const subscribedAt = Date.now();
    options.setMessageLoadErrorBySession((current) => {
      if (!current[activeId]) return current;
      const next = { ...current };
      delete next[activeId];
      return next;
    });
    options.setSessionEventHealthBySession((current) => ({
      ...current,
      [activeId]: createSessionEventStreamSubscription({
        sessionId: activeId,
        now: subscribedAt,
      }),
    }));
    const openTranscript = (signal: AbortSignal) =>
      window.maka.transcripts.open(
        activeId,
        (batch) => {
          if (disposed) return;
          try {
            if (transcript.accept(batch)) {
              applyTranscript(activeId, transcript, () => disposed);
            }
          } catch (error) {
            applyReadError(activeId, error, () => disposed);
          }
        },
        (cancel) => {
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        },
      );
    const controller = createDesktopTranscriptRangeController(transcript, openTranscript);
    void controller.ready().catch((error) => {
      applyReadError(activeId, error, () => disposed);
    });
    options.transcriptRangeRef.current = controller;
    const unsubscribe = window.maka.sessions.subscribeEvents(
      activeId,
      (event) => {
        handleSessionEvent(activeId, event);
      },
      () => completeObservationSeed(activeId, observationGeneration),
      (phase) => {
        if (phase === 'pending') beginObservationSeed(activeId);
        else completeObservationSeed(activeId);
      },
    );
    return () => {
      disposed = true;
      if (options.transcriptRangeRef.current?.store === transcript) {
        options.transcriptRangeRef.current = undefined;
      }
      void controller.close();
      unsubscribe();
      markSessionEventStreamClosed(activeId);
    };
  }, [activeId]);
}

export function useShellRunUpdates(options: {
  activeId: string | undefined;
  setShellRunUpdatesBySession: (updater: (current: ShellRunUpdatesBySession) => ShellRunUpdatesBySession) => void;
}) {
  const applyUpdates = useEffectEvent(
    (sessionId: string, updates: Awaited<ReturnType<typeof window.maka.shellRuns.list>>) => {
    options.setShellRunUpdatesBySession((current) => {
      const active = current[sessionId];
      const retained = active ? { [sessionId]: active } : {};
      return mergeShellRunUpdates(
        retained,
        updates.filter((update) => update.sessionId === sessionId),
      );
    });
    },
  );

  useEffect(() => {
    const sessionId = options.activeId;
    options.setShellRunUpdatesBySession((current) => {
      if (!sessionId) return {};
      const active = current[sessionId];
      return active ? { [sessionId]: active } : {};
    });
    if (!sessionId) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let retryDelayMs = 250;
    const hydration = new ShellRunHydration();
    const unsubscribe = window.maka.shellRuns.subscribeUpdates((update) => {
      if (disposed) return;
      const live = hydration.accept(update);
      if (live) {
        options.setShellRunUpdatesBySession((current) =>
          mergeShellRunNotification(current, sessionId, live),
        );
      }
    });
    const hydrate = (epoch: number) => {
      void window.maka.shellRuns
        .list(sessionId)
        .then((updates) => {
          if (disposed) return;
          const buffered = hydration.commit(epoch);
          if (!buffered) return;
          applyUpdates(sessionId, updates);
          retryDelayMs = 250;
          for (const update of buffered.updates) {
            options.setShellRunUpdatesBySession((current) => mergeShellRunNotification(current, sessionId, update));
          }
          if (buffered.overflowed) hydrate(epoch);
        })
        .catch(() => {
          if (disposed || !hydration.isCurrent(epoch)) return;
          retryTimer = globalThis.setTimeout(() => {
            retryTimer = undefined;
            hydrate(epoch);
          }, retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        });
    };
    const unsubscribeResync = window.maka.shellRuns.subscribeResync((event) => {
      if (disposed || event.sessionId !== sessionId) return;
      const epoch = hydration.begin();
      retryDelayMs = 250;
      if (retryTimer !== undefined) {
        globalThis.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      hydrate(epoch);
    });
    hydrate(hydration.begin());
    return () => {
      disposed = true;
      if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer);
      unsubscribe();
      unsubscribeResync();
    };
  }, [options.activeId]);
}

export function useSessionEventHealthPolling(options: {
  activeId: string | undefined;
  activeInteraction: { requestId: string } | undefined;
  activeSession: SessionSummary | undefined;
  activeStreamingLive: boolean;
  hasInFlightLiveTools: boolean;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<SessionSummary[]>;
  sessionEventHealthBySessionRef: RefBox<Record<string, SessionEventStreamSnapshot>>;
  setSessionEventHealthBySession: SessionEventHealthUpdater;
}) {
  const {
    activeId,
    activeInteraction,
    activeSession,
    activeStreamingLive,
    hasInFlightLiveTools,
    refreshMessages,
    refreshSessions,
    sessionEventHealthBySessionRef,
    setSessionEventHealthBySession,
  } = options;

  useEffect(() => {
    if (!activeId) return;
    const hasLiveActivity = activeStreamingLive || hasInFlightLiveTools || Boolean(activeInteraction);
    const evaluate = () => {
      const result = evaluateSessionEventStreamSnapshot({
        previous: sessionEventHealthBySessionRef.current[activeId],
        now: Date.now(),
        sessionStatus: activeSession?.status,
        hasLiveActivity,
      });
      if (!result.snapshot) return;
      setSessionEventHealthBySession((current) => ({
        ...current,
        [activeId]: result.snapshot!,
      }));
      if (result.shouldRefresh) {
        void refreshSessions();
        void refreshMessages(activeId);
      }
    };
    // #1979: a stream nobody expects has nothing to observe — `evaluate` can only
    // derive `closed` and can never ask for a refresh, and no one renders either
    // field. So an idle session gets no probe at all, not merely a cheaper one.
    // Both inputs to `expected` are deps of this effect, so a session that starts
    // running re-arms on its own; `markSessionEventStreamClosed` still records the
    // closed stream when the subscription itself goes away.
    if (!sessionExpectsEventStream(activeSession?.status, hasLiveActivity)) return;
    evaluate();
    const interval = window.setInterval(evaluate, 5_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') evaluate();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeId, activeSession?.status, activeStreamingLive, hasInFlightLiveTools, activeInteraction?.requestId]);
}
