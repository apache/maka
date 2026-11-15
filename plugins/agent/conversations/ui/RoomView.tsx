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

import { effect, keymap, signal, type JSX } from 'nsh';
import type { RoomWorkspaceInput } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { createRoomWorkspace } from '../../../../products/maka/workbench/app/RoomWorkspace';
import {
  Workbench,
  canDockBrowser,
  canDockPreview,
} from '../../../../products/maka/workbench/app/Workbench';
import { HostProvider, type Host } from '../../../../products/maka/workbench/app/host';
import { ImageViewer } from '../../../../products/maka/workbench/app/ImageViewer';
import { createResources } from '../../../workspace/workspace-files/ui/resources';
import { ResourcePane } from '../../../workspace/workspace-files/ui/ResourcePane';

export function RoomView(props: { host: Host; input: RoomWorkspaceInput<JSX.Element> }) {
  const input = props.input;
  const selected = signal(input.initialSessionId);
  const resources = createResources(props.host, {
    sessions: () => (selected() === null ? [] : [selected()!]),
    blocked: () => input.blocked() || !input.visible(),
    directory: () => rooms.directory(),
    report: (reason) => rooms.report(reason),
  });
  const rooms = createRoomWorkspace({
    host: props.host,
    initial: input.initialSessionId,
    agentSession: input.agentSessionId,
    visible: input.visible,
    browser: () => ({
      navigationDocked: canDockBrowser(resources.shown()),
      previewDocked: resources.shown() && canDockPreview(),
      expanded: input.sidebarExpanded(),
      hidden: !input.visible(),
      toggle: () => input.setSidebarExpanded(!input.sidebarExpanded()),
    }),
    openAgent: input.openSession,
    openSettings: input.openSettings,
    openLink: resources.openLink,
  });
  effect(() => selected.set(rooms.selected()));
  input.attach(rooms);
  const closePreview = () => {
    const sessionId = resources.sessionId();
    if (sessionId) resources.close({ sessionId, instance: resources.instance() });
  };
  return (
    <HostProvider value={props.host}>
      <Workbench
        expanded={input.sidebarExpanded}
        previewShown={resources.shown}
        previewSuppressed={() => resources.imageViewer() !== null}
        previewFocused={() => {
          const root = resources.root();
          return root !== undefined && keymap.focusedWithin(root);
        }}
        closePreview={closePreview}
        navigation={() => rooms.navigation(input.modeSwitch())}
        preview={(docked) => (
          <Each
            of={resources.shown() && resources.sessionId() ? [resources.instance()] : []}
            key={(id) => id}
          >
            {() => <ResourcePane resources={resources} docked={docked} />}
          </Each>
        )}
      >
        {rooms.content()}
      </Workbench>
      <Each of={resources.imageViewer() ? [resources.imageViewer()!] : []} key={(viewer) => viewer}>
        {(viewer) => <ImageViewer image={viewer().image} close={viewer().close} />}
      </Each>
    </HostProvider>
  );
}
