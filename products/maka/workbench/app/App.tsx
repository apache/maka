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
  batch,
  cleanup,
  createAnimatedValue,
  effect,
  platform,
  reduceMotion,
  signal,
  Text,
  View,
  type JSX,
  type Signal,
} from 'nsh';
import { host as nativeHost } from 'maka/host';
import type { QuoteRef } from '../../../../packages/plugin-sdk/src/index.js';
import { SideAskCard, SideCardFrame } from './SideQuestionCard';
import { Button } from 'nsh/base';
import type { UiModule, UiRootProps } from '../../../../packages/plugin-sdk/src/workbench.js';
import type {
  ModelSelection,
  UiTarget,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import {
  conversationNavigationView,
  conversationSessionView,
  conversationPreviewView,
  roomWorkspaceView,
  type RoomWorkspaceHandle,
  settingsViewContract,
  type ConversationCompact,
  type SideQuestionRequest,
  type SettingsPageInput,
  type ConversationShell,
  type ConversationSessionHandle,
  type ConversationPreviewHandle,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { currentWindow } from 'nsh/desktop';
import { QuickLauncher } from './QuickLauncher';
import { appUpdater } from './appUpdater';
import { createQuickTools, QuickToolsSettings, type QuickTools } from './QuickTools';
import { ownTitleBar, windowTitle } from './chrome';
import {
  createPreviewDialog,
  createSidebarHover,
  Workbench,
  canDockBrowser,
  canDockPreview,
  sideCardWidth,
  sidePaneRoom,
} from './Workbench';
import { createWorkbenchPlugins, type PanelRoute } from './plugins/context';
import { PluginPanel } from './plugins/PluginPanel';
import { Toaster } from './Feedback';
import { ConversationSkeleton, SidebarListSkeleton } from './Loading';
import { currentLocale, tr } from './locale';
import { toast } from './toastStore';
import { bodyTextStyle, C, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';

type Configuration = {
  navigation: UiTarget;
  session: UiTarget;
  preview: UiTarget;
  settings: UiTarget;
  rooms: UiTarget;
};
type SavedRoot = {
  sessionId: string | null;
  sideSessionIds?: string[];
  workspaceMode?: 'conversations' | 'rooms';
  roomSessionId?: string | null;
  sidebarExpanded: boolean;
  settings: { model?: ModelSelection; page?: string } | null;
  panel: PanelRoute | null;
};

type SidePane = {
  id: Signal<string>;
  handle: Signal<ConversationSessionHandle | null>;
  render(): JSX.Element;
};

function App(
  props: UiRootProps<JSX.Element> & {
    saveWith(prepare: () => Promise<SavedRoot>): () => void;
    quick: QuickTools;
  },
) {
  appUpdater.init();
  const { context, runtime } = props;
  const configuration = context.configuration as unknown as Configuration;
  const saved = context.restored as SavedRoot | null;
  const selected = signal(saved === null ? nativeHost.initialSession : saved.sessionId);
  const sidebarExpanded = signal(saved?.sidebarExpanded ?? true);
  const workspaceMode = signal<'conversations' | 'rooms'>(saved?.workspaceMode ?? 'conversations');
  const roomWorkspace = signal<RoomWorkspaceHandle | null>(null);
  const settingsOpened = signal(saved?.settings !== null && saved?.settings !== undefined);
  const settingsModel = signal<ModelSelection | undefined>(saved?.settings?.model);
  const settingsPage = signal<string | undefined>(saved?.settings?.page);
  const settingsNavigation = signal(0);
  const session = signal<ConversationSessionHandle | null>(null);
  windowTitle(() =>
    settingsOpened()
      ? tr('Settings')
      : workspaceMode() === 'rooms'
        ? (roomWorkspace()?.title() ?? tr('Rooms'))
        : (session()?.title() ?? null),
  );
  const restoredSides = platform.idiom === 'terminal' ? [] : (saved?.sideSessionIds ?? []);
  const sides = signal<SidePane[]>(restoredSides.map((id) => createSide(id)));
  const besides = () => sides().map((pane) => pane.id());
  const sideFor = (id: string) => sides().find((pane) => pane.id() === id);
  function createSide(
    id: string,
    paneShell = sideShell,
    firstMessage?: string,
    compact?: ConversationCompact,
    firstQuotes?: readonly QuoteRef[],
  ): SidePane {
    // The first message is handed over once: a pane rendered again, as a card
    // is after another mode was shown, must not send it a second time.
    let first =
      firstMessage === undefined ? undefined : { text: firstMessage, quotes: firstQuotes };
    const pane: SidePane = {
      id: signal(id),
      handle: signal<ConversationSessionHandle | null>(null),
      render: () => {
        const opening = first;
        first = undefined;
        return runtime.renderView(
          configuration.session,
          conversationSessionView,
          {
            shell: paneShell(pane),
            active: () => workspaceMode() === 'conversations',
            firstMessage: opening?.text,
            firstQuotes: opening?.quotes,
            compact,
            attach(handle) {
              if (pane.handle() !== handle) pane.handle.set(handle);
            },
          },
          { loading: () => <ConversationSkeleton /> },
        );
      },
    };
    return pane;
  }
  const launcherOpened = signal(false);
  const assistant = signal<SidePane | null>(null);
  const preview = signal<ConversationPreviewHandle | null>(null);
  let alive = true;
  let navigationGeneration = 0;
  cleanup(() => {
    alive = false;
    navigationGeneration++;
  });
  const mainWindow = currentWindow();
  const plugins = createWorkbenchPlugins(runtime, {
    sessionId: selected,
    showPanel() {
      navigationGeneration++;
      settingsOpened.set(false);
      preview()?.close();
    },
    restorePanel: saved?.panel,
  });
  const blocked = () => runtime.reloading();
  effect(() => {
    if (!preview()?.shown()) return;
    const panel = plugins.panel();
    if (panel) plugins.closePanel(panel.instance);
  });
  // A side question's card beside the selected conversation: first where it is
  // asked, then its conversation. One at a time; it stays with that conversation.
  type SideCard = {
    parent: string | null;
    /** Its conversation, once the question is asked. */
    pane: Signal<SidePane | null>;
    render(): JSX.Element;
  };
  const sideCard = signal<SideCard | null>(null);
  const sideCardBudget = () =>
    workspaceMode() === 'conversations' && sideCard() !== null ? sideCardWidth() : 0;
  const previewShown = () => plugins.panel() !== null || (preview()?.shown() ?? false);
  const previewFullscreen = () =>
    platform.idiom !== 'terminal' &&
    plugins.panel() === null &&
    canDockPreview(sideCardBudget()) &&
    (preview()?.shown() ?? false) &&
    (preview()?.fullscreen?.() ?? false);
  const closePreview = () => {
    const panel = plugins.panel();
    if (panel) plugins.closePanel(panel.instance);
    else preview()?.close();
  };
  const previewDialog = createPreviewDialog({
    shown: previewShown,
    suppressed: () =>
      settingsOpened() ||
      workspaceMode() !== 'conversations' ||
      (plugins.panel() === null && (preview()?.modalSuppressed() ?? false)),
    focused: () => plugins.panel() !== null || (preview()?.focused() ?? false),
    cardWidth: sideCardBudget,
    close: closePreview,
  });
  const sideRoom = () =>
    sidePaneRoom(
      sidebarExpanded() && canDockBrowser(previewShown(), sideCardBudget()),
      previewShown() && canDockPreview(sideCardBudget()),
      sideCardBudget(),
    );
  const launcherClosed = () =>
    batch(() => {
      assistant.set(null);
      launcherOpened.set(false);
    });
  const closeLauncher = async (): Promise<boolean> => {
    const pane = assistant();
    if (pane) {
      if (blocked()) return false;
      try {
        const owner = pane.handle();
        if (owner && !(await owner.leave())) return false;
      } catch (reason) {
        console.warn('Could not close the quick launcher conversation:', reason);
        return false;
      }
    }
    launcherClosed();
    return true;
  };
  // A conversation is open in one pane at a time, and the popup is one of them.
  const releaseAssistant = (id: string | null) =>
    id !== null && assistant()?.id() === id ? closeLauncher() : Promise.resolve(true);
  const openElsewhere = (id: string) =>
    sideFor(id) !== undefined || assistant()?.id() === id || sideCard()?.pane()?.id() === id;
  const closeSideCard = async (): Promise<boolean> => {
    const card = sideCard();
    if (card === null) return true;
    try {
      const owner = card.pane()?.handle();
      if (owner && !(await owner.leave())) return false;
    } catch (reason) {
      console.warn('Could not close the side question:', reason);
      return false;
    }
    if (sideCard() === card) sideCard.set(null);
    return true;
  };
  const sidePane = (id: string, first?: { text: string; quotes: readonly QuoteRef[] }) =>
    createSide(
      id,
      (self) => ({
        ...sideShell(self),
        visible: shell.visible,
        paneVisible: conversationPaneVisible,
        previewDocked: () => false,
        // What a side question links to opens in the window, not in its card.
        openSession: (next) => (next === self.id() ? Promise.resolve(true) : openSession(next)),
        closePane: () => void closeSideCard(),
      }),
      first?.text,
      {
        close: () => void closeSideCard(),
        expand: () =>
          void closeSideCard().then((closed) => {
            if (!closed) return;
            if (sideRoom() > 0) openBeside(id);
            else void openSession(id);
          }),
        side: {
          attach: (reference) => session()?.appendToDraft?.(reference) ?? false,
          detach: (sessionId) => session()?.removeSessionReference?.(sessionId),
        },
      },
      first?.quotes,
    );
  const askBeside = (request: SideQuestionRequest) => {
    if (!alive || blocked()) return;
    void closeSideCard().then((closed) => {
      if (!closed || !alive || blocked()) return;
      const card: SideCard = {
        parent: selected(),
        pane: signal<SidePane | null>(null),
        // The card stays as its question becomes a conversation.
        render: () => (
          <SideCardFrame>
            <If
              when={card.pane()}
              else={
                <SideAskCard
                  quotes={request.quotes}
                  ask={async (text) => {
                    const id = await request.ask(text);
                    if (alive && sideCard() === card)
                      card.pane.set(sidePane(id, { text, quotes: request.quotes }));
                    // The card closed while its conversation was created: the
                    // question is never sent, so no empty side question stays.
                    else
                      void request
                        .discard(id)
                        .catch((reason) =>
                          console.warn('An unasked side question was not discarded:', reason),
                        );
                  }}
                  close={() => void closeSideCard()}
                />
              }
            >
              {card.pane()!.render()}
            </If>
          </SideCardFrame>
        ),
      };
      sideCard.set(card);
    });
  };
  let sideOpening = 0;
  // A side question's card opens beside the conversation it was asked from, which is
  // selected first. The card open before closes once, and a pane showing the side question
  // gives it up. The last request wins.
  const openSideQuestion = async (id: string, parent = selected()): Promise<boolean> => {
    const opening = ++sideOpening;
    const current = () => alive && !blocked() && opening === sideOpening;
    if (!current() || parent === null || id === parent) return false;
    const shown = sideCard();
    const needsRoute =
      parent !== selected() || workspaceMode() !== 'conversations' || settingsOpened();
    if (shown?.parent === parent && shown.pane()?.id() === id && selected() === parent)
      return !needsRoute || ((await openSession(parent)) && current());
    if (!(await closeSideCard()) || !(await releaseAssistant(id))) return false;
    const from = sideFor(id);
    if (from && !(await openSide(from, null))) return false;
    if (needsRoute && !(await openSession(parent))) return false;
    if (
      !current() ||
      selected() !== parent ||
      workspaceMode() !== 'conversations' ||
      settingsOpened() ||
      sideCard() !== null ||
      openElsewhere(id)
    )
      return false;
    const pane = sidePane(id);
    sideCard.set({
      parent,
      pane: signal<SidePane | null>(pane),
      render: () => <SideCardFrame>{pane.render()}</SideCardFrame>,
    });
    return true;
  };
  effect(() => {
    const card = sideCard();
    if (card !== null && card.parent !== selected()) void closeSideCard();
  });
  const openSide = async (pane: SidePane, id: string | null): Promise<boolean> => {
    if (!alive || blocked() || !(await releaseAssistant(id))) return false;
    const original = pane.id();
    const owner = pane.handle();
    try {
      if (id !== original && owner && !(await owner.leave())) return false;
      const index = sides().indexOf(pane);
      if (
        !alive ||
        blocked() ||
        index < 0 ||
        pane.id() !== original ||
        (id !== null &&
          id !== original &&
          (index >= sideRoom() || id === selected() || openElsewhere(id)))
      )
        return false;
      batch(() => {
        if (id === null) sides.set(sides().filter((side) => side !== pane));
        else pane.id.set(id);
      });
      return true;
    } catch (reason) {
      console.warn('Could not switch the side conversation:', reason);
      return false;
    }
  };
  const openSession = async (id: string | null): Promise<boolean> => {
    if (id !== null) {
      if ((await session()?.kind(id)) === 'room') {
        if (!(await roomWorkspace()?.open(id))) return false;
        return switchWorkspace('rooms');
      }
    }
    await roomWorkspace()?.flush();
    if (!alive || blocked() || !(await releaseAssistant(id))) return false;
    // A conversation is open in one pane at a time; selecting a side one moves it here.
    const from = id === null ? undefined : sideFor(id);
    if (from && !(await openSide(from, null))) return false;
    if (id !== null && sideCard()?.pane()?.id() === id && !(await closeSideCard())) return false;
    const generation = ++navigationGeneration;
    const original = selected();
    const owner = session();
    try {
      if (id !== original && owner && !(await owner.leave())) return false;
      if (
        !alive ||
        blocked() ||
        generation !== navigationGeneration ||
        selected() !== original ||
        (id !== null && openElsewhere(id))
      )
        return false;
      batch(() => {
        settingsOpened.set(false);
        workspaceMode.set('conversations');
        selected.set(id);
      });
      return true;
    } catch (reason) {
      console.warn('Could not switch the conversation:', reason);
      return false;
    }
  };
  const vacate = (id: string) => {
    const side = sideFor(id);
    if (side) return openSide(side, null);
    return selected() === id ? openSession(null) : Promise.resolve(true);
  };
  const showSession = async (id: string) => {
    if (!(await openSession(id))) return false;
    mainWindow.focus();
    return true;
  };
  const connectionDetails = signal(false);
  const connectionDiagnostic = () => {
    const reason = runtime.updateError();
    return reason instanceof Error ? reason.message : String(reason);
  };
  const CONNECTION_TOAST_ID = 'workbench.connection-interrupted';
  effect(() => {
    if (platform.idiom === 'terminal') return;
    currentLocale();
    const reason = runtime.updateError();
    if (reason === null) {
      toast.dismiss(CONNECTION_TOAST_ID);
      return;
    }
    toast.upsert(CONNECTION_TOAST_ID, {
      tone: 'warning',
      persistent: true,
      dismissible: false,
      message: tr('Connection interrupted. Reconnect to continue; your draft is kept.'),
      details: {
        label: tr('Details'),
        text: connectionDiagnostic(),
      },
      actions: [
        {
          label: tr('Retry'),
          primary: true,
          dismissOnPress: false,
          onPress: runtime.retryUpdates,
        },
      ],
    });
  });
  cleanup(() => {
    toast.dismiss(CONNECTION_TOAST_ID);
  });
  const conversationPaneVisible = () => shell.visible() && !previewFullscreen() && !previewDialog();
  const shell: ConversationShell = {
    sessionId: selected,
    visible: () =>
      workspaceMode() === 'conversations' &&
      !settingsOpened() &&
      !(plugins.panel() && !canDockPreview(sideCardBudget())),
    paneVisible: conversationPaneVisible,
    blocked,
    connectionLost: () => runtime.updateError() !== null,
    openSession,
    openSettings(model, page) {
      if (!alive || blocked()) return;
      if (settingsOpened() && model === undefined && page === undefined) return;
      navigationGeneration++;
      batch(() => {
        settingsModel.set(model);
        settingsPage.set(page);
        settingsNavigation.set(settingsNavigation() + 1);
        settingsOpened.set(true);
      });
    },
    sidebarShown: sidebarExpanded,
    sidebarHover: (inside) => sidebarHover.hover(inside),
    sidebarDocked: () => canDockBrowser(previewShown(), sideCardBudget()),
    previewDocked: () =>
      (previewShown() && canDockPreview(sideCardBudget())) ||
      Math.min(sideRoom(), sides().length) > 0,
    showSidebar() {
      if (!blocked()) sidebarExpanded.set(true);
    },
    hideSidebar() {
      if (!blocked()) sidebarExpanded.set(false);
    },
    dismissRoute() {
      if (!settingsOpened() || blocked()) return false;
      navigationGeneration++;
      settingsOpened.set(false);
      return true;
    },
    get openBeside() {
      return platform.idiom !== 'terminal' && sideRoom() > 0 ? openBeside : undefined;
    },
    ...(platform.idiom === 'terminal'
      ? {}
      : {
          // The side question in its card is beside the conversation too.
          besideSessionIds: () => {
            const card = sideCard()?.pane()?.id();
            return card ? [...besides(), card] : besides();
          },
          askBeside,
          openSideQuestion,
          sideQuestionId: () => sideCard()?.pane()?.id() ?? null,
        }),
  };
  const sidebarHover = createSidebarHover(
    () => !sidebarExpanded() && conversationPaneVisible() && !blocked(),
  );
  const switchWorkspace = async (mode: 'conversations' | 'rooms') => {
    if (blocked()) return false;
    if (mode === workspaceMode()) return true;
    if (workspaceMode() === 'rooms') await roomWorkspace()?.flush();
    else {
      const panes = [
        session(),
        ...sides().map((pane) => pane.handle()),
        sideCard()?.pane()?.handle(),
      ];
      if ((await Promise.all(panes.map((pane) => pane?.leave()))).includes(false)) return false;
    }
    batch(() => {
      settingsOpened.set(false);
      workspaceMode.set(mode);
    });
    return true;
  };
  const modeSwitch = () => (
    <View
      role="tablist"
      accessibilityLabel={tr('Workspace mode')}
      style={{
        flexDirection: 'row',
        backgroundColor: C.background,
        padding: 3,
        borderRadius: 10,
      }}
    >
      <Each of={['conversations', 'rooms'] as const} key={(mode) => mode}>
        {(mode) => (
          <Button
            role="tab"
            accessibilityLabel={mode() === 'rooms' ? tr('Rooms') : tr('Conversations')}
            selected={workspaceMode() === mode()}
            onPress={() => void switchWorkspace(mode())}
            style={{
              flex: 1,
              height: 30,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              backgroundColor: workspaceMode() === mode() ? C.card : 'transparent',
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text
              style={{ fontSize: 12, color: workspaceMode() === mode() ? C.text : C.secondary }}
            >
              {mode() === 'rooms' ? tr('Rooms') : tr('Conversations')}
            </Text>
          </Button>
        )}
      </Each>
    </View>
  );

  function openBeside(id: string) {
    if (!alive || blocked() || id === selected() || sideFor(id)) return;
    if (assistant()?.id() === id) {
      void closeLauncher().then((closed) => {
        if (closed) openBeside(id);
      });
      return;
    }
    const room = sideRoom();
    if (room === 0) return;
    const open = sides();
    if (open.length < room) sides.set([...open, createSide(id)]);
    else void openSide(open[room - 1]!, id);
  }
  function sideShell(pane: SidePane): ConversationShell {
    return {
      sessionId: pane.id,
      visible: () => shell.visible() && sides().indexOf(pane) < sideRoom(),
      paneVisible: () => conversationPaneVisible() && sides().indexOf(pane) < sideRoom(),
      blocked,
      connectionLost: () => runtime.updateError() !== null,
      openSession: (id) => openSide(pane, id),
      openSettings: shell.openSettings,
      sidebarShown: () => true,
      sidebarDocked: () => true,
      previewDocked: () => {
        const index = sides().indexOf(pane);
        return (
          (previewShown() && canDockPreview(sideCardBudget())) ||
          (index >= 0 && index + 1 < Math.min(sideRoom(), sides().length))
        );
      },
      showSidebar() {},
      hideSidebar() {},
      dismissRoute: shell.dismissRoute,
      closePane() {
        void openSide(pane, null);
      },
    };
  }
  function assistantShell(pane: SidePane): ConversationShell {
    return {
      ...sideShell(pane),
      visible: () => true,
      paneVisible: () => true,
      previewDocked: () => false,
      async openSession(id) {
        if (id === pane.id()) return true;
        if (!(await closeLauncher())) return false;
        return id === null || showSession(id);
      },
      openSettings(model, page) {
        void closeLauncher().then((closed) => {
          if (!closed) return;
          shell.openSettings(model, page);
          mainWindow.focus();
        });
      },
      dismissRoute: () => false,
      closePane() {
        void closeLauncher();
      },
    };
  }
  const openBot = async () => {
    const owner = session();
    if (!owner) throw new Error(tr('Maka Bot could not be opened'));
    return owner.openBot();
  };
  const openAssistant = (id: string, message?: string) => {
    // Navigation or dismissal may have won while the launcher was preparing the draft.
    if (!alive || blocked() || !launcherOpened() || id === selected() || sideFor(id)) return;
    assistant.set(
      createSide(id, assistantShell, message, {
        expand: () => void expandAssistant(),
        close: () => void closeLauncher(),
      }),
    );
  };
  const expandAssistant = async () => {
    const id = assistant()?.id();
    if (id !== undefined && (await closeLauncher())) await showSession(id);
  };
  cleanup(
    props.saveWith(async () => {
      await roomWorkspace()?.flush();
      return {
        workspaceMode: workspaceMode(),
        roomSessionId: roomWorkspace()?.selected() ?? saved?.roomSessionId ?? null,
        sessionId: selected(),
        sideSessionIds: besides(),
        sidebarExpanded: sidebarExpanded(),
        settings: settingsOpened() ? { model: settingsModel(), page: settingsPage() } : null,
        panel: plugins.panelRoute(),
      };
    }),
  );
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: platform.idiom === 'terminal' ? C.background : C.chrome,
      }}
    >
      <If when={ownTitleBar}>
        <QuickLauncher
          quick={props.quick}
          currentSession={selected}
          showQuestion={async (id) => {
            if (await closeLauncher()) await showSession(id);
          }}
          openBot={openBot}
          vacate={vacate}
          open={openAssistant}
          opened={launcherOpened}
          conversing={() => assistant() !== null}
          conversation={() => assistant()!.render()}
          close={closeLauncher}
          closed={launcherClosed}
        />
      </If>
      <WorkspaceSurface visible={() => !settingsOpened() && workspaceMode() === 'conversations'}>
        <Workbench
          expanded={sidebarExpanded}
          sidebarHover={sidebarHover}
          previewShown={previewShown}
          previewFullscreen={previewFullscreen}
          togglePreviewFullscreen={() => {
            const current = preview();
            if (current?.setFullscreen) current.setFullscreen(!(current.fullscreen?.() ?? false));
          }}
          floatingComposer={() => (session()?.floatingComposer?.() as JSX.Element | null) ?? null}
          previewDialog={previewDialog}
          closePreview={closePreview}
          sides={sides}
          card={() => (workspaceMode() === 'conversations' ? sideCard() : null)}
          navigation={(temporary) =>
            runtime.renderView(
              configuration.navigation,
              conversationNavigationView,
              {
                shell,
                openRooms: () => void switchWorkspace('rooms'),
                suppressSidebarHover: sidebarHover.suppressUntilExit,
                holdSidebarHover: temporary ? sidebarHover.hold : undefined,
                pinSidebar: temporary ? shell.showSidebar : undefined,
              },
              { loading: () => <SidebarListSkeleton /> },
            )
          }
          preview={(docked) =>
            plugins.panel() !== null ? (
              <PluginPanel docked={docked} controller={plugins} />
            ) : (
              runtime.renderView(configuration.preview, conversationPreviewView, {
                shell,
                surface: 'pane' as const,
                docked,
                attach(handle) {
                  if (preview() !== handle) preview.set(handle);
                },
              })
            )
          }
        >
          {runtime.renderView(
            configuration.session,
            conversationSessionView,
            {
              shell,
              attach(handle) {
                if (session() !== handle) session.set(handle);
              },
            },
            { loading: () => <ConversationSkeleton /> },
          )}
        </Workbench>
      </WorkspaceSurface>
      <WorkspaceSurface visible={() => !settingsOpened() && workspaceMode() === 'rooms'}>
        {runtime.renderView(configuration.rooms, roomWorkspaceView, {
          initialSessionId: saved?.roomSessionId ?? null,
          agentSessionId: selected,
          active: () => workspaceMode() === 'rooms',
          visible: () => workspaceMode() === 'rooms' && !settingsOpened(),
          blocked,
          sidebarExpanded,
          setSidebarExpanded: (expanded) => sidebarExpanded.set(expanded),
          openSession: (id) => {
            void openSession(id);
          },
          openSettings: () => shell.openSettings(),
          modeSwitch,
          attach: (handle) => {
            if (roomWorkspace() !== handle) roomWorkspace.set(handle);
          },
        })}
      </WorkspaceSurface>
      <WorkspaceSurface visible={settingsOpened}>
        {runtime.renderView(
          configuration.settings,
          settingsViewContract,
          {
            opened: settingsOpened,
            navigation: settingsNavigation,
            close: () => {
              if (!alive || blocked()) return;
              navigationGeneration++;
              settingsOpened.set(false);
            },
            get model() {
              return settingsModel();
            },
            get page() {
              return settingsPage();
            },
          },
          { loading: false },
        )}
      </WorkspaceSurface>
      <If when={platform.idiom === 'terminal' && runtime.updateError() !== null}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 4,
            backgroundColor: C.chrome,
          }}
        >
          <Text style={[{ ...bodyTextStyle, flex: 1, color: C.warning }, { userSelect: 'text' }]}>
            {tr('Connection interrupted. Reconnect to continue; your draft is kept.')}
            {connectionDetails() ? `\n${connectionDiagnostic()}` : ''}
          </Text>
          <Button
            accessibilityLabel={tr('Details')}
            onPress={() => connectionDetails.set(!connectionDetails())}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.pressed }}
          >
            <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Details')}</Text>
          </Button>
          <Button
            accessibilityLabel={tr('Retry')}
            onPress={runtime.retryUpdates}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.pressed }}
          >
            <Text style={{ ...bodyTextStyle, color: C.accentText }}>{tr('Retry')}</Text>
          </Button>
        </View>
      </If>

      {runtime.renderView(
        configuration.preview,
        conversationPreviewView,
        {
          shell,
          surface: 'overlays' as const,
          docked: false,
          attach(handle) {
            if (preview() !== handle) preview.set(handle);
          },
        },
        { loading: false },
      )}
      <Toaster />
    </View>
  );
}

function WorkspaceSurface(props: { visible(): boolean; children: JSX.Element }) {
  const opacity = createAnimatedValue(props.visible() ? 1 : 0);
  effect(() => {
    void opacity.timing(props.visible() ? 1 : 0, { duration: reduceMotion() ? 0 : 160 });
  });
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        display: props.visible() ? 'flex' : 'none',
        opacity,
        transform: [
          { translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
        ],
      }}
    >
      {props.children}
    </View>
  );
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  let prepare: () => Promise<unknown> = async () => context.restored;
  // The launcher and Settings › Quick tools show the same tools, commands and pages.
  const quick = createQuickTools(context.runtime);
  return {
    exports: {
      quickTools: {
        kind: 'settings',
        render: ({ input }) => (
          <QuickToolsSettings quick={quick} input={input as SettingsPageInput | undefined} />
        ),
      },
      root: {
        kind: 'root',
        render: (props) => (
          <App
            {...props}
            quick={quick}
            saveWith={(next) => {
              prepare = next;
              return () => {
                if (prepare === next) prepare = async () => null;
              };
            }}
          />
        ),
      },
    },
    prepareReload: () => prepare(),
  };
};
