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

import { effect, inputAction, signal, View, platform, windowSize, type JSX } from 'nsh';
import { Dialog, ResizablePanel, ResizablePanelGroup } from 'nsh/base';
import { C } from './ui';
import { tr } from './locale';
import { dialogTop } from './chrome';

const CELL = 8;
const CENTER_DOCK_WIDTH = 72 * CELL;
const CENTER_MIN = 48 * CELL;
const BROWSER_MIN = 24 * CELL;
const BROWSER_MAX = 40 * CELL;
const PREVIEW_MIN = 40 * CELL;
const GAP = platform.isTerminal ? CELL : 0;

export const canDockBrowser = (withPreview = false) =>
  windowSize().width >=
  CENTER_DOCK_WIDTH + BROWSER_MIN + GAP + (withPreview && canDockPreview() ? PREVIEW_MIN + GAP : 0);
export const canDockPreview = () => windowSize().width >= CENTER_DOCK_WIDTH + PREVIEW_MIN + GAP;
/** The most conversations the desktop shows beside the selected one. */
export const SIDE_PANES = 3;
/** How many side panes fit at their minimum width beside the selected conversation. */
export const sidePaneRoom = (browser: boolean) =>
  Math.max(1, Math.floor((windowSize().width - (browser ? BROWSER_MIN : 0)) / CENTER_MIN) - 1);

export function Workbench(props: {
  expanded(): boolean;
  previewShown(): boolean;
  previewSuppressed(): boolean;
  previewFocused(): boolean;
  closePreview(): void;
  navigation(): JSX.Element;
  preview(docked: boolean): JSX.Element;
  /** Conversations beside the first, one per fixed slot, while each is open. */
  sides?: { shown(): boolean; render(): JSX.Element }[];
  children: JSX.Element;
}) {
  const preferredWidth = signal(32 * CELL);
  const preferredPreviewWidth = signal(48 * CELL);
  const preview = () => props.previewShown() && canDockPreview();
  const browser = () => props.expanded() && canDockBrowser(props.previewShown());
  // A side pane stays mounted while it is open and shows, left to right,
  // while every conversation up to it keeps its minimum width.
  const sideVisible = (slot: number) => {
    const sides = props.sides ?? [];
    if (!sides[slot]?.shown()) return false;
    const rank = sides.slice(0, slot + 1).filter((side) => side.shown()).length;
    return windowSize().width >= (rank + 1) * CENTER_MIN + (browser() ? BROWSER_MIN : 0);
  };
  const previewDialog = signal(false);
  let wasDocked = canDockPreview();
  effect(() => {
    const nowDocked = canDockPreview();
    if (!props.previewShown() || nowDocked || props.previewSuppressed()) previewDialog.set(false);
    else if (!wasDocked || props.previewFocused()) previewDialog.set(true);
    else {
      props.closePreview();
      previewDialog.set(false);
    }
    wasDocked = nowDocked;
  });
  return (
    <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
      <ResizablePanelGroup
        axis="horizontal"
        handleAccessibilityLabel={tr('Resize workspace panels')}
        handleStyle={{ backgroundColor: C.line }}
        style={{ flex: 1, minWidth: 0, minHeight: 0, gap: GAP }}
      >
        <ResizablePanel
          visible={browser()}
          size={preferredWidth()}
          minSize={BROWSER_MIN}
          maxSize={BROWSER_MAX}
          onResize={({ size }) => preferredWidth.set(size)}
          style={{ minHeight: 0, backgroundColor: C.surface }}
        >
          <If when={browser()}>{props.navigation()}</If>
        </ResizablePanel>
        <ResizablePanel minSize={CENTER_MIN} style={{ minHeight: 0 }}>
          {props.children}
        </ResizablePanel>
        <Each of={(props.sides ?? []).map((_, slot) => slot)} key={(slot) => slot}>
          {(slot) => {
            const pane = props.sides![slot()]!;
            return (
              <ResizablePanel
                visible={sideVisible(slot())}
                minSize={CENTER_MIN}
                style={{ minHeight: 0 }}
              >
                <If when={pane.shown()}>{pane.render()}</If>
              </ResizablePanel>
            );
          }}
        </Each>
        <ResizablePanel
          visible={preview()}
          size={preferredPreviewWidth()}
          minSize={PREVIEW_MIN}
          onResize={({ size }) => preferredPreviewWidth.set(size)}
          style={{ minHeight: 0 }}
        >
          <If when={preview()}>{props.preview(true)}</If>
        </ResizablePanel>
      </ResizablePanelGroup>
      <If when={previewDialog()}>
        <Dialog
          animation="none"
          onOpenChange={inputAction(props.closePreview, null)}
          style={{ flex: 1, padding: 8, paddingTop: dialogTop(8), backgroundColor: C.scrim }}
        >
          {props.preview(false)}
        </Dialog>
      </If>
    </View>
  );
}
