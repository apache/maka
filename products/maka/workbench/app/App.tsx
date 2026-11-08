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
  host as surfaceHost,
  cleanup,
  effect,
  keymap,
  platform,
  signal,
  Text,
  View,
  type JSX,
  type Signal,
} from 'nsh';
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
import { QuickToolsSurface } from './QuickTools';
import { QuickToolsWindow } from './QuickToolsWindow';
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
  },
) {
  const { context, runtime } = props;
  if (surfaceHost.params.quickToolsPanel === true) return <QuickToolsWindow {...props} />;
  surfaceHost.on('quickTools.assistant', (value) => {
    const id = (value as { sessionId?: string }).sessionId;
    if (id) void openSession(id);
  });
  const nativeQuickTools = surfaceHost.params.nativeQuickTools === true;
  const quickToolsOpened = signal(false);
  if (platform.idiom !== 'terminal')
    cleanup(
      keymap.bind(
        'alt+space',
        () => {
          if (nativeQuickTools) void surfaceHost.call('quickTools.show', {});
          else quickToolsOpened.set(!quickToolsOpened());
        },
        { when: 'always' },
      ),
    );
  const configuration = context.configuration as unknown as Configuration;
  const saved = context.restored as SavedRoot | null;
  const selected = signal(saved === null ? nativeHost.initialSession : saved.sessionId);
  const sidebarExpanded = signal(saved?.sidebarExpanded ?? true);
  const settingsOpened = signal(saved?.settings !== null && saved?.settings !== undefined);
  const settingsModel = signal<ModelSelection | undefined>(saved?.settings?.model);
  const settingsPage = signal<string | undefined>(saved?.settings?.page);
  const session = signal<ConversationSessionHandle | null>(null);
  const restoredSides = platform.idiom === 'terminal' ? [] : (saved?.sideSessionIds ?? []);
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
    if (nativeQuickTools && id) {
      try {
        await surfaceHost.call('quickTools.session.claim', { sessionId: id });
      } catch (error) {
        report(error);
        return false;
      }
    }
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
    if (nativeQuickTools && id) {
      try {
        await surfaceHost.call('quickTools.session.claim', { sessionId: id });
      } catch (error) {
        report(error);
        return false;
      }
    }
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
  surfaceHost.on('quickTools.session.release', async (value) => {
    const request = value as { sessionId: string; token: string };
    let ok = true;
    try {
      const side = sideFor(request.sessionId);
      if (side) ok = await openSide(side, null);
      if (ok && selected() === request.sessionId) {
        const owner = session();
        if (owner && !(await owner.leave())) ok = false;
        else selected.set(null);
      }
    } catch (error) {
      report(error);
      ok = false;
    }
    await surfaceHost.call('quickTools.session.reply', { token: request.token, ok });
  });
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
  async function openBeside(id: string) {
    if (!alive || blocked() || id === selected() || sideFor(id)) return;
    if (nativeQuickTools) {
      try {
        await surfaceHost.call('quickTools.session.claim', { sessionId: id });
      } catch (error) {
        report(error);
        return;
      }
    }
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
      <If when={platform.idiom !== 'terminal' && !nativeQuickTools}>
        <QuickToolsSurface
          opened={quickToolsOpened}
          close={() => quickToolsOpened.set(false)}
          openAssistant={openSession}
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
