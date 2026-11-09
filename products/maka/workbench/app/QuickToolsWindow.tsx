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

import { host, signal, effect, Text, View, type JSX } from 'nsh';
import type { UiRootProps } from '../../../../packages/plugin-sdk/src/workbench';
import type { UiTarget } from '../../../../packages/plugin-sdk/src/generated/runtime';
import {
  conversationSessionView,
  settingsViewContract,
  type ConversationShell,
  type ConversationSessionHandle,
} from '../../../../packages/plugin-sdk/src/workbench-views';
import { QuickToolsSurface } from './QuickTools';
import { currentLocale } from './locale';
import { qt } from '../../../../plugins/application/quick-tools/shared/i18n';
import { C, bodyTextStyle, IconButton } from './ui';

export function QuickToolsWindow(props: UiRootProps<JSX.Element>) {
  const { runtime, context } = props;
  const configuration = context.configuration as unknown as {
    session: UiTarget;
    settings: UiTarget;
  };
  const shown = signal(false),
    assistant = signal<string | null>(null),
    owner = signal<ConversationSessionHandle | null>(null);
  const error = signal(''),
    settings = signal(false);
  effect(() => currentLocale.set(runtime.locale()));
  effect(() => {
    if (shown() && (assistant() || settings()))
      void host
        .call('quickTools.resize', { height: 560 })
        .catch((cause) => error.set(String(cause)));
  });
  const leave = async () => {
    if (owner() && !(await owner()!.leave())) return false;
    assistant.set(null);
    owner.set(null);
    return true;
  };
  let visibilityRevision = 0;
  host.on('quickTools.visibility', async (value) => {
    const revision = ++visibilityRevision;
    const event = value as { visible: boolean; home?: boolean; settings?: boolean };
    if (event.visible && event.home) {
      try {
        // Leave through the session owner so the assistant draft is saved first.
        if (!assistant() || (await leave())) settings.set(false);
      } catch (cause) {
        error.set(String(cause));
      }
    }
    if (revision === visibilityRevision) {
      shown.set(event.visible);
      if (event.settings && !assistant()) openToolSettings?.();
    }
  });
  host.on('quickTools.session.release', async (value) => {
    const request = value as { sessionId: string; token: string };
    let ok = true;
    try {
      if (assistant() === request.sessionId) ok = await leave();
    } catch (cause) {
      error.set(String(cause));
      ok = false;
    }
    await host.call('quickTools.session.reply', { token: request.token, ok });
  });
  const claim = async (sessionId: string) => {
    await host.call('quickTools.session.claim', { sessionId });
  };
  let openToolSettings: (() => void) | undefined;
  const shell: ConversationShell = {
    sessionId: assistant,
    visible: () => shown() && !settings(),
    headerShown: () => false,
    quickToolsBack: () => {
      void leave().catch((cause) => error.set(String(cause)));
    },
    quickToolsBar: {
      openSettings: () => {
        void leave()
          .then((ok) => {
            if (ok) openToolSettings?.();
          })
          .catch((cause) => error.set(String(cause)));
      },
    },
    blocked: () => runtime.reloading(),
    connectionLost: () => runtime.updateError() !== null,
    openSession: async (id) => {
      if (id) await claim(id);
      if (!(await leave())) return false;
      assistant.set(id);
      return true;
    },
    openSettings: () => settings.set(true),
    sidebarShown: () => false,
    sidebarDocked: () => false,
    previewDocked: () => false,
    showSidebar() {},
    hideSidebar() {},
    dismissRoute: () => {
      if (settings()) {
        settings.set(false);
        return true;
      }
      return false;
    },
  };
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: C.surface }}>
      <QuickToolsSurface
        opened={() => shown() && !assistant() && !settings()}
        close={() => {
          void host.call('quickTools.hide', {});
        }}
        prepareAssistant={claim}
        beforeItemShortcut={async () => {
          if (assistant() && !(await leave())) return false;
          settings.set(false);
          return true;
        }}
        attachSettings={(open) => {
          openToolSettings = open;
        }}
        keepOpenAfterAssistant
        openAssistant={async (id) => {
          assistant.set(id);
          return true;
        }}
      />
      <If when={settings()}>
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: 12,
            paddingVertical: 6,
            alignItems: 'center',
            gap: 8,
            borderBottomWidth: 1,
            borderColor: C.line,
          }}
        >
          <IconButton
            label={qt('返回')}
            icon="back"
            onPress={() => {
              if (settings()) settings.set(false);
              else void leave().catch((cause) => error.set(String(cause)));
            }}
          />
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.text, flex: 1 }}>
            {qt('个人助手')}
          </Text>
          <IconButton
            label={qt('关闭')}
            icon="close"
            onPress={() => {
              void host.call('quickTools.hide', {});
            }}
          />
        </View>
      </If>
      <If when={error()}>
        <Text style={{ ...bodyTextStyle, color: C.danger }}>{error()}</Text>
      </If>
      <If when={assistant()}>
        <View style={{ display: settings() ? 'none' : 'flex', flex: 1, minHeight: 0 }}>
          {runtime.renderView(configuration.session, conversationSessionView, {
            shell,
            attach: (handle) => owner.set(handle),
          })}
        </View>
      </If>
      <If when={settings()}>
        {runtime.renderView(configuration.settings, settingsViewContract, {
          opened: settings,
          close: () => settings.set(false),
          changed() {},
        })}
      </If>
    </View>
  );
}
