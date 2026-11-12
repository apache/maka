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

import { batch, cleanup, effect, platform, signal, Text, View, type JSX, type Signal } from 'nsh';
import { host as nativeHost } from 'maka/host';
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
  settingsViewContract,
  type ConversationCompact,
  type SettingsPageInput,
  type ConversationShell,
  type ConversationSessionHandle,
  type ConversationPreviewHandle,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { currentWindow } from 'nsh/desktop';
import { QuickLauncher } from './QuickLauncher';
import { createQuickTools, QuickToolsSettings, type QuickTools } from './QuickTools';
import { ownTitleBar } from './chrome';
import { Workbench, canDockBrowser, canDockPreview, sidePaneRoom } from './Workbench';
import { createWorkbenchPlugins, type PanelRoute } from './plugins/context';
import { PluginPanel } from './plugins/PluginPanel';
import { currentLocale, tr } from './locale';
import { errorText, renderText } from './text';
import { bodyTextStyle, C, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';

type Configuration = {
  navigation: UiTarget;
  session: UiTarget;
  preview: UiTarget;
  settings: UiTarget;
};
type SavedRoot = {
  sessionId: string | null;
  sideSessionIds?: string[];
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
  const { context, runtime } = props;
  const configuration = context.configuration as unknown as Configuration;
  const saved = context.restored as SavedRoot | null;
  const selected = signal(saved === null ? nativeHost.initialSession : saved.sessionId);
  const sidebarExpanded = signal(saved?.sidebarExpanded ?? true);
  const settingsOpened = signal(saved?.settings !== null && saved?.settings !== undefined);
  const settingsModel = signal<ModelSelection | undefined>(saved?.settings?.model);
  const settingsPage = signal<string | undefined>(saved?.settings?.page);
  const session = signal<ConversationSessionHandle | null>(null);
  const restoredSides = platform.idiom === 'terminal' ? [] : (saved?.sideSessionIds ?? []);
  const sides = signal<SidePane[]>(restoredSides.map((id) => createSide(id)));
  const besides = () => sides().map((pane) => pane.id());
  const sideFor = (id: string) => sides().find((pane) => pane.id() === id);
  function createSide(
    id: string,
    paneShell = sideShell,
    firstMessage?: string,
    compact?: ConversationCompact,
  ): SidePane {
    const pane: SidePane = {
      id: signal(id),
      handle: signal<ConversationSessionHandle | null>(null),
      render: () =>
        runtime.renderView(configuration.session, conversationSessionView, {
          shell: paneShell(pane),
          firstMessage,
          compact,
          attach(handle) {
            if (pane.handle() !== handle) pane.handle.set(handle);
          },
        }),
    };
    return pane;
  }
  const launcherOpened = signal(false);
  const assistant = signal<SidePane | null>(null);
  const preview = signal<ConversationPreviewHandle | null>(null);
  const notice = signal<unknown | null>(null);
  let alive = true;
  let navigationGeneration = 0;
  cleanup(() => {
    alive = false;
    navigationGeneration++;
  });
  effect(() => currentLocale.set(runtime.locale()));
  const mainWindow = currentWindow();
  const report = (reason: unknown) => {
    if (alive) notice.set(reason);
  };
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
  const previewShown = () => plugins.panel() !== null || (preview()?.shown() ?? false);
  const sideRoom = () =>
    sidePaneRoom(
      sidebarExpanded() && canDockBrowser(previewShown()),
      previewShown() && canDockPreview(),
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
        report(reason);
        return false;
      }
    }
    launcherClosed();
    return true;
  };
  // A conversation is open in one pane at a time, and the popup is one of them.
  const releaseAssistant = (id: string | null) =>
    id !== null && assistant()?.id() === id ? closeLauncher() : Promise.resolve(true);
  const openElsewhere = (id: string) => sideFor(id) !== undefined || assistant()?.id() === id;
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
      report(reason);
      return false;
    }
  };
  const openSession = async (id: string | null): Promise<boolean> => {
    if (!alive || blocked() || !(await releaseAssistant(id))) return false;
    // A conversation is open in one pane at a time; selecting a side one moves it here.
    const from = id === null ? undefined : sideFor(id);
    if (from && !(await openSide(from, null))) return false;
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
        notice.set(null);
        settingsOpened.set(false);
        selected.set(id);
      });
      return true;
    } catch (reason) {
      report(reason);
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
  const shell: ConversationShell = {
    sessionId: selected,
    visible: () => !settingsOpened() && !(plugins.panel() && !canDockPreview()),
    blocked,
    connectionLost: () => runtime.updateError() !== null,
    openSession,
    openSettings(model, page) {
      if (!alive || blocked()) return;
      navigationGeneration++;
      batch(() => {
        settingsModel.set(model);
        settingsPage.set(page);
        settingsOpened.set(true);
      });
    },
    sidebarShown: sidebarExpanded,
    sidebarDocked: () => canDockBrowser(previewShown()),
    previewDocked: () => previewShown() && canDockPreview(),
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
    ...(platform.idiom === 'terminal' ? {} : { besideSessionIds: besides }),
  };
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
      visible: shell.visible,
      blocked,
      connectionLost: () => runtime.updateError() !== null,
      openSession: (id) => openSide(pane, id),
      openSettings: shell.openSettings,
      sidebarShown: () => true,
      sidebarDocked: () => true,
      previewDocked: () => false,
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
    props.saveWith(async () => ({
      sessionId: selected(),
      sideSessionIds: besides(),
      sidebarExpanded: sidebarExpanded(),
      settings: settingsOpened() ? { model: settingsModel(), page: settingsPage() } : null,
      panel: plugins.panelRoute(),
    })),
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
          openBot={openBot}
          vacate={vacate}
          open={openAssistant}
          opened={launcherOpened}
          conversing={() => assistant() !== null}
          conversation={() => assistant()!.render()}
          close={closeLauncher}
          closed={launcherClosed}
          report={report}
        />
      </If>
      <Workbench
        expanded={sidebarExpanded}
        previewShown={previewShown}
        previewSuppressed={() =>
          plugins.panel() === null && (preview()?.modalSuppressed() ?? false)
        }
        previewFocused={() => plugins.panel() !== null || (preview()?.focused() ?? false)}
        closePreview={() => {
          const panel = plugins.panel();
          if (panel) plugins.closePanel(panel.instance);
          else preview()?.close();
        }}
        sides={sides}
        navigation={() =>
          runtime.renderView(configuration.navigation, conversationNavigationView, { shell })
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
        {runtime.renderView(configuration.session, conversationSessionView, {
          shell,
          attach(handle) {
            if (session() !== handle) session.set(handle);
          },
        })}
      </Workbench>
      <If when={runtime.updateError() !== null || notice() !== null}>
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
            {runtime.updateError() !== null
              ? tr('Connection interrupted. Reconnect to continue; your draft is kept.')
              : renderText(errorText(notice()))}
            {connectionDetails() && runtime.updateError() !== null
              ? `\n${connectionDiagnostic()}`
              : ''}
          </Text>
          <If when={runtime.updateError() !== null}>
            <Button
              accessibilityLabel={tr('Details')}
              onPress={() => connectionDetails.set(!connectionDetails())}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              activeStyle={{ backgroundColor: C.line }}
            >
              <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Details')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Retry')}
              onPress={runtime.retryUpdates}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              activeStyle={{ backgroundColor: C.line }}
            >
              <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Retry')}</Text>
            </Button>
          </If>
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
      {runtime.renderView(
        configuration.settings,
        settingsViewContract,
        {
          opened: settingsOpened,
          close: () => {
            if (!alive || blocked()) return;
            navigationGeneration++;
            settingsOpened.set(false);
          },
          changed: () => notice.set(null),
          get model() {
            return settingsModel();
          },
          get page() {
            return settingsPage();
          },
        },
        { loading: false },
      )}
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
