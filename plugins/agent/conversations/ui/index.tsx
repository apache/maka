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

import { cleanup, effect, signal, Storage, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import type { AgentSession } from '../../../../packages/plugin-sdk/src/index.js';
import type {
  UiCommandContext,
  UiExports,
  UiModule,
  UiEmbeddedViewProps,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  conversationNavigationView,
  conversationSessionView,
  conversationPreviewView,
  roomWorkspaceView,
  type RoomWorkspaceInput,
  type ConversationNavigationInput,
  type ConversationSessionInput,
  type ConversationPreviewInput,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { createConversationUi, type ConversationWindow } from './SessionSurface';
import { invokeFocusedConversation } from '../../../../products/maka/workbench/app/conversationCommands';
import type { WorkspaceViewHandle } from '../../../../packages/plugin-sdk/src/workspace-view.js';
import { RoomView } from './RoomView';
import { createHost, HostProvider } from '../../../../products/maka/workbench/app/host';
import {
  createRoomPeople,
  RoomTimeline,
} from '../../../../products/maka/workbench/app/RoomWorkspace';
import type { RoomComposerHandle } from '../../../../products/maka/workbench/app/RoomComposer';
import { LoadingIndicator } from '../../../../products/maka/workbench/app/Loading';
import { tr } from '../../../../products/maka/workbench/app/locale';
import { C, controlStyle, Header } from '../../../../products/maka/workbench/app/ui';
import { createText, errorText } from '../../../../products/maka/workbench/app/text';

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  const host = createHost(context.application);
  const sides = signal<ReturnType<typeof createConversationUi>[]>([]);
  const rooms = signal<{ id: string; flush(): Promise<void> }[]>([]);
  const actionUsage = new Map<string, ReturnType<ConversationWindow['projectActionUsage']>>();
  const window: ConversationWindow = {
    workspace: signal<WorkspaceViewHandle | null>(null),
    projectActionUsage(projectId) {
      const existing = actionUsage.get(projectId);
      if (existing) return existing;
      const key = `project-action-last-used/${projectId}`;
      const lastUsed = signal<string | null | undefined>(undefined);
      const usage = {
        lastUsed,
        record(actionId: string) {
          lastUsed.set(actionId);
          void Storage.setItem(key, actionId).catch((reason: unknown) => {
            console.warn('Could not save the last used Project Action', reason);
          });
        },
      };
      actionUsage.set(projectId, usage);
      void Storage.getItem(key).then(
        (stored) => {
          if (lastUsed() === undefined) lastUsed.set(stored);
        },
        (reason: unknown) => {
          if (lastUsed() === undefined) lastUsed.set(null);
          console.warn('Could not read the last used Project Action', reason);
        },
      );
      return usage;
    },
    sessions: () => [
      ...[views, ...sides()].flatMap((pane) => {
        const id = pane.sessionId();
        return id === null ? [] : [id];
      }),
      ...rooms().map((room) => room.id),
    ],
    command: (id) => invokeFocusedConversation([views, ...sides()], id),
    prompt: (sessionId, action) =>
      [views, ...sides()].find((pane) => pane.sessionId() === sessionId)?.deliverPrompt(action) ??
      false,
  };
  const views = createConversationUi(context, host, window);
  const owner = (sessionId: string | null) =>
    [views, ...sides()].find((pane) => pane.sessionId() === sessionId);
  const Navigation = (props: { input: ConversationNavigationInput<JSX.Element> }) =>
    views.navigation(props.input);
  const AgentSide = (props: { input: ConversationSessionInput }) => {
    const side = createConversationUi(context, host, window, { browsing: views.browsing });
    sides.set([...sides(), side]);
    cleanup(() => sides.set(sides().filter((pane) => pane !== side)));
    return side.session(props.input);
  };
  const SplitHeader = (props: { title: string; close(): void }) => (
    <Header
      title={props.title}
      commands={() => {}}
      browser={{
        navigationDocked: true,
        previewDocked: false,
        expanded: true,
        hidden: false,
        toggle() {},
        close: props.close,
      }}
    />
  );
  const RoomSide = (props: { room: AgentSession; input: ConversationSessionInput }) => {
    const people = createRoomPeople(host);
    const { shell } = props.input;
    const id = props.room.id;
    let composer: RoomComposerHandle | null = null;
    const pane = { id, flush: () => composer?.flush() ?? Promise.resolve() };
    rooms.set([...rooms(), pane]);
    cleanup(() => rooms.set(rooms().filter((room) => room !== pane)));
    const title = () => props.room.title;
    props.input.attach({
      ...views.sessionHandle,
      title,
      async leave() {
        await pane.flush();
        return true;
      },
    });
    return (
      <View style={{ flex: 1, minHeight: 0 }}>
        <SplitHeader title={title()} close={shell.closePane!} />
        <RoomTimeline
          sessionId={id}
          host={host}
          visible={shell.visible}
          name={people.name}
          resolveNames={people.resolveNames}
          searchSessions={people.searchSessions}
          openAgent={(id) => void shell.openSession(id)}
          openLink={async (target, restoreFocus) => {
            const workspace = window.workspace();
            if (!workspace) throw new Error(tr('Workspace preview is unavailable.'));
            await workspace.openLink(id, target, restoreFocus);
          }}
          attach={(handle) => {
            composer = handle;
          }}
        />
      </View>
    );
  };
  const Split = (props: { input: ConversationSessionInput }) => {
    const { shell } = props.input;
    const target = signal<AgentSession | null>(null);
    const failure = createText();
    let alive = true;
    cleanup(() => {
      alive = false;
    });
    const resolve = async (sessionId: string) => {
      failure.set('');
      try {
        const { session } = await host.query('agent', 'observe', { sessionId });
        if (alive && shell.sessionId() === sessionId) target.set(session);
      } catch (reason) {
        if (alive && shell.sessionId() === sessionId)
          failure.set(errorText(reason, 'Could not open the conversation.'));
      }
    };
    effect(() => {
      const id = shell.sessionId();
      if (id) void resolve(id);
    });
    const agentInput = {
      ...props.input,
      shell: { ...shell, sessionId: () => target()?.id ?? null },
    };
    return (
      <If
        when={target() && !failure()}
        else={
          <View style={{ flex: 1 }}>
            <SplitHeader title="" close={shell.closePane!} />
            <If when={failure()} else={<LoadingIndicator />}>
              <Text style={{ color: C.warning, padding: 12 }}>{failure()}</Text>
              <Button style={controlStyle} onPress={() => void resolve(shell.sessionId()!)}>
                <Text>{tr('Retry')}</Text>
              </Button>
            </If>
          </View>
        }
      >
        <If when={target()?.kind === 'room'} else={<AgentSide input={agentInput} />}>
          <Each of={(props.input.active?.() ?? true) ? [target()!] : []} key={(room) => room.id}>
            {(room) => <RoomSide room={room()} input={props.input} />}
          </Each>
        </If>
      </If>
    );
  };
  const Session = (props: { input: ConversationSessionInput }) => {
    const { shell } = props.input;
    if (!shell.closePane) return views.session(props.input);
    if (props.input.compact) return <AgentSide input={props.input} />;
    return <Split input={props.input} />;
  };
  const Preview = (props: { input: ConversationPreviewInput }) => views.preview(props.input);
  const commands: UiExports<JSX.Element> = Object.fromEntries(
    [
      'commands',
      'browse',
      'sessions',
      'find',
      'new',
      'bot',
      'workspace',
      'models',
      'settings',
      'files',
      'compact',
      'goal',
      'latest',
      'history-focus',
      'activity-focus',
      'stop',
      'queue',
    ].map((id) => [
      id,
      {
        kind: 'command' as const,
        enabled: (input: UiCommandContext) => owner(input.sessionId)?.enabled(id) ?? false,
        run: (input: UiCommandContext) => owner(input.sessionId)?.run(id, input.argument),
      },
    ]),
  );
  return {
    exports: {
      ...commands,
      rooms: {
        kind: 'view',
        contract: roomWorkspaceView.id,
        render({ input }: UiEmbeddedViewProps<RoomWorkspaceInput<JSX.Element>, JSX.Element>) {
          return <RoomView host={host} input={input} />;
        },
      },
      navigation: {
        kind: 'view',
        contract: conversationNavigationView.id,
        render({
          input,
        }: UiEmbeddedViewProps<ConversationNavigationInput<JSX.Element>, JSX.Element>) {
          return (
            <HostProvider value={host}>
              <Navigation input={input} />
            </HostProvider>
          );
        },
      },
      session: {
        kind: 'view',
        contract: conversationSessionView.id,
        render({ input }: UiEmbeddedViewProps<ConversationSessionInput, JSX.Element>) {
          return (
            <HostProvider value={host}>
              <Session input={input} />
            </HostProvider>
          );
        },
      },
      preview: {
        kind: 'view',
        contract: conversationPreviewView.id,
        render({ input }: UiEmbeddedViewProps<ConversationPreviewInput, JSX.Element>) {
          return (
            <HostProvider value={host}>
              <Preview input={input} />
            </HostProvider>
          );
        },
      },
    },
    prepareReload: async () => {
      await Promise.all([
        ...[views, ...sides()].map((pane) => pane.prepareReload()),
        ...rooms().map((room) => room.flush()),
      ]);
    },
  };
};
