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
import { windowSize } from 'nsh';
import { keymap } from 'nsh';
import { Dialog, ResizablePanel, ResizablePanelGroup } from 'nsh/base';
import { C } from './ui';
import { pluginContext } from './plugins/context';
import { PluginPanel } from './plugins/PluginPanel';
import { dialogTop, docked } from './chrome';
import { WorkspaceBrowser, type WorkspaceBrowserProps } from './WorkspaceBrowser';
import { ResourcePane } from './ResourcePane';
import { ImageViewer } from './ImageViewer';
import type { Resources } from './resources';

const CELL = 8;
const CENTER_DOCK_WIDTH = 72 * CELL;
const CENTER_MIN = 48 * CELL;
const BROWSER_MIN = 24 * CELL;
const BROWSER_MAX = 40 * CELL;
const PREVIEW_MIN = 40 * CELL;

export const canDockBrowser = (withPreview = false) =>
  windowSize().width >=
  CENTER_DOCK_WIDTH +
    BROWSER_MIN +
    CELL +
    (withPreview && canDockPreview() ? PREVIEW_MIN + CELL : 0);
const canDockPreview = () => windowSize().width >= CENTER_DOCK_WIDTH + PREVIEW_MIN + CELL;

export function Workbench(props: {
  expanded(): boolean;
  browser: WorkspaceBrowserProps;
  resources: Resources;
  children: JSX.Element;
}) {
  const plugins = pluginContext()!;
  let pluginRoot: import('nsh').YNode | undefined;
  const previewShown = () => props.resources.shown() || plugins.panel() !== null;
  const preferredWidth = signal(32 * CELL);
  const preferredPreviewWidth = signal(48 * CELL);
  const preview = () => previewShown() && canDockPreview();
  const browser = () => props.expanded() && canDockBrowser(previewShown());
  effect(() => {
    docked.browser.set(browser());
    docked.preview.set(preview());
  });
  const previewDialog = signal(false);
  let wasPreviewDocked = canDockPreview();
  effect(() => {
    const docked = canDockPreview();
    const root = plugins.panel() ? pluginRoot : props.resources.root();
    if (!previewShown() || docked || props.resources.imageViewer()) previewDialog.set(false);
    else if (plugins.panel() || !wasPreviewDocked || (root && keymap.focusedWithin(root)))
      previewDialog.set(true);
    else {
      props.resources.hide();
      previewDialog.set(false);
    }
    wasPreviewDocked = docked;
  });
  return (
    <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
      <ResizablePanelGroup
        axis="horizontal"
        handleAccessibilityLabel={tr('Resize workspace panels')}
        handleStyle={{ backgroundColor: C.line }}
        style={{ flex: 1, minWidth: 0, minHeight: 0, gap: CELL }}
      >
        <ResizablePanel
          visible={browser()}
          size={preferredWidth()}
          minSize={BROWSER_MIN}
          maxSize={BROWSER_MAX}
          onResize={(size) => preferredWidth.set(size)}
          style={{ minHeight: 0, backgroundColor: C.surface }}
        >
          <If when={browser()}>
            <WorkspaceBrowser {...props.browser} />
          </If>
        </ResizablePanel>
        <ResizablePanel minSize={CENTER_MIN} style={{ minHeight: 0 }}>
          {props.children}
        </ResizablePanel>
        <ResizablePanel
          visible={preview()}
          size={preferredPreviewWidth()}
          minSize={PREVIEW_MIN}
          onResize={(size) => preferredPreviewWidth.set(size)}
          style={{ minHeight: 0 }}
        >
          <If when={preview()}>
            <If
              when={plugins.panel() !== null}
              else={<ResourcePane resources={props.resources} docked />}
            >
              <PluginPanel
                docked
                attach={(node) => {
                  pluginRoot = node;
                }}
              />
            </If>
          </If>
        </ResizablePanel>
      </ResizablePanelGroup>
      <If when={previewDialog()}>
        <Dialog
          animation="none"
          onOpenChange={
            plugins.panel()
              ? inputAction(plugins.closePanel, plugins.panel()!.instance)
              : inputAction(props.resources.close, {
                  sessionId: props.resources.sessionId()!,
                  instance: props.resources.instance(),
                })
          }
          style={{ flex: 1, padding: 8, paddingTop: dialogTop(8), backgroundColor: '#000000cc' }}
        >
          <If
            when={plugins.panel() !== null}
            else={<ResourcePane resources={props.resources} docked={false} />}
          >
            <PluginPanel
              docked={false}
              attach={(node) => {
                pluginRoot = node;
              }}
            />
          </If>
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
