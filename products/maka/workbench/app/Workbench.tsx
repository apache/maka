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
import { dialogTop, PANEL_INSET } from './chrome';

const CELL = 8;
const CENTER_DOCK_WIDTH = 72 * CELL;
const CENTER_MIN = 48 * CELL;
// As wide as a conversation's minimum, so the room for side panes counts a card as one.
const THREAD_WIDTH = CENTER_MIN;
const BROWSER_MIN = 24 * CELL;
const BROWSER_MAX = 40 * CELL;
const PREVIEW_MIN = 40 * CELL;
const GAP = platform.idiom === 'terminal' ? CELL : 0;
const INSET = platform.idiom === 'terminal' ? 0 : PANEL_INSET;
const available = () => windowSize().width - 2 * INSET;

export const canDockBrowser = (withPreview = false) =>
  available() >=
  CENTER_DOCK_WIDTH + BROWSER_MIN + GAP + (withPreview && canDockPreview() ? PREVIEW_MIN + GAP : 0);
export const canDockPreview = () => available() >= CENTER_DOCK_WIDTH + PREVIEW_MIN + GAP;
/** Side conversations that fit beside the selected one at the panels' minimum widths. */
export const sidePaneRoom = (browser: boolean, preview: boolean) =>
  Math.max(
    0,
    Math.floor(
      (available() - (browser ? BROWSER_MIN : 0) - (preview ? PREVIEW_MIN : 0)) / CENTER_MIN,
    ) - 1,
  );

export function Workbench(props: {
  expanded(): boolean;
  previewShown(): boolean;
  previewSuppressed(): boolean;
  previewFocused(): boolean;
  closePreview(): void;
  navigation(): JSX.Element;
  preview(docked: boolean): JSX.Element;
  /** Stable pane objects keep their mounted conversations through reorder and resize. */
  sides?(): readonly { render(): JSX.Element; thread?: boolean }[];
  /** Whether a side thread's card that has no pane yet is open. */
  cardShown?(): boolean;
  /** That card; it stands where its pane's card will. */
  card?(): JSX.Element | null;
  children: JSX.Element;
}) {
  const preferredWidth = signal(32 * CELL);
  const preferredPreviewWidth = signal(48 * CELL);
  const preview = () => props.previewShown() && canDockPreview();
  const browser = () => props.expanded() && canDockBrowser(props.previewShown());
  const room = () => sidePaneRoom(browser(), preview());
  const sides = () => props.sides?.() ?? [];
  const fits = (pane: { render(): JSX.Element }) => sides().indexOf(pane) < room();
  // A side thread's card stands in the selected conversation's panel, to its
  // right, as tall as what it holds: it takes a fixed width from that panel
  // rather than splitting the window with a second conversation.
  const cards = () => sides().filter((pane) => pane.thread && fits(pane));
  const pendingCard = () => sides().length < room() && (props.cardShown?.() ?? false);
  const cardStyle = {
    width: THREAD_WIDTH,
    minHeight: 0,
    paddingTop: 8,
    paddingRight: 8,
    paddingBottom: 8,
  } as const;
  const panes = () => (
    <>
      <ResizablePanel
        minSize={CENTER_MIN + (cards().length > 0 || pendingCard() ? THREAD_WIDTH : 0)}
        style={{ minHeight: 0 }}
      >
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: 'row' }}>
          <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{props.children}</View>
          <Each of={cards()} key={(pane) => pane}>
            {(pane) => <View style={cardStyle}>{pane().render()}</View>}
          </Each>
          <If when={pendingCard()}>
            <View style={cardStyle}>{props.card?.()}</View>
          </If>
        </View>
      </ResizablePanel>
      <Each of={sides().filter((pane) => !pane.thread)} key={(pane) => pane}>
        {(pane) => (
          <ResizablePanel visible={fits(pane())} minSize={CENTER_MIN} style={{ minHeight: 0 }}>
            {pane().render()}
          </ResizablePanel>
        )}
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
    </>
  );
  // The desktop's panel holds the panes, so it needs their minimums and its own insets.
  const panesMin = () =>
    CENTER_MIN * (1 + Math.min(room(), sides().length + (props.cardShown?.() ? 1 : 0))) +
    (preview() ? PREVIEW_MIN : 0) +
    INSET * (browser() ? 1 : 2);
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
        // On the desktop the sidebar and the panel part by fill alone.
        handleStyle={{ backgroundColor: platform.idiom === 'terminal' ? C.line : 'transparent' }}
        style={{ flex: 1, minWidth: 0, minHeight: 0, gap: GAP }}
      >
        <ResizablePanel
          visible={browser()}
          size={preferredWidth()}
          minSize={BROWSER_MIN}
          maxSize={BROWSER_MAX}
          onResize={({ size }) => preferredWidth.set(size)}
          style={{ minHeight: 0, backgroundColor: C.chrome }}
        >
          <If when={browser()}>{props.navigation()}</If>
        </ResizablePanel>
        {platform.idiom === 'terminal' ? (
          panes()
        ) : (
          <ResizablePanel minSize={panesMin()} style={{ minHeight: 0 }}>
            <View
              style={{
                flex: 1,
                minHeight: 0,
                margin: INSET,
                marginLeft: browser() ? 0 : INSET,
                borderRadius: 12,
                overflow: 'hidden',
                backgroundColor: C.panel,
              }}
            >
              <ResizablePanelGroup
                axis="horizontal"
                handleAccessibilityLabel={tr('Resize workspace panels')}
                handleStyle={{ backgroundColor: C.line }}
                style={{ flex: 1, minWidth: 0, minHeight: 0 }}
              >
                {panes()}
              </ResizablePanelGroup>
            </View>
          </ResizablePanel>
        )}
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
