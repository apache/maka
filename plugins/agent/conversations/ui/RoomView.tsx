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

import { effect, keymap, signal, View, type JSX } from 'nsh';
import { Dialog } from 'nsh/base';
import type { RoomWorkspaceInput } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { createRoomWorkspace } from '../../../../products/maka/workbench/app/RoomWorkspace';
import {
  Workbench,
  canDockBrowser,
  canDockPreview,
  createPreviewDialog,
  createSidebarHover,
} from '../../../../products/maka/workbench/app/Workbench';
import { HostProvider, type Host } from '../../../../products/maka/workbench/app/host';
import { ImageViewer } from '../../../../products/maka/workbench/app/ImageViewer';
import { C, Header } from '../../../../products/maka/workbench/app/ui';
import { PANEL_INSET } from '../../../../products/maka/workbench/app/chrome';
import { tr } from '../../../../products/maka/workbench/app/locale';
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
  const navigationFits = () => canDockBrowser(resources.shown());
  const navigationDocked = () => input.sidebarExpanded() && navigationFits();
  const floatingNavigation = signal(false);
  const sidebarHover = createSidebarHover(
    () => !navigationDocked() && !floatingNavigation() && input.visible() && !input.blocked(),
  );
  const closeNavigation = () => floatingNavigation.set(false);
  const toggleNavigation = () => {
    if (input.blocked() || !input.visible()) return;
    if (navigationFits()) input.setSidebarExpanded(!navigationDocked());
    else floatingNavigation.set(!floatingNavigation());
  };
  const previewDocked = () => resources.shown() && canDockPreview();
  effect(() => {
    if (navigationFits() || !input.visible()) closeNavigation();
  });
  const rooms = createRoomWorkspace({
    host: props.host,
    initial: input.initialSessionId,
    agentSession: input.agentSessionId,
    active: input.active,
    visible: input.visible,
    browser: () => ({
      navigationDocked: navigationDocked(),
      previewDocked: previewDocked(),
      expanded: navigationDocked(),
      hidden: !input.visible() || floatingNavigation(),
      toggle: toggleNavigation,
      sidebarHover: sidebarHover.hover,
    }),
    closeNavigation,
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
  const previewDialog = createPreviewDialog({
    shown: resources.shown,
    suppressed: () => resources.imageViewer() !== null,
    focused: () => {
      const root = resources.root();
      return root !== undefined && keymap.focusedWithin(root);
    },
    close: closePreview,
  });
  return (
    <HostProvider value={props.host}>
      <Workbench
        expanded={input.sidebarExpanded}
        sidebarHover={sidebarHover}
        previewShown={resources.shown}
        previewDialog={previewDialog}
        closePreview={closePreview}
        navigation={(temporary) =>
          rooms.navigation(
            input.modeSwitch(),
            temporary ? toggleNavigation : undefined,
            sidebarHover.suppressUntilExit,
          )
        }
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
      <If when={input.visible() && !navigationFits() && floatingNavigation()}>
        <Dialog
          animation="none"
          onOpenChange={closeNavigation}
          style={{ flex: 1, backgroundColor: C.scrim }}
        >
          <View style={{ flex: 1, width: '100%', maxWidth: 320, backgroundColor: C.chrome }}>
            <View style={{ paddingTop: PANEL_INSET }}>
              <Header
                title={tr('Rooms')}
                browser={{
                  navigationDocked: false,
                  previewDocked: false,
                  expanded: true,
                  hidden: false,
                  toggle: closeNavigation,
                }}
                commands={() => {}}
              />
            </View>
            {rooms.navigation(input.modeSwitch())}
          </View>
        </Dialog>
      </If>
      <Each of={resources.imageViewer() ? [resources.imageViewer()!] : []} key={(viewer) => viewer}>
        {(viewer) => <ImageViewer image={viewer().image} close={viewer().close} />}
      </Each>
    </HostProvider>
  );
}
