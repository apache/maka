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

import { tr } from './locale';
import { effect, inputAction, signal, View, type JSX } from 'nsh';
import { windowSize } from 'nsh/device';
import { keymap } from 'nsh/keymap';
import { Dialog } from 'nsh/base';
import { C } from './ui';
import { dialogTop, docked } from './chrome';
import { WorkspaceBrowser, type WorkspaceBrowserProps } from './WorkspaceBrowser';
import { ResourcePane } from './ResourcePane';
import { ImageViewer } from './ImageViewer';
import type { Resources } from './resources';

const CELL = 8;
const CENTER_MIN = 72 * CELL;
const BROWSER_MIN = 24 * CELL;
const BROWSER_MAX = 40 * CELL;
const PREVIEW_MIN = 40 * CELL;

export const canDockBrowser = () => windowSize().width >= CENTER_MIN + BROWSER_MIN + CELL;
// Current layout policy, not a claim that narrower terminal columns are impossible.
const canDockPreview = () => windowSize().width >= CENTER_MIN + PREVIEW_MIN + CELL;

export function Workbench(props: {
  expanded(): boolean;
  browser: WorkspaceBrowserProps;
  resources: Resources;
  children: JSX.Element;
}) {
  const preferredWidth = signal(32 * CELL);
  const preferredPreviewWidth = signal(48 * CELL);
  const preview = () => props.resources.shown() && canDockPreview();
  const browser = () =>
    canDockBrowser() &&
    props.expanded() &&
    (!preview() || windowSize().width >= CENTER_MIN + BROWSER_MIN + PREVIEW_MIN + 2 * CELL);
  const width = () =>
    Math.min(
      preferredWidth(),
      windowSize().width - CENTER_MIN - CELL - (preview() ? PREVIEW_MIN + CELL : 0),
    );
  const availablePreviewWidth = () =>
    windowSize().width - CENTER_MIN - CELL - (browser() ? width() + CELL : 0);
  const previewWidth = () => Math.min(preferredPreviewWidth(), availablePreviewWidth());
  const clamp = (value: number) =>
    Math.max(
      BROWSER_MIN,
      Math.min(
        BROWSER_MAX,
        windowSize().width - CENTER_MIN - CELL,
        Math.round(value / CELL) * CELL,
      ),
    );
  let drag: {
    side: 'browser' | 'preview';
    x: number;
    width: number;
    viewport: number;
  } | null = null;
  const moveDivider = (x: number) => {
    if (!drag || drag.viewport !== windowSize().width) return;
    if (drag.side === 'browser' && browser()) preferredWidth.set(clamp(drag.width + x - drag.x));
    else if (drag.side === 'preview' && preview())
      preferredPreviewWidth.set(
        Math.max(
          PREVIEW_MIN,
          Math.min(availablePreviewWidth(), Math.round(drag.width + drag.x - x)),
        ),
      );
  };
  effect(() => {
    windowSize().width;
    windowSize().height;
    browser();
    preview();
    drag = null;
  });
  effect(() => {
    docked.browser.set(browser());
    docked.preview.set(preview());
  });
  const resize = (delta: number) => preferredWidth.set(clamp(width() + delta * CELL));
  const previewDialog = signal(false);
  let wasPreviewDocked = canDockPreview();
  effect(() => {
    const docked = canDockPreview();
    const root = props.resources.root();
    if (!props.resources.shown() || docked || props.resources.imageViewer())
      previewDialog.set(false);
    else if (!wasPreviewDocked || (root && keymap.focusedWithin(root))) previewDialog.set(true);
    else {
      props.resources.hide();
      previewDialog.set(false);
    }
    wasPreviewDocked = docked;
  });
  return (
    <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
      <If when={browser()}>
        <View style={{ width: width(), flexShrink: 0, backgroundColor: C.surface }}>
          <WorkspaceBrowser {...props.browser} docked resize={resize} />
        </View>
        <View
          accessibilityLabel={tr('Resize session browser')}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(event) => {
            drag = {
              side: 'browser',
              x: event.pageX,
              width: width(),
              viewport: windowSize().width,
            };
            return true;
          }}
          onResponderMove={(event) => moveDivider(event.pageX)}
          onResponderRelease={(event) => {
            moveDivider(event.pageX);
            drag = null;
          }}
          onResponderTerminate={() => {
            drag = null;
          }}
          style={{
            width: CELL,
            flexShrink: 0,
            alignItems: 'center',
            backgroundColor: C.background,
            cursor: 'col-resize',
          }}
          hoverStyle={{ backgroundColor: C.line }}
        >
          <View
            pointerEvents="none"
            style={{ width: 1, height: '100%', backgroundColor: C.line }}
          />
        </View>
      </If>
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{props.children}</View>
      <If when={preview()}>
        <View
          accessibilityLabel={tr('Resize workspace preview')}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(event) => {
            drag = {
              side: 'preview',
              x: event.pageX,
              width: previewWidth(),
              viewport: windowSize().width,
            };
            return true;
          }}
          onResponderMove={(event) => moveDivider(event.pageX)}
          onResponderRelease={(event) => {
            moveDivider(event.pageX);
            drag = null;
          }}
          onResponderTerminate={() => {
            drag = null;
          }}
          style={{
            width: CELL,
            flexShrink: 0,
            alignItems: 'center',
            backgroundColor: C.background,
            cursor: 'col-resize',
          }}
          hoverStyle={{ backgroundColor: C.line }}
        >
          <View
            pointerEvents="none"
            style={{ width: 1, height: '100%', backgroundColor: C.line }}
          />
        </View>
        <View style={{ width: previewWidth(), flexShrink: 0, minHeight: 0 }}>
          <ResourcePane resources={props.resources} docked />
        </View>
      </If>
      <If when={previewDialog()}>
        <Dialog
          animation="none"
          onOpenChange={inputAction(props.resources.close, {
            sessionId: props.resources.sessionId()!,
            instance: props.resources.instance(),
          })}
          style={{ flex: 1, padding: 8, paddingTop: dialogTop(8), backgroundColor: '#000000cc' }}
        >
          <ResourcePane resources={props.resources} docked={false} />
        </Dialog>
      </If>
      <Each
        of={props.resources.imageViewer() ? [props.resources.imageViewer()!] : []}
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
    </View>
  );
}
