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
import type { SessionSummary } from '@maka/core/session';
import { Composer, useUiLocale } from '@maka/ui';
import type { ChatModelChoice } from '@maka/ui';
import { safeLocalStorageGet, safeLocalStorageSet } from '../../../browser-storage.js';
import { getDesktopConversationCopy } from '../../../locales/conversation-copy.js';
import { getShellCopy, localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import { sideChatTitleFromPrompt } from '../../../side-chat-command.js';
import { useWorkbarServices } from '../services-context.js';
import type { WorkbarHostModel } from '../ui/workbar-host.js';
import { SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY } from '../ui/side-chat-close-confirmation.js';
import {
  findPreferredSideChatWorkbarTab,
  reduceWorkbarPanels,
  terminalRefFromWorkbarTab,
  terminalSessionWorkbarTabId,
  type SessionWorkbarPlacement,
  type SessionWorkbarPanelsState,
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
  reconcileCompanionForkVisibility,
} from '../tools/side-chat/quote-companion-visibility.js';
import { recoverOrphanedCompanionCopies } from '../tools/side-chat/quote-companion-core.js';
import { useSideConversationWorkspace } from '../tools/side-chat/use-side-conversation-workspace.js';
import { useWorkbarLayoutState } from './use-workbar-layout-state.js';

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
  toggleRight(): void;
}

export interface WorkbarControllerSelectors {
  rightCollapsed: boolean;
  hiddenSessionIds: ReadonlySet<string>;
}

export interface UseWorkbarControllerInput {
  /** Whether the Session workspace (rather than a module page) owns the shell. */
  available: boolean;
  activeSession: SessionSummary | undefined;
  projectId: string | null | undefined;
  projectAliases: readonly string[];
  authoritativeSessionIds: ReadonlySet<string> | undefined;
  shellObscured: boolean;
  modelChoices: readonly ChatModelChoice[];
  reportError(title: string, description: string, sessionId: string): void;
}

