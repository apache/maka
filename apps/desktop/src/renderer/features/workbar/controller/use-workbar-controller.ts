/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import type { ClientCapabilityResponse } from '@maka/core/client-capability-grant';
import type { QuoteRef } from '@maka/core/events';
import type { InteractionFormResponse } from '@maka/core/interaction';
import type { SessionSummary } from '@maka/core/session';
import type { WorkBoardItem, WorkBoardLinkedSession } from '@maka/core/work-board';
import { useUiLocale, type ComposerHandle, type ToastApi } from '@maka/ui';
import type { ChatModelChoice } from '@maka/ui';
import { safeLocalStorageGet, safeLocalStorageSet } from '../../../browser-storage.js';
import { getDesktopConversationCopy } from '../../../locales/conversation-copy.js';
import { getShellCopy, localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import { sideChatTitleFromPrompt } from '../../../side-chat-command.js';
import { desktopSessionKey, parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';
import { useWorkbarServices } from '../services-context.js';
import type { WorkbarHostModel } from '../ui/workbar-host.js';
import { SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY } from '../ui/side-chat-close-confirmation.js';
import {
  findPreferredSideChatWorkbarTab,
  terminalRefFromWorkbarTab,
  terminalSessionWorkbarTabId,
  type SessionWorkbarPlacement,
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
} from '../model/workbar-tabs.js';
import { workbarToolDefinition } from '../model/workbar-tool-definitions.js';
import {
  consumeCompanionInitialPrompt,
  consumeCompanionQuoteSnapshot,
  openCompanionPanel,
  removeStagedCompanionQuote,
  stageCompanionQuote,
} from '../tools/side-chat/quote-companion-panel-state.js';
import {
  applyCompanionForkVisibilityEvent,
} from '../tools/side-chat/quote-companion-visibility.js';
import { recoverOrphanedCompanionCopies } from '../tools/side-chat/quote-companion-core.js';
import { useSideConversationWorkspace } from '../tools/side-chat/use-side-conversation-workspace.js';
import { useWorkbarLayoutState } from './use-workbar-layout-state.js';
import { LiveContextUsageProbe } from '../tools/inspector/live-context-usage-probe.js';

interface OpenToolOptions {
  initialPrompt?: string;
}

export interface WorkbarControllerCommands {
  openTool(
    kind: SessionWorkbarTabKind,
    placement?: SessionWorkbarPlacement,
    options?: OpenToolOptions,
  ): void;
  openSideChatWithQuote(quote: QuoteRef): void;
  respondToClientCapability(response: ClientCapabilityResponse): Promise<void>;
  respondToUserForm(sessionId: string, response: InteractionFormResponse): Promise<void>;
  toggleRight(): void;
  /**
   * Accepts the Session produced by a projected first send that belongs to the
   * pending Work Board start claim. The claim is owned by one specific
   * new-task surface instance (its owner token), so a first send from any
   * other surface—even one reopened on the same Host/project—must not consume
   * it.
   */
  bindNewTaskSessionResolver(
    surfaceOwnerToken: number,
  ): (sessionId: string, draftKey?: string) => void;
}

export interface WorkbarControllerSelectors {
  rightCollapsed: boolean;
  hiddenSessionIds: ReadonlySet<string>;
}

export interface UseWorkbarControllerInput {
  /** Whether the Session workspace (rather than a module page) owns the shell. */
  available: boolean;
  /** Local selection owns layout even while Host creation is pending. */
  layoutSessionId: string | undefined;
  /** Independent persistent renderers must not overwrite each other’s panel topology. */
  layoutScope?: string;
  activeSession: SessionSummary | undefined;
  projectId: string | null | undefined;
  projectAliases: readonly string[];
  authoritativeSessionIds: ReadonlySet<string> | undefined;
  shellObscured: boolean;
  modelChoices: readonly ChatModelChoice[];
  /** Toast surface owned by the shell composition zone. */
  toastApi: ToastApi;
  composerRef?: { current: Pick<ComposerHandle, 'focus' | 'setDraft'> | null };
  openNewTaskSurface?(): number;
  openSessionInChat?(sessionId: string): void;
  resolveWorkBoardTarget?(item: WorkBoardItem):
    | { ok: true; target: { profileId: string; hostId: string; projectId: string } }
    | { ok: false; message: string };
  prepareWorkBoardDraft?(target: { profileId: string; hostId: string; projectId: string }, draft: string): string | undefined;
}

export interface WorkbarController {
  host: WorkbarHostModel;
  commands: WorkbarControllerCommands;
  selectors: WorkbarControllerSelectors;
  /**
   * The composer context gauge's live overlay (#4717), handed to the shell on
   * the controller so the shell gains no import edge to the inspector's
   * subscription: the app shell is a debt-ratcheted legacy file, and every
   * named import it adds is new debt the ratchet forbids. The probe's readers
   * stay inside this feature; the shell only forwards the reference.
   */
  readonly LiveContextUsageProbe: typeof LiveContextUsageProbe;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Workbar tool: ${JSON.stringify(value)}`);
}

function nextOrdinal(
  tabs: readonly SessionWorkbarTab[],
  kind: 'side-chat' | 'terminal',
): number {
  return (
    tabs.reduce(
      (highest, tab, index) =>
        tab.kind === kind
          ? Math.max(highest, tab.ordinal ?? index + 1)
          : highest,
      0,
    ) + 1
  );
}

export function useWorkbarController(
  input: UseWorkbarControllerInput,
): WorkbarController {
  const locale = useUiLocale();
  // Enforce development-only: the experimental Start-task path must never be
  // reachable in a production build even if the flag is set, so the gate
  // requires `DEV` as well as the feature flag.
  const viteEnv = (
    import.meta as unknown as {
      env?: Record<string, string | boolean | undefined>;
    }
  ).env;
  const workBoardStartTaskEnabled =
    viteEnv?.DEV === true &&
    viteEnv?.VITE_MAKA_WORK_BOARD_START_TASK === '1' &&
    Boolean(input.openNewTaskSurface && input.resolveWorkBoardTarget && input.prepareWorkBoardDraft);
  const terminalCopy = getDesktopConversationCopy(locale).terminalPanel;
  const { browser, sideChat, terminal, workBoard } = useWorkbarServices();
  const activeSessionId = input.activeSession?.id;
  const layout = useWorkbarLayoutState(input.layoutSessionId, input.authoritativeSessionIds, input.layoutScope);
  const sideConversations = useSideConversationWorkspace();
  const [pendingSideChatClose, setPendingSideChatClose] = useState<
    Array<{ placement: SessionWorkbarPlacement; tab: SessionWorkbarTab }>
  >([]);
  const [skipSideChatCloseConfirmation, setSkipSideChatCloseConfirmation] =
    useState(
      () =>
        safeLocalStorageGet(SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY) === 'true',
    );
  const [hiddenCompanionForkIds, setHiddenCompanionForkIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const activeSessionIdRef = useRef<string | undefined>(undefined);
  /**
   * The in-flight Work Board start claim. The surface token and target-scoped
   * draft key jointly own it; `sessionId` is filled once the first send from
   * that owner is projected, and is retained across a failed link so a retry
   * can reuse the same Session instead of creating a duplicate.
   */
  const pendingWorkBoardStartRef = useRef<{
    itemId: string;
    target: { profileId: string; hostId: string; projectId: string };
    surfaceOwnerToken: number;
    draftKey: string;
    sessionId?: string;
  } | undefined>(undefined);
  const resourceGenerationRef = useRef(0);
  useLayoutEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    return () => {
      activeSessionIdRef.current = undefined;
    };
  }, [activeSessionId]);
  useLayoutEffect(() => {
    resourceGenerationRef.current += 1;
    return () => { resourceGenerationRef.current += 1; };
  }, []);

  const linkPendingWorkBoardSession = useCallback(
    (pending: NonNullable<typeof pendingWorkBoardStartRef.current>): Promise<boolean> => {
      if (!workBoard) {
        input.toastApi.error(
          getDesktopConversationCopy(locale).workBoardPanel.actionFailed,
          'Work Board linking is unavailable in this desktop session.',
        );
        return Promise.resolve(false);
      }
      if (pending.sessionId === undefined) return Promise.resolve(false);
      return workBoard
        .linkSession(pending.itemId, {
          profileId: pending.target.profileId,
          hostId: pending.target.hostId,
          sessionId: pending.sessionId,
          linkedAt: Date.now(),
        })
        .then((result) => {
          if (result.ok) return true;
          input.toastApi.error(
            getDesktopConversationCopy(locale).workBoardPanel.actionFailed,
            result.message,
          );
          return false;
        })
        .catch((error) => {
          input.toastApi.error(
            getDesktopConversationCopy(locale).workBoardPanel.actionFailed,
            error instanceof Error ? error.message : String(error),
          );
          return false;
        });
    },
    [input, locale, workBoard],
  );

  /**
   * Link the claim's Session and only drop the claim once the link succeeds.
   * On failure the claim (with its `sessionId`) is retained so the next Start
   * task invocation retries the same Session rather than creating a new one.
   */
  const settlePendingWorkBoardLink = useCallback(
    (pending: NonNullable<typeof pendingWorkBoardStartRef.current>): void => {
      void linkPendingWorkBoardSession(pending).then((ok) => {
        if (ok && pendingWorkBoardStartRef.current === pending) {
          pendingWorkBoardStartRef.current = undefined;
        }
      });
    },
    [linkPendingWorkBoardSession],
  );

  const startWorkBoardTask = useCallback(
    (item: WorkBoardItem) => {
      const result = input.resolveWorkBoardTarget?.(item);
      if (!result) {
        input.toastApi.info(
          getDesktopConversationCopy(locale).workBoardPanel.actionFailed,
          'Work Board task start is unavailable.',
        );
        return;
      }
      if (!result.ok) {
        input.toastApi.info(getDesktopConversationCopy(locale).workBoardPanel.actionFailed, result.message);
        return;
      }
      const pending = pendingWorkBoardStartRef.current;
      if (pending) {
        if (pending.itemId === item.id && pending.sessionId !== undefined) {
          if (
            pending.target.profileId === result.target.profileId &&
            pending.target.hostId === result.target.hostId &&
            pending.target.projectId === result.target.projectId
          ) {
            // A previous link attempt failed for this same item and target:
            // retry the already-created Session rather than create a duplicate.
            settlePendingWorkBoardLink(pending);
            return;
          }
        }
        // A claim without a Session was abandoned, or the item moved to a new
        // target after link failure. A fresh start replaces either claim.
        pendingWorkBoardStartRef.current = undefined;
      }
      const draft = [item.title, item.notes?.trim()].filter(Boolean).join('\n\n');
      const draftKey = input.prepareWorkBoardDraft?.(result.target, draft);
      if (!draftKey) {
        input.toastApi.info(
          getDesktopConversationCopy(locale).workBoardPanel.actionFailed,
          'Work Board task start is unavailable.',
        );
        return;
      }
      const surfaceOwnerToken = input.openNewTaskSurface?.();
      if (surfaceOwnerToken === undefined) {
        input.toastApi.info(
          getDesktopConversationCopy(locale).workBoardPanel.actionFailed,
          'Work Board task start is unavailable.',
        );
        return;
      }
      pendingWorkBoardStartRef.current = {
        itemId: item.id,
        target: result.target,
        surfaceOwnerToken,
        draftKey,
      };
      globalThis.requestAnimationFrame(() => {
        input.composerRef?.current?.setDraft(draftKey, draft);
        input.composerRef?.current?.focus();
      });
    },
    [input, locale, settlePendingWorkBoardLink],
  );

  const openWorkBoardSession = useCallback(
    (link: WorkBoardLinkedSession) => {
      input.openSessionInChat?.(
        desktopSessionKey({ hostId: link.hostId, sessionId: link.sessionId }),
      );
    },
    [input.openSessionInChat],
  );

  const onNewTaskSessionResolved = useCallback(
    (sessionId: string, surfaceOwnerToken: number, draftKey: string | undefined) => {
      const pending = pendingWorkBoardStartRef.current;
      if (!pending) return;
      // An older surface can resolve after a later Start has installed a new
      // claim. Its callback is stale and must not mutate that newer claim.
      if (surfaceOwnerToken < pending.surfaceOwnerToken) return;
      // A newer surface abandons the old claim; a Workspace Picker change on
      // the owning surface does the same. Neither may attach its Session.
      if (surfaceOwnerToken !== pending.surfaceOwnerToken || draftKey !== pending.draftKey) {
        pendingWorkBoardStartRef.current = undefined;
        return;
      }
      const linkedSessionId = (() => {
        try {
          return parseDesktopSessionKey(sessionId).sessionId;
        } catch {
          return sessionId;
        }
      })();
      if (pending.sessionId === undefined) {
        pending.sessionId = linkedSessionId;
      }
      settlePendingWorkBoardLink(pending);
    },
    [settlePendingWorkBoardLink],
  );
  const bindNewTaskSessionResolver = useCallback(
    (surfaceOwnerToken: number) =>
      (sessionId: string, draftKey?: string) =>
        onNewTaskSessionResolved(sessionId, surfaceOwnerToken, draftKey),
    [onNewTaskSessionResolved],
  );
  const respondToClientCapability = useCallback<
    WorkbarControllerCommands['respondToClientCapability']
  >(
    async (response) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      try {
        await sideChat.respondToClientCapability(sessionId, response);
      } catch (error) {
        if (activeSessionIdRef.current !== sessionId) return;
        const copy = getShellCopy(locale).chatActions;
        input.toastApi.error(
          copy.responseFailedTitle,
          localizedShellErrorMessage(error, copy.responseFailedFallback, locale),
          undefined,
          { sessionId },
        );
      }
    },
    [input, locale, sideChat],
  );
  const panelsStateRef = useRef(layout.workbarPanelsState);
  useLayoutEffect(() => {
    panelsStateRef.current = layout.workbarPanelsState;
  }, [layout.workbarPanelsState]);
  const reservedOrdinalsRef = useRef({
    'side-chat': new Set<number>(),
    terminal: new Set<number>(),
  });
  useLayoutEffect(() => {
    reservedOrdinalsRef.current['side-chat'].clear();
    reservedOrdinalsRef.current.terminal.clear();
  }, [layout.workbarPanelsState]);
  const terminalReadGenerationRef = useRef(0);
  useEffect(() => terminal.subscribeCloseChanges((change) => {
    if (change.sessionId === activeSessionIdRef.current) terminalReadGenerationRef.current += 1;
    if (change.status !== 'closed') return;
    layout.closeTerminal(change.sessionId, change.ref);
  }), [terminal, layout.closeTerminal]);

  const reserveOrdinal = useCallback(
    (kind: 'side-chat' | 'terminal'): number => {
      const tabs = [
        ...panelsStateRef.current.right.tabs,
        ...panelsStateRef.current.bottom.tabs,
      ];
      const reserved = reservedOrdinalsRef.current[kind];
      const highestReserved = [...reserved].reduce(
        (highest, ordinal) => Math.max(highest, ordinal),
        0,
      );
      const ordinal = Math.max(nextOrdinal(tabs, kind), highestReserved + 1);
      reserved.add(ordinal);
      return ordinal;
    },
    [],
  );

  useEffect(() => {
    if (!activeSessionId) return;
    let disposed = false;
    let reading = false;
    let refreshAgain = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (disposed) return;
      if (reading) { refreshAgain = true; return; }
      clearTimeout(retry);
      reading = true;
      const generation = ++terminalReadGenerationRef.current;
      void terminal.recover(activeSessionId).then(({ resources, closes }) => {
        if (disposed) return;
        if (generation !== terminalReadGenerationRef.current) {
          refreshAgain = true;
          return;
        }
        failures = 0;
        const refs = new Set([...resources.map((update) => update.result.ref), ...closes.map((close) => close.ref)]);
        layout.restoreTerminals([...refs].map((ref) => ({
          id: terminalSessionWorkbarTabId(ref),
          kind: 'terminal',
          resourceRef: ref,
          ownerSessionId: activeSessionId,
        })));
      }).catch(() => {
        if (!disposed) retry = setTimeout(refresh, Math.min(100 * 2 ** Math.min(failures++, 5), 2_000));
      }).finally(() => {
        reading = false;
        if (refreshAgain) { refreshAgain = false; refresh(); }
      });
    };
    const unsubscribeResync = terminal.subscribeResync((event) => {
      if (event.sessionId === activeSessionId) { terminalReadGenerationRef.current += 1; refresh(); }
    });
    const unsubscribeUpdates = terminal.subscribeUpdates((update) => {
      if (update.sessionId !== activeSessionId) return;
      const panels = panelsStateRef.current;
      if (![...panels.right.tabs, ...panels.bottom.tabs].some((tab) => tab.resourceRef === update.result.ref)) refresh();
    });
    refresh();
    return () => { disposed = true; clearTimeout(retry); unsubscribeResync(); unsubscribeUpdates(); };
  }, [activeSessionId, terminal, layout.restoreTerminals]);

  const revealPlacement = useCallback(
    (placement: SessionWorkbarPlacement) => {
      if (placement === 'right') layout.setWorkbarCollapsed(false);
      else layout.setBottomPanelOpen(true);
    },
    [layout.setBottomPanelOpen, layout.setWorkbarCollapsed],
  );

  const openNewSideConversation = useCallback(
    (placement: SessionWorkbarPlacement, initialPrompt?: string) => {
      const sourceSessionId = activeSessionIdRef.current;
      if (!sourceSessionId) return;
      const panel = openCompanionPanel(null, {
        sourceSessionId,
        initialPrompt,
        newId: () => crypto.randomUUID(),
      });
      sideConversations.upsertPanel(panel);
      layout.openDynamicWorkbarTab(
        {
          id: `side-chat:${panel.id}`,
          kind: 'side-chat',
          title: sideChatTitleFromPrompt(initialPrompt ?? ''),
          ordinal: reserveOrdinal('side-chat'),
        },
        placement,
      );
      revealPlacement(placement);
    },
    [
      layout.openDynamicWorkbarTab,
      reserveOrdinal,
      revealPlacement,
      sideConversations,
    ],
  );

  const openTool = useCallback<WorkbarControllerCommands['openTool']>(
    (kind, placement, options = {}) => {
      const definition = workbarToolDefinition(kind);
      const targetPlacement = placement ?? definition.defaultPlacement;
      if (definition.singleton) {
        layout.openWorkbarTab(definition.kind, targetPlacement);
        revealPlacement(targetPlacement);
        return;
      }
      switch (definition.kind) {
        case 'side-chat':
          openNewSideConversation(targetPlacement, options.initialPrompt);
          return;
        case 'terminal': {
          const ownerSessionId = activeSessionIdRef.current;
          if (!ownerSessionId) return;
          const generation = resourceGenerationRef.current;
          void terminal
            .start(ownerSessionId)
            .then((update) => {
              const ref = update.result.ref;
              if (
                generation !== resourceGenerationRef.current
              ) {
                return;
              }
              layout.openDynamicWorkbarTab(
                {
                  id: terminalSessionWorkbarTabId(ref),
                  kind: 'terminal',
                  ordinal: reserveOrdinal('terminal'),
                  resourceRef: ref,
                  ownerSessionId,
                },
                targetPlacement,
              );
              if (activeSessionIdRef.current === ownerSessionId) revealPlacement(targetPlacement);
            })
            .catch((error) => {
              if (
                generation !== resourceGenerationRef.current ||
                activeSessionIdRef.current !== ownerSessionId
              ) {
                return;
              }
              input.toastApi.error(
                terminalCopy.startFailed,
                localizedShellErrorMessage(
                  error,
                  terminalCopy.startFailed,
                  locale,
                ),
                undefined,
                { sessionId: ownerSessionId },
              );
            });
          return;
        }
        default:
          return assertNever(definition);
      }
    },
    [
      layout.openDynamicWorkbarTab,
      layout.openWorkbarTab,
      input,
      locale,
      openNewSideConversation,
      reserveOrdinal,
      revealPlacement,
      terminal,
      terminalCopy.startFailed,
    ],
  );

  const openSideChatWithQuote = useCallback(
    (quote: QuoteRef) => {
      const sourceSessionId = activeSessionIdRef.current;
      if (!sourceSessionId) return;
      const activeSideChat = findPreferredSideChatWorkbarTab(
        panelsStateRef.current,
      );
      const activeTab = activeSideChat?.tab;
      const activePanelId = activeTab?.id.slice('side-chat:'.length);
      const activePanel = sideConversations.panels.find(
        (panel) =>
          panel.id === activePanelId &&
          panel.sourceSessionId === sourceSessionId,
      );
      const panel = stageCompanionQuote(activePanel ?? null, {
        sourceSessionId,
        quote,
        newId: () => crypto.randomUUID(),
      });
      sideConversations.upsertPanel(panel);
      const placement = activeSideChat?.placement ?? 'right';
      layout.openDynamicWorkbarTab(
        {
          id: `side-chat:${panel.id}`,
          kind: 'side-chat',
          ordinal:
            activeTab?.ordinal ?? reserveOrdinal('side-chat'),
        },
        placement,
      );
      revealPlacement(placement);
    },
    [
      layout.openDynamicWorkbarTab,
      reserveOrdinal,
      revealPlacement,
      sideConversations,
    ],
  );

  const closeTabsWithoutConfirmation = useCallback(
    (
      placement: SessionWorkbarPlacement,
      tabs: readonly SessionWorkbarTab[],
      options?: { preserveVisibility?: boolean },
    ) => {
      if (tabs.length === 0) return;
      const immediateTabs: SessionWorkbarTab[] = [];
      for (const tab of tabs) {
        const ref = terminalRefFromWorkbarTab(tab);
        if (!ref || !tab.ownerSessionId) {
          immediateTabs.push(tab);
          continue;
        }
        const ownerSessionId = tab.ownerSessionId;
        const generation = resourceGenerationRef.current;
        void terminal.stop({ sessionId: ownerSessionId, ref }).catch((error) => {
          if (generation !== resourceGenerationRef.current) return;
          input.toastApi.error(
            terminalCopy.stopFailed,
            localizedShellErrorMessage(error, terminalCopy.stopFailed, locale),
            undefined,
            { sessionId: ownerSessionId },
          );
        });
      }
      layout.closeWorkbarTabs(
        placement,
        immediateTabs.map((tab) => tab.id),
        options,
      );
      const panelIds = new Set(
        tabs
          .filter((tab) => tab.kind === 'side-chat')
          .map((tab) => tab.id.slice('side-chat:'.length)),
      );
      if (panelIds.size > 0) sideConversations.removePanels(panelIds);
    },
    [layout.closeWorkbarTabs, sideConversations, terminal, input.toastApi, terminalCopy.stopFailed, locale],
  );

  const closeTabs = useCallback(
    (
      placement: SessionWorkbarPlacement,
      tabs: readonly SessionWorkbarTab[],
    ) => {
      if (tabs.length === 0) return;
      const needsConfirmation =
        !skipSideChatCloseConfirmation &&
        tabs.some(
          (tab) =>
            tab.kind === 'side-chat' &&
            sideConversations.contentPanelIds.has(
              tab.id.slice('side-chat:'.length),
            ),
        );
      if (needsConfirmation) {
        setPendingSideChatClose(
          tabs.map((tab) => ({ placement, tab })),
        );
        return;
      }
      closeTabsWithoutConfirmation(placement, tabs);
    },
    [
      closeTabsWithoutConfirmation,
      sideConversations.contentPanelIds,
      skipSideChatCloseConfirmation,
    ],
  );

  const closeTab = useCallback(
    (placement: SessionWorkbarPlacement, tab: SessionWorkbarTab) =>
      closeTabs(placement, [tab]),
    [closeTabs],
  );

  const toggleRight = useCallback(() => {
    if (layout.workbarCollapsed) {
      layout.setWorkbarCollapsed(false);
      const activeTabId = panelsStateRef.current.right.activeTabId;
      if (activeTabId) layout.activateWorkbarTab('right', activeTabId);
      return;
    }
    layout.setWorkbarCollapsed(true);
  }, [
    layout.activateWorkbarTab,
    layout.setWorkbarCollapsed,
    layout.workbarCollapsed,
  ]);

  useLayoutEffect(() => {
    setPendingSideChatClose([]);
  }, [activeSessionId]);

  useLayoutEffect(() => {
    const stalePanels = sideConversations.panels.filter(
      (panel) => panel.sourceSessionId !== activeSessionId,
    );
    if (stalePanels.length === 0) return;
    const staleIds = new Set(stalePanels.map((panel) => panel.id));
    for (const panel of stalePanels) {
      const tabId = `side-chat:${panel.id}`;
      const placement = layout.workbarPanelsState.right.tabs.some(
        (tab) => tab.id === tabId,
      )
        ? 'right'
        : 'bottom';
      layout.closeWorkbarTabs(placement, [tabId], {
        preserveVisibility: true,
      });
    }
    sideConversations.removePanels(staleIds);
  }, [
    activeSessionId,
    layout.closeWorkbarTabs,
    layout.workbarPanelsState,
    sideConversations.panels,
    sideConversations.removePanels,
  ]);

  const companionRecoveryStartedRef = useRef(false);
  useLayoutEffect(() => {
    if (companionRecoveryStartedRef.current) return;
    companionRecoveryStartedRef.current = true;
    void recoverOrphanedCompanionCopies(sideChat);
  }, [sideChat]);

  const onForkVisibilityChange = useCallback(
    (event: Parameters<typeof applyCompanionForkVisibilityEvent>[1]) =>
      setHiddenCompanionForkIds((current) =>
        applyCompanionForkVisibilityEvent(current, event),
      ),
    [],
  );

  useEffect(() => {
    browser.setActiveSession(activeSessionId ?? null);
  }, [activeSessionId, browser]);

  const liveBrowserSessionIdsRef = useRef(new Set<string>());
  useEffect(
    () =>
      browser.subscribeState(({ sessionId, state }) => {
        const wasLive = liveBrowserSessionIdsRef.current.has(sessionId);
        if (!state.hasPage) {
          liveBrowserSessionIdsRef.current.delete(sessionId);
          return;
        }
        if (wasLive) return;
        liveBrowserSessionIdsRef.current.add(sessionId);
        if (sessionId === activeSessionIdRef.current) openTool('browser');
      }),
    [browser, openTool],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!input.available || input.shellObscured || !activeSessionId) return;
      const primary = navigator.platform.toLowerCase().includes('mac')
        ? event.metaKey
        : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && !event.altKey && key === 'g') {
        event.preventDefault();
        openTool('review');
      } else if (
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (key === '`' || event.code === 'Backquote')
      ) {
        event.preventDefault();
        openTool('terminal');
      } else if (primary && !event.altKey && !event.shiftKey && key === 't') {
        event.preventDefault();
        openTool('browser');
      } else if (primary && !event.altKey && !event.shiftKey && key === 'p') {
        event.preventDefault();
        openTool('files');
      } else if (primary && event.altKey && !event.shiftKey && key === 's') {
        event.preventDefault();
        openTool('side-chat');
      }
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [activeSessionId, input.available, input.shellObscured, openTool]);

  const confirmPendingClose = useCallback(
    (skipFutureConfirmations: boolean) => {
      if (pendingSideChatClose.length === 0) return;
      if (skipFutureConfirmations) {
        setSkipSideChatCloseConfirmation(true);
        safeLocalStorageSet(SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY, 'true');
      }
      const pending = pendingSideChatClose;
      setPendingSideChatClose([]);
      for (const placement of ['right', 'bottom'] as const) {
        closeTabsWithoutConfirmation(
          placement,
          pending
            .filter((candidate) => candidate.placement === placement)
            .map((candidate) => candidate.tab),
        );
      }
    },
    [closeTabsWithoutConfirmation, pendingSideChatClose],
  );

  const commands = useMemo<WorkbarControllerCommands>(
    () => ({
      openTool,
      openSideChatWithQuote,
      respondToClientCapability,
      respondToUserForm: sideChat.respondToUserForm,
      toggleRight,
      bindNewTaskSessionResolver,
    }),
    [
      bindNewTaskSessionResolver,
      openSideChatWithQuote,
      openTool,
      respondToClientCapability,
      sideChat.respondToUserForm,
      toggleRight,
    ],
  );

  return {
    commands,
    LiveContextUsageProbe,
    selectors: {
      rightCollapsed: layout.workbarCollapsed,
      hiddenSessionIds: hiddenCompanionForkIds,
    },
    host: {
      activeId: input.available ? activeSessionId : undefined,
      projectId: input.projectId,
      projectAliases: input.projectAliases,
      rightCollapsed: layout.workbarCollapsed,
      bottomOpen: layout.bottomPanelOpen,
      hidden: input.shellObscured,
      rightWidth: layout.workbarWidth,
      bottomHeight: layout.bottomPanelHeight,
      panelsState: layout.workbarPanelsState,
      onActivateTab: layout.activateWorkbarTab,
      onCloseTab: closeTab,
      onCloseTabs: closeTabs,
      onOpenLauncher: (placement) => {
        layout.openWorkbarLauncher(placement);
        revealPlacement(placement);
      },
      onRequestOpenTab: (placement, kind) => openTool(kind, placement),
      onDismissPanel: (placement) => {
        if (placement === 'right') layout.setWorkbarCollapsed(true);
        else layout.setBottomPanelOpen(false);
      },
      rightResizable: layout.workbarResizable,
      bottomResizable: layout.bottomPanelResizable,
      quotes: sideConversations.panels.filter(
        (panel) => panel.sourceSessionId === activeSessionId,
      ),
      onQuotesConsumed: (snapshot) =>
        sideConversations.updatePanel(snapshot.panelId, (panel) =>
          consumeCompanionQuoteSnapshot(panel, snapshot) ?? panel,
        ),
      onRemoveQuote: (target) =>
        sideConversations.updatePanel(target.panelId, (panel) =>
          removeStagedCompanionQuote(panel, target) ?? panel,
        ),
      onForkVisibilityChange,
      onContentStateChange: sideConversations.setContent,
      activeSideChatPanelIds: sideConversations.activePanelIds,
      onInitialPromptStarted: (panelId) =>
        sideConversations.updatePanel(panelId, (panel) =>
          consumeCompanionInitialPrompt(panel, panelId) ?? panel,
        ),
      onPromptAccepted: (panelId, prompt) => {
        const title = sideChatTitleFromPrompt(prompt);
        if (title) layout.titleWorkbarTab(`side-chat:${panelId}`, title);
      },
      onActivityStateChange: sideConversations.setActive,
      sourceSession: input.activeSession,
      modelChoices: input.modelChoices,
      onStartWorkBoardTask: startWorkBoardTask,
      resolveWorkBoardStartTask: input.resolveWorkBoardTarget,
      onOpenWorkBoardSession: openWorkBoardSession,
      workBoardStartTaskEnabled,
      closeConfirmation: {
        key:
          pendingSideChatClose.map(({ tab }) => tab.id).join(':') || 'closed',
        open: pendingSideChatClose.length > 0,
        sideChatCount: pendingSideChatClose.filter(
          ({ tab }) => tab.kind === 'side-chat',
        ).length,
        onCancel: () => setPendingSideChatClose([]),
        onConfirm: confirmPendingClose,
      },
    },
  };
}
