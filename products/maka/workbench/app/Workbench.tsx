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
  cleanup,
  effect,
  inputAction,
  keymap,
  signal,
  View,
  platform,
  windowSize,
  type JSX,
} from 'nsh';
import { Dialog, ResizablePanel, ResizablePanelGroup } from 'nsh/base';
import { C } from './ui';
import { tr } from './locale';
import { dialogTop, PANEL_INSET } from './chrome';

const CELL = 8;
const CENTER_DOCK_WIDTH = 72 * CELL;
const CENTER_MIN = 48 * CELL;
const BROWSER_MIN = 24 * CELL;
const BROWSER_MAX = 40 * CELL;
const PREVIEW_MIN = 40 * CELL;
/** A side question's card: it takes this much of the selected conversation's panel. */
export const SIDE_CARD_WIDTH = 47 * CELL;
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

export function createPreviewDialog(props: {
  shown(): boolean;
  suppressed(): boolean;
  focused(): boolean;
  close(): void;
}) {
  const open = signal(false);
  let wasDocked = canDockPreview();
  effect(() => {
    const docked = canDockPreview();
    if (!props.shown() || docked || props.suppressed()) open.set(false);
    else if (!wasDocked || props.focused()) open.set(true);
    else {
      props.close();
      open.set(false);
    }
    wasDocked = docked;
  });
  return open;
}

/** The button and the temporary sidebar share one hover region across their gap. */
export function createSidebarHover(available: () => boolean) {
  const shown = signal(false);
  let waitForExit = false;
  let inside = false;
  let held = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);
  const close = () => {
    cancel();
    shown.set(false);
  };
  cleanup(cancel);
  effect(() => {
    if (!available()) close();
  });
  return {
    shown,
    close,
    suppressUntilExit() {
      waitForExit = true;
    },
    hold(active: boolean) {
      held = Math.max(0, held + (active ? 1 : -1));
      if (held > 0) cancel();
      else if (!inside && shown()) timer = setTimeout(close, 180);
    },
    hover(entered: boolean) {
      inside = entered;
      if (!entered) waitForExit = false;
      if (waitForExit) return;
      cancel();
      if (platform.idiom !== 'desktop' || !available()) return;
      if (entered) shown.set(true);
      else if (held === 0) timer = setTimeout(close, 180);
    },
  };
}

export function Workbench(props: {
  sidebarHover?: ReturnType<typeof createSidebarHover>;
  expanded(): boolean;
  previewShown(): boolean;
  previewFullscreen?(): boolean;
  togglePreviewFullscreen?(): void;
  floatingComposer?(): JSX.Element | null;
  previewDialog(): boolean;
  closePreview(): void;
  navigation(temporary?: boolean): JSX.Element;
  preview(docked: boolean): JSX.Element;
  /** Stable pane objects keep their mounted conversations through reorder and resize. */
  sides?(): readonly { render(): JSX.Element }[];
  /** A side question's card, in the selected conversation's panel at its right.
   * A stable object, so what it renders is mounted once. */
  card?(): { render(): JSX.Element } | null;
  children: JSX.Element;
}) {
  const preferredWidth = signal(32 * CELL);
  const preferredPreviewWidth = signal(platform.idiom === 'terminal' ? 48 * CELL : 62 * CELL);
  const preview = () => props.previewShown() && canDockPreview();
  const fullscreen = () => props.previewFullscreen?.() ?? false;
  const browser = () => props.expanded() && canDockBrowser(props.previewShown() && !fullscreen());
  const room = () => (fullscreen() ? 0 : sidePaneRoom(browser(), preview()));
  const card = () => (fullscreen() ? null : (props.card?.() ?? null));
  let unbindFullscreen: (() => void) | undefined;
  cleanup(() => unbindFullscreen?.());
  const panes = () => (
    <>
      <ResizablePanel
        visible={!fullscreen()}
        minSize={CENTER_MIN + (card() ? SIDE_CARD_WIDTH : 0)}
        style={{ minHeight: 0 }}
      >
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: 'row' }}>
          <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{props.children}</View>
          <Each of={card() ? [card()!] : []} key={(shown) => shown}>
            {(shown) => (
              <View
                style={{
                  width: SIDE_CARD_WIDTH,
                  minHeight: 0,
                  paddingTop: 12,
                  paddingRight: 12,
                  paddingBottom: 12,
                }}
              >
                {shown().render()}
              </View>
            )}
          </Each>
        </View>
      </ResizablePanel>
      <Each of={props.sides?.() ?? []} key={(pane) => pane}>
        {(pane, index) => (
          <ResizablePanel
            visible={!fullscreen() && index() < room()}
            minSize={CENTER_MIN}
            style={{ minHeight: 0 }}
          >
            {pane().render()}
          </ResizablePanel>
        )}
      </Each>
      <ResizablePanel
        visible={preview()}
        size={fullscreen() ? undefined : preferredPreviewWidth()}
        minSize={PREVIEW_MIN}
        onResize={({ size }) => {
          if (!fullscreen()) preferredPreviewWidth.set(size);
        }}
        style={{ minHeight: 0 }}
      >
        <If when={preview()}>{props.preview(true)}</If>
      </ResizablePanel>
    </>
  );
  // The desktop's panel holds the panes, so it needs their minimums and its own insets.
  const panesMin = () =>
    (fullscreen()
      ? PREVIEW_MIN
      : CENTER_MIN * (1 + Math.min(room(), props.sides?.().length ?? 0)) +
        (card() ? SIDE_CARD_WIDTH : 0) +
        (preview() ? PREVIEW_MIN : 0)) +
    INSET * (browser() ? 1 : 2);
  return (
    <View
      ref={(node) => {
        unbindFullscreen?.();
        unbindFullscreen = node
          ? keymap.bind(
              'shift+mod+f',
              () => {
                if (preview()) props.togglePreviewFullscreen?.();
              },
              { within: node },
            )
          : undefined;
      }}
      style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}
    >
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
              <If when={fullscreen() && props.floatingComposer !== undefined}>
                <View
                  style={[
                    {
                      position: 'absolute',
                      left: 24,
                      right: 24,
                      bottom: 16,
                      alignItems: 'center',
                    },
                    { pointerEvents: 'box-none' },
                  ]}
                >
                  {props.floatingComposer!()}
                </View>
              </If>
            </View>
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      <If when={props.sidebarHover?.shown() && !browser() && !fullscreen()}>
        <View
          onMouseEnter={() => props.sidebarHover?.hover(true)}
          onMouseLeave={() => props.sidebarHover?.hover(false)}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: Math.min(preferredWidth(), available()),
            backgroundColor: C.chrome,
            overflow: 'hidden',
          }}
        >
          {props.navigation(true)}
        </View>
      </If>
      <If when={props.previewDialog()}>
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
