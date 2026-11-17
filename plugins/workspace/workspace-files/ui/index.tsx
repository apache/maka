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

import { cleanup, effect, inputAction, type JSX, keymap, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type {
  UiActivation,
  UiCommandContext,
  UiContext,
  UiEmbeddedViewProps,
  UiHost,
  UiToolProps,
  UiViewProps,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  type WorkspaceViewHandle,
  type WorkspaceViewInput,
  workspaceViewContract,
} from '../../../../packages/plugin-sdk/src/workspace-view.js';
import {
  CurrentDiff,
  type CurrentDiffTarget,
  createCurrentDiff,
} from '../../../../products/maka/workbench/app/CurrentDiff';
import { currentDiffTargetKey } from '../../../../products/maka/workbench/app/currentDiffState';
import { createHost, HostProvider, useHost } from '../../../../products/maka/workbench/app/host';
import { ImageViewer } from '../../../../products/maka/workbench/app/ImageViewer';
import { currentLocale, tr } from '../../../../products/maka/workbench/app/locale';
import {
  bodyTextStyle,
  C,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
} from '../../../../products/maka/workbench/app/ui';
import { ResourcePane } from './ResourcePane';
import { createResources } from './resources';
import { SearchCapture } from './SearchCapture';
import { WorkspaceChanges } from './WorkspaceChanges';

function ChangesPanel(props: UiViewProps) {
  return (
    <If
      when={props.sessionId !== null}
      else={
        <Text style={{ ...bodyTextStyle, color: C.muted }}>
          {tr('Select a conversation to browse its workspace.')}
        </Text>
      }
    >
      <Each of={props.sessionId === null ? [] : [props.sessionId]} key={(id) => id}>
        {(sessionId) => (
          <WorkspaceChanges
            sessionId={sessionId()}
            openDiff={(target) => props.context.openPanel('change-diff', target)}
          />
        )}
      </Each>
    </If>
  );
}

function DiffPanel(props: UiViewProps) {
  const host = useHost();
  const target = () => props.input as CurrentDiffTarget | undefined;
  effect(() => {
    if (target()?.sessionId !== props.sessionId) props.context.openPanel('changes');
  });
  return (
    <If when={target()?.sessionId === props.sessionId}>
      <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
        <Button
          accessibilityLabel={tr('Changes')}
          onPress={() => props.context.openPanel('changes')}
          style={controlStyle}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Changes')}</Text>
        </Button>
        <Each
          of={target() === undefined ? [] : [target()!]}
          key={(value) => currentDiffTargetKey(value)}
        >
          {(value) => {
            const model = createCurrentDiff(host, value());
            cleanup(() => model.dispose());
            return <CurrentDiff model={model} />;
          }}
        </Each>
      </View>
    </If>
  );
}

export function activate(context: UiContext<UiHost, JSX.Element>): UiActivation<JSX.Element> {
  const host = createHost(context.application);
  effect(() => currentLocale.set(context.locale()));
  const input = signal<WorkspaceViewInput | null>(null);
  const resources = createResources(host, {
    sessions: () => input()?.sessions() ?? [],
    blocked: () => input()?.blocked() ?? true,
    directory: (id) => input()?.directory(id),
    canPrompt: () => input()?.prompt !== undefined,
    prompt: (sessionId, action) => input()?.prompt?.(sessionId, action) ?? false,
    report: (reason) => input()?.report(reason),
  });
  const handle: WorkspaceViewHandle = {
    shown: resources.shown,
    hide: resources.hide,
    close() {
      const sessionId = resources.sessionId();
      if (sessionId) resources.close({ sessionId, instance: resources.instance() });
    },
    focused() {
      const root = resources.root();
      return root !== undefined && keymap.focusedWithin(root);
    },
    modalSuppressed: () => resources.imageViewer() !== null,
    openFiles: resources.openFiles,
    openChanges: resources.openChanges,
    openImage: resources.openImage,
    openAgentTerminal: resources.openAgentTerminal,
    openLink: resources.openLink,
    attachOpener: resources.attachOpener,
  };
  return {
    exports: {
      workspace: {
        kind: 'view',
        contract: workspaceViewContract.id,
        render(props: UiEmbeddedViewProps<WorkspaceViewInput, JSX.Element>) {
          const next = props.input;
          input.set(next);
          next.attach(handle);
          if (next.surface === 'pane')
            return (
              <HostProvider value={host}>
                <Each
                  of={
                    resources.shown() && resources.sessionId() !== null
                      ? [resources.instance()]
                      : []
                  }
                  key={(instance) => instance}
                >
                  {() => <ResourcePane resources={resources} docked={next.docked} />}
                </Each>
              </HostProvider>
            );
          return (
            <HostProvider value={host}>
              <Each
                of={resources.imageViewer() ? [resources.imageViewer()!] : []}
                key={(viewer) => viewer}
              >
                {(viewer) => {
                  const current = viewer();
                  return (
                    <ImageViewer
                      image={current.image}
                      close={inputAction(current.close, {
                        sessionId: current.tab.sessionId,
                        instance: current.tab.instance,
                        uri: current.image.uri,
                      })}
                    />
                  );
                }}
              </Each>
            </HostProvider>
          );
        },
      },
      changes: {
        kind: 'panel',
        render: (props) => (
          <HostProvider value={host}>
            <ChangesPanel {...props} />
          </HostProvider>
        ),
      },
      'change-diff': {
        kind: 'panel',
        render: (props) => (
          <HostProvider value={host}>
            <DiffPanel {...props} />
          </HostProvider>
        ),
      },
      'show-changes': {
        kind: 'command',
        run(cmdCtx: UiCommandContext) {
          const sid = cmdCtx.sessionId ?? resources.sessionId();
          if (sid && (input()?.sessions() ?? []).includes(sid)) {
            resources.openChanges({ sessionId: sid });
          } else {
            context.openPanel('changes');
          }
        },
      },
      glob: {
        kind: 'tool_renderer',
        render: (props: UiToolProps) => (
          <HostProvider value={host}>
            <SearchCapture {...props} matches="files" />
          </HostProvider>
        ),
      },
      grep: {
        kind: 'tool_renderer',
        render: (props: UiToolProps) => (
          <HostProvider value={host}>
            <SearchCapture {...props} matches="matches" />
          </HostProvider>
        ),
      },
    },
  };
}
