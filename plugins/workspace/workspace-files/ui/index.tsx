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

import { cleanup, effect, inputAction, keymap, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import type {
  UiContext,
  UiActivation,
  UiHost,
  UiEmbeddedViewProps,
  UiToolProps,
  UiViewProps,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  workspaceViewContract,
  type WorkspaceViewHandle,
  type WorkspaceViewInput,
} from '../../../../packages/plugin-sdk/src/workspace-view.js';
import { currentLocale, tr } from '../../../../products/maka/workbench/app/locale';
import {
  createCurrentDiff,
  CurrentDiff,
  type CurrentDiffTarget,
} from '../../../../products/maka/workbench/app/CurrentDiff';
import {
  bodyTextStyle,
  C,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
} from '../../../../products/maka/workbench/app/ui';
import { WorkspaceChanges } from './WorkspaceChanges';
import { SearchCapture } from './SearchCapture';
import { createResources } from './resources';
import { ResourcePane } from './ResourcePane';
import { ImageViewer } from '../../../../products/maka/workbench/app/ImageViewer';
import { createHost, HostProvider, useHost } from '../../../../products/maka/workbench/app/host';

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
          key={(value) => `${value.sessionId}/${value.area}/${value.path.bytesBase64}`}
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
    selected: () => input()?.selected() ?? null,
    blocked: () => input()?.blocked() ?? true,
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
    openImage: resources.openImage,
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
                <If when={resources.shown() && resources.sessionId() !== null}>
                  <ResourcePane resources={resources} docked={next.docked} />
                </If>
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
        run() {
          context.openPanel('changes');
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