export interface WorkbarController {
  host: WorkbarHostModel;
  commands: WorkbarControllerCommands;
  selectors: WorkbarControllerSelectors;
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

function terminalResourceKey(sessionId: string, ref: string): string {
  return `${sessionId}\u0000${ref}`;
}

function projectWorkbarPanelsForSession(
  panels: SessionWorkbarPanelsState,
  activeSessionId: string | undefined,
  activeSideChatTabIds: ReadonlySet<string>,
): SessionWorkbarPanelsState {
  let projected = panels;
  for (const placement of ['right', 'bottom'] as const) {
    const staleTabIds = projected[placement].tabs
      .filter(
        (tab) =>
          (tab.kind === 'terminal' &&
            tab.ownerSessionId !== activeSessionId) ||
          (tab.kind === 'side-chat' && !activeSideChatTabIds.has(tab.id)),
      )
      .map((tab) => tab.id);
    if (staleTabIds.length > 0) {
      projected = reduceWorkbarPanels(projected, {
        type: 'close',
        placement,
        tabIds: staleTabIds,
      });
    }
  }
  return projected;
}

export function useWorkbarController(
  input: UseWorkbarControllerInput,
): WorkbarController {
  const locale = useUiLocale();
  const terminalCopy = getDesktopConversationCopy(locale).terminalPanel;
  const { browser, sideChat, terminal } = useWorkbarServices();
  const layout = useWorkbarLayoutState();
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
  const [, setLiveBrowserSessionIds] = useState<readonly string[]>([]);

  const activeSessionId = input.activeSession?.id;
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const resourceGenerationRef = useRef(0);
  useLayoutEffect(() => {
    resourceGenerationRef.current += 1;
    activeSessionIdRef.current = activeSessionId;
    return () => {
      resourceGenerationRef.current += 1;
      activeSessionIdRef.current = undefined;
    };
  }, [activeSessionId]);
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
        input.reportError(
          copy.responseFailedTitle,
          localizedShellErrorMessage(error, copy.responseFailedFallback, locale),
          sessionId,
        );
      }
    },
    [input.reportError, locale, sideChat],
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
  const stoppingTerminalKeysRef = useRef(new Set<string>());
  const stoppedTerminalKeysRef = useRef(new Set<string>());
  const ownedTerminalResourcesRef = useRef(
    new Map<string, { sessionId: string; ref: string }>(),
  );

  const stopTerminal = useCallback(
    (sessionId: string, ref: string) => {
      const key = terminalResourceKey(sessionId, ref);
      if (
        stoppingTerminalKeysRef.current.has(key) ||
        stoppedTerminalKeysRef.current.has(key)
      ) {
        return;
      }
      stoppingTerminalKeysRef.current.add(key);
      void terminal
        .stop({ sessionId, ref })
        .then(() => {
          stoppedTerminalKeysRef.current.add(key);
          ownedTerminalResourcesRef.current.delete(key);
        })
        .catch(() => undefined)
        .finally(() => {
          stoppingTerminalKeysRef.current.delete(key);
        });
    },
    [terminal],
  );

  const registerTerminal = useCallback((sessionId: string, ref: string) => {
    const key = terminalResourceKey(sessionId, ref);
    stoppedTerminalKeysRef.current.delete(key);
    ownedTerminalResourcesRef.current.set(key, { sessionId, ref });
  }, []);

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

  useEffect(
    () => () => {
      for (const resource of ownedTerminalResourcesRef.current.values()) {
        stopTerminal(resource.sessionId, resource.ref);
      }
    },
    [stopTerminal],
  );

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
      sideConversations.upsertPanel(panel, true);
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
              registerTerminal(ownerSessionId, ref);
              if (
                generation !== resourceGenerationRef.current ||
                activeSessionIdRef.current !== ownerSessionId
              ) {
                stopTerminal(ownerSessionId, ref);
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
              revealPlacement(targetPlacement);
            })
            .catch((error) => {
              if (
                generation !== resourceGenerationRef.current ||
                activeSessionIdRef.current !== ownerSessionId
              ) {
                return;
              }
              input.reportError(
                terminalCopy.startFailed,
                localizedShellErrorMessage(
                  error,
                  terminalCopy.startFailed,
                  locale,
                ),
                ownerSessionId,
              );
            });
          return;
        }
        default:
          return assertNever(definition);
      }
    },
    [
      input.reportError,
      layout.openDynamicWorkbarTab,
      layout.openWorkbarTab,
      locale,
      openNewSideConversation,
      registerTerminal,
      reserveOrdinal,
      revealPlacement,
      stopTerminal,
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
      sideConversations.upsertPanel(panel, !activePanel);
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

  const closeTabsImmediately = useCallback(
    (
      placement: SessionWorkbarPlacement,
      tabs: readonly SessionWorkbarTab[],
    ) => {
      if (tabs.length === 0) return;
      for (const tab of tabs) {
        const ref = terminalRefFromWorkbarTab(tab);
        if (ref && tab.ownerSessionId) stopTerminal(tab.ownerSessionId, ref);
      }
      layout.closeWorkbarTabs(
        placement,
        tabs.map((tab) => tab.id),
      );
      const panelIds = new Set(
        tabs
          .filter((tab) => tab.kind === 'side-chat')
          .map((tab) => tab.id.slice('side-chat:'.length)),
      );
      if (panelIds.size > 0) sideConversations.removePanels(panelIds);
    },
    [layout.closeWorkbarTabs, sideConversations, stopTerminal],
  );

  const closeTabs = useCallback(
    (
      placement: SessionWorkbarPlacement,
      tabs: readonly SessionWorkbarTab[],
    ) => {
      const closableTabs = tabs.filter(
        (tab) =>
          tab.kind !== 'side-chat' ||
          !sideConversations.preparingPanelIds.has(
            tab.id.slice('side-chat:'.length),
          ),
      );
      if (closableTabs.length === 0) return;
      const needsConfirmation =
        !skipSideChatCloseConfirmation &&
        closableTabs.some(
          (tab) =>
            tab.kind === 'side-chat' &&
            sideConversations.contentPanelIds.has(
              tab.id.slice('side-chat:'.length),
            ),
        );
      if (needsConfirmation) {
        setPendingSideChatClose(
          closableTabs.map((tab) => ({ placement, tab })),
        );
        return;
      }
      closeTabsImmediately(placement, closableTabs);
    },
    [
      closeTabsImmediately,
      sideConversations.contentPanelIds,
      sideConversations.preparingPanelIds,
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
    for (const resource of ownedTerminalResourcesRef.current.values()) {
      if (resource.sessionId !== activeSessionId) {
        stopTerminal(resource.sessionId, resource.ref);
      }
    }
    const stale = (['right', 'bottom'] as const).flatMap((placement) =>
      layout.workbarPanelsState[placement].tabs
        .filter(
          (tab) =>
            tab.kind === 'terminal' &&
            tab.ownerSessionId !== activeSessionId,
        )
        .map((tab) => ({ placement, tab })),
    );
    for (const placement of ['right', 'bottom'] as const) {
      closeTabsImmediately(
        placement,
        stale
          .filter((candidate) => candidate.placement === placement)
          .map((candidate) => candidate.tab),
      );
    }
  }, [
    activeSessionId,
    closeTabsImmediately,
    layout.workbarPanelsState,
    stopTerminal,
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
      layout.closeWorkbarTab(placement, tabId);
    }
    sideConversations.removePanels(staleIds);
  }, [
    activeSessionId,
    layout.closeWorkbarTab,
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
    const authoritativeSessionIds = input.authoritativeSessionIds;
    if (!authoritativeSessionIds) return;
    setHiddenCompanionForkIds((current) =>
      reconcileCompanionForkVisibility(
        current,
        authoritativeSessionIds,
      ),
    );
  }, [input.authoritativeSessionIds]);

  useEffect(
    () => browser.subscribeLive((payload) => setLiveBrowserSessionIds(payload.sessionIds)),
    [browser],
  );
  useEffect(() => {
    browser.setActiveSession(activeSessionId ?? null);
  }, [activeSessionId, browser]);

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
        closeTabsImmediately(
          placement,
          pending
            .filter((candidate) => candidate.placement === placement)
            .map((candidate) => candidate.tab),
        );
      }
    },
    [closeTabsImmediately, pendingSideChatClose],
  );

  const commands = useMemo<WorkbarControllerCommands>(
    () => ({ openTool, openSideChatWithQuote, respondToClientCapability, toggleRight }),
    [openSideChatWithQuote, openTool, respondToClientCapability, toggleRight],
  );

  const activeSideChatTabIds = useMemo(
    () =>
      new Set(
        sideConversations.panels
          .filter((panel) => panel.sourceSessionId === activeSessionId)
          .map((panel) => `side-chat:${panel.id}`),
      ),
    [activeSessionId, sideConversations.panels],
  );
  const hostPanelsState = useMemo(
    () =>
      projectWorkbarPanelsForSession(
        layout.workbarPanelsState,
        activeSessionId,
        activeSideChatTabIds,
      ),
    [activeSessionId, activeSideChatTabIds, layout.workbarPanelsState],
  );

  return {
    commands,
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
      panelsState: hostPanelsState,
      onActivateTab: layout.activateWorkbarTab,
      onCloseTab: closeTab,
      onCloseTabs: closeTabs,
      onReorderTab: layout.reorderWorkbarTab,
      onMoveTab: layout.moveWorkbarTab,
      onMoveTabToPanel: layout.moveWorkbarTabToPanel,
      onPinTab: layout.pinWorkbarTab,
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
      preparingSideChatPanelIds: sideConversations.preparingPanelIds,
      activeSideChatPanelIds: sideConversations.activePanelIds,
      onPreparingStateChange: sideConversations.setPreparing,
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
