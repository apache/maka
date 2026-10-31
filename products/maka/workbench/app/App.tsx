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
  type ConversationShell,
  type ConversationSessionHandle,
  type ConversationPreviewHandle,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { Workbench, canDockBrowser, canDockPreview, sidePaneRoom } from './Workbench';
import { createWorkbenchPlugins, type PanelRoute } from './plugins/context';
import { PluginPanel } from './plugins/PluginPanel';
import { initializeAppearance } from './appearance';
import { currentLocale, tr } from './locale';
import { errorText, renderText } from './text';
import { bodyTextStyle, C, controlStyle } from './ui';

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
  settings: { model?: ModelSelection } | null;
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
  },
) {
  const { context, runtime } = props;
  const configuration = context.configuration as unknown as Configuration;
  const saved = context.restored as SavedRoot | null;
  const selected = signal(saved === null ? nativeHost.initialSession : saved.sessionId);
  const sidebarExpanded = signal(saved?.sidebarExpanded ?? true);
  const settingsOpened = signal(saved?.settings !== null && saved?.settings !== undefined);
  const settingsModel = signal<ModelSelection | undefined>(saved?.settings?.model);
  const session = signal<ConversationSessionHandle | null>(null);
  const restoredSides = platform.isTerminal ? [] : (saved?.sideSessionIds ?? []);
  const sides = signal<SidePane[]>(restoredSides.map(createSide));
  const besides = () => sides().map((pane) => pane.id());
  const sideFor = (id: string) => sides().find((pane) => pane.id() === id);
  function createSide(id: string): SidePane {
    const pane: SidePane = {
      id: signal(id),
      handle: signal<ConversationSessionHandle | null>(null),
      render: () =>
        runtime.renderView(configuration.session, conversationSessionView, {
          shell: sideShell(pane),
          attach(handle) {
            if (pane.handle() !== handle) pane.handle.set(handle);
          },
        }),
    };
    return pane;
  }
  const preview = signal<ConversationPreviewHandle | null>(null);
  const notice = signal<unknown | null>(null);
  let alive = true;
  let navigationGeneration = 0;
  cleanup(() => {
    alive = false;
    navigationGeneration++;
  });
  // Apply the stored colors and text size from the start, not only once Settings opens.
  initializeAppearance();
  effect(() => currentLocale.set(runtime.locale()));
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
  const openSide = async (pane: SidePane, id: string | null): Promise<boolean> => {
    if (!alive || blocked()) return false;
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
          (index >= sideRoom() || id === selected() || sideFor(id) !== undefined))
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
    if (!alive || blocked()) return false;
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
        (id !== null && sideFor(id) !== undefined)
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
  const shell: ConversationShell = {
    sessionId: selected,
    visible: () => !settingsOpened() && !(plugins.panel() && !canDockPreview()),
    blocked,
    openSession,
    openSettings(model) {
      if (!alive || blocked()) return;
      navigationGeneration++;
      batch(() => {
        settingsModel.set(model);
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
      return !platform.isTerminal && sideRoom() > 0 ? openBeside : undefined;
    },
    ...(platform.isTerminal ? {} : { besideSessionIds: besides }),
  };
  function openBeside(id: string) {
    if (!alive || blocked() || id === selected() || sideFor(id)) return;
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
  cleanup(
    props.saveWith(async () => ({
      sessionId: selected(),
      sideSessionIds: besides(),
      sidebarExpanded: sidebarExpanded(),
      settings: settingsOpened() ? { model: settingsModel() } : null,
      panel: plugins.panelRoute(),
    })),
  );
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: C.background }}>
      <If when={runtime.updateError() !== null || notice() !== null}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8 }}>
          <Text style={[{ ...bodyTextStyle, flex: 1, color: C.warning }, { userSelect: 'text' }]}>
            {renderText(errorText(notice() ?? runtime.updateError()))}
          </Text>
          <If when={runtime.updateError() !== null}>
            <Button onPress={runtime.retryUpdates} style={controlStyle}>
              <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Retry')}</Text>
            </Button>
          </If>
        </View>
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
      {runtime.renderView(configuration.preview, conversationPreviewView, {
        shell,
        surface: 'overlays' as const,
        docked: false,
        attach(handle) {
          if (preview() !== handle) preview.set(handle);
        },
      })}
      {runtime.renderView(configuration.settings, settingsViewContract, {
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
      })}
    </View>
  );
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  let prepare: () => Promise<unknown> = async () => context.restored;
  return {
    exports: {
      root: {
        kind: 'root',
        render: (props) => (
          <App
            {...props}
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
