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

import { batch, cleanup, effect, platform, signal, Text, View, type JSX } from 'nsh';
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
import { SIDE_PANES, Workbench, canDockBrowser, canDockPreview, sidePaneRoom } from './Workbench';
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
  sideSessionIds?: (string | null)[];
  sidebarExpanded: boolean;
  settings: { model?: ModelSelection } | null;
  panel: PanelRoute | null;
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
  // The desktop can show more conversations beside the selected one, each in
  // a fixed slot so a pane keeps its place while the others open and close.
  const restoredSides = platform.isTerminal ? [] : (saved?.sideSessionIds ?? []);
  const sides = Array.from({ length: SIDE_PANES }, (_, slot) => ({
    id: signal<string | null>(restoredSides[slot] ?? null),
    handle: signal<ConversationSessionHandle | null>(null),
  }));
  const besides = () => sides.flatMap((pane) => (pane.id() === null ? [] : [pane.id()!]));
  const sideSlot = (id: string) => sides.findIndex((pane) => pane.id() === id);
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
  const openSide = async (slot: number, id: string | null): Promise<boolean> => {
    if (!alive || blocked()) return false;
    const pane = sides[slot]!;
    const original = pane.id();
    const owner = pane.handle();
    try {
      if (id !== original && owner && !(await owner.leave())) return false;
      if (
        !alive ||
        blocked() ||
        pane.id() !== original ||
        (id !== null && id !== original && (id === selected() || sideSlot(id) >= 0))
      )
        return false;
      batch(() => {
        if (id === null) pane.handle.set(null);
        pane.id.set(id);
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
    const from = id === null ? -1 : sideSlot(id);
    if (from >= 0 && !(await openSide(from, null))) return false;
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
        (id !== null && sideSlot(id) >= 0)
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
    ...(platform.isTerminal
      ? {}
      : {
          openBeside(id: string) {
            if (id === selected() || sideSlot(id) >= 0) return;
            const used = sides.flatMap((pane, slot) => (pane.id() === null ? [] : [slot]));
            const room = Math.min(
              SIDE_PANES,
              sidePaneRoom(sidebarExpanded() && canDockBrowser(previewShown())),
            );
            const last = used.at(-1) ?? -1;
            // A new pane opens right of the others; with no room left it
            // replaces the rightmost one.
            const free = (from: number) =>
              sides.findIndex((pane, slot) => slot >= from && pane.id() === null);
            const slot =
              used.length >= room ? last : free(last + 1) >= 0 ? free(last + 1) : free(0);
            if (slot >= 0) void openSide(slot, id);
          },
          besideSessionIds: besides,
        }),
  };
  const sideShell = (slot: number): ConversationShell => ({
    sessionId: sides[slot]!.id,
    visible: shell.visible,
    blocked,
    openSession: (id) => openSide(slot, id),
    openSettings: shell.openSettings,
    // The main pane holds the browser; these sit beside it.
    sidebarShown: () => true,
    sidebarDocked: () => true,
    previewDocked: () => false,
    showSidebar() {},
    hideSidebar() {},
    dismissRoute: shell.dismissRoute,
    closePane() {
      void openSide(slot, null);
    },
  });
  cleanup(
    props.saveWith(async () => ({
      sessionId: selected(),
      sideSessionIds: sides.map((pane) => pane.id()),
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
        sides={sides.map((pane, slot) => ({
          shown: () => pane.id() !== null,
          render: () =>
            runtime.renderView(configuration.session, conversationSessionView, {
              shell: sideShell(slot),
              attach(handle) {
                if (pane.handle() !== handle) pane.handle.set(handle);
              },
            }),
        }))}
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
