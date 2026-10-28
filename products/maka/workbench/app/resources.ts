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
import { cleanup, effect, signal, untracked } from 'nsh';
import type { YNode } from 'nsh';
import { createWorkspaceFiles, type WorkspaceFileTarget } from './workspaceFileState';
import { createCurrentFile, type CurrentFileModel } from './CurrentFile';
import type { ImagePreview } from './ImageThumbnail';
import type { ViewerImage } from './ImageViewer';
import { createTerminals, type TerminalModel } from './terminalState';
import type { ResourceUpdate } from '../../../../packages/plugin-sdk/src/index.js';

export type ResourceTab = {
  instance: number;
  identity: string;
  sessionId: string;
  title: string;
} & (
  | { kind: 'file'; model: CurrentFileModel }
  | { kind: 'image'; image: ImagePreview }
  | { kind: 'terminal'; model: TerminalModel }
);

type ImageViewerState = { tab: ResourceTab; image: ViewerImage; close(): void };

// Window presentation state only. All resource authority remains in the
// original Host selector; no session, draft or backend data is duplicated here.
export function createResources(options: { selected(): string | null; blocked(): boolean }) {
  const shown = signal(false);
  const tabs = signal<ResourceTab[]>([]);
  const active = signal<number | 'files' | 'terminals'>('files');
  const focusRequest = signal(false);
  const instance = signal(0);
  const imageViewer = signal<ImageViewerState | null>(null);
  let nextInstance = 0;
  let session: string | null = null;
  let alive = true;
  let root: YNode | undefined;
  let header: { sessionId: string; node: YNode } | undefined;
  let opener: (() => boolean) | undefined;
  const dispose = (tab: ResourceTab) => {
    if (tab.kind !== 'image') tab.model.dispose();
  };
  const adopt = () => {
    const selected = options.selected();
    if (selected !== session) {
      imageViewer.set(null);
      tabs().forEach(dispose);
      tabs.set([]);
      shown.set(false);
      active.set('files');
      focusRequest.set(false);
      instance.set(instance() + 1);
      session = selected;
      opener = undefined;
    }
  };
  effect(() => {
    options.selected();
    untracked(adopt);
  });
  const admits = (sessionId: string) =>
    alive && !options.blocked() && options.selected() === sessionId;
  const reveal = () => {
    if (!shown()) {
      instance.set(instance() + 1);
      focusRequest.set(true);
    }
    shown.set(true);
  };
  const select = (target: { sessionId: string; instance: number }) => {
    if (
      !admits(target.sessionId) ||
      !tabs().some((tab) => tab.instance === target.instance && tab.sessionId === target.sessionId)
    )
      return;
    imageViewer.set(null);
    active.set(target.instance);
    reveal();
  };
  const open = (sessionId: string, identity: string, build: (instance: number) => ResourceTab) => {
    if (!admits(sessionId)) return;
    adopt();
    imageViewer.set(null);
    let tab = tabs().find((candidate) => candidate.identity === identity);
    if (!tab) {
      tab = build(++nextInstance);
      tabs.set([...tabs(), tab]);
    }
    active.set(tab.instance);
    reveal();
    focusRequest.set(true);
  };
  const openFile = (target: WorkspaceFileTarget, restoreFocus?: () => boolean) => {
    if (!admits(target.sessionId)) return;
    open(target.sessionId, `file:${target.path.bytesBase64}`, (instance) => ({
      kind: 'file',
      instance,
      identity: `file:${target.path.bytesBase64}`,
      sessionId: target.sessionId,
      title: target.title,
      model: createCurrentFile(target),
    }));
    if (restoreFocus) {
      const fallback = headerOpener(target.sessionId);
      opener = () => restoreFocus() || fallback();
    }
  };
  const headerOpener = (sessionId: string) => {
    const original = header;
    return () => {
      if (
        !alive ||
        options.selected() !== sessionId ||
        !original ||
        original.sessionId !== sessionId ||
        header !== original
      )
        return false;
      original.node.focus();
      return true;
    };
  };
  const openImage = (image: ImagePreview) => {
    const { sessionId } = image.source.read;
    const identity = image.uri;
    if (!admits(sessionId)) return;
    open(sessionId, identity, (instance) => ({
      kind: 'image',
      instance,
      identity,
      sessionId,
      get title() {
        return tr('Original image');
      },
      image,
    }));
    const fallback = headerOpener(sessionId);
    opener = () => image.restoreFocus?.() || fallback();
  };
  const inventory = (target: { sessionId: string; kind: 'files' | 'terminals' }) => {
    if (!admits(target.sessionId)) return;
    adopt();
    imageViewer.set(null);
    active.set(target.kind);
    reveal();
  };
  const closeTab = (target: { sessionId: string; instance: number }) => {
    if (!admits(target.sessionId)) return;
    const tab = tabs().find((tab) => tab.instance === target.instance);
    if (!tab) return;
    if (imageViewer()?.tab === tab) imageViewer.set(null);
    dispose(tab);
    tabs.set(tabs().filter((candidate) => candidate !== tab));
    if (active() === tab.instance) active.set('files');
    focusRequest.set(true);
  };
  const hide = () => {
    imageViewer.set(null);
    shown.set(false);
    focusRequest.set(false);
  };
  const close = (target: { sessionId: string; instance: number }) => {
    if (!admits(target.sessionId) || target.instance !== instance()) return;
    hide();
    opener?.();
  };
  const openFiles = (target: { sessionId: string }) => {
    if (admits(target.sessionId)) {
      inventory({ ...target, kind: 'files' });
      opener = headerOpener(target.sessionId);
      focusRequest.set(true);
    }
  };
  const openImageViewer = (
    target: { sessionId: string; instance: number; image: ViewerImage },
    restoreFocus: () => boolean,
  ) => {
    if (!admits(target.sessionId) || active() !== target.instance) return;
    const tab = tabs().find(
      (tab) => tab.instance === target.instance && tab.sessionId === target.sessionId,
    );
    if (!tab || (tab.kind !== 'image' && tab.kind !== 'file')) return;
    if (tab.kind === 'image' && tab.image.uri !== target.image.uri) return;
    const state: ImageViewerState = {
      tab,
      image: target.image,
      close() {
        if (!alive || imageViewer() !== state || options.selected() !== tab.sessionId) return;
        imageViewer.set(null);
        if (!restoreFocus()) focusRequest.set(true);
      },
    };
    imageViewer.set(state);
  };
  const terminals = createTerminals({
    sessionId: options.selected,
    active: () =>
      shown() &&
      (active() === 'terminals' ||
        tabs().some((tab) => tab.instance === active() && tab.kind === 'terminal')),
    open(entry: ResourceUpdate, model: TerminalModel) {
      open(entry.sessionId, `terminal:${entry.result.ref}`, (instance) => ({
        kind: 'terminal',
        instance,
        identity: `terminal:${entry.result.ref}`,
        sessionId: entry.sessionId,
        get title() {
          return entry.result.cmd || tr('Terminal');
        },
        model,
      }));
    },
  });
  const files = createWorkspaceFiles({
    sessionId: options.selected,
    active: () => shown() && active() === 'files',
    openFile,
  });
  effect(() => {
    const visible = shown();
    const selected = active();
    const current = tabs();
    untracked(() =>
      current.forEach((tab) => {
        if (tab.kind === 'file' || tab.kind === 'terminal') {
          if (visible && selected === tab.instance) tab.model.activate();
          else tab.model.suspend();
        }
      }),
    );
  });
  cleanup(() => {
    alive = false;
    imageViewer.set(null);
    tabs().forEach(dispose);
  });
  return {
    shown,
    tabs,
    active,
    files,
    terminals,
    inventory,
    openFiles,
    openFile,
    openImage,
    openImageViewer,
    imageViewer,
    select,
    closeTab,
    hide,
    close,
    instance,
    sessionId: options.selected,
    activeTab: () => tabs().find((tab) => tab.instance === active()),
    attach(node: YNode) {
      root = node;
    },
    root: () => root,
    focusRequest,
    focusHandled: () => focusRequest.set(false),
    attachOpener(sessionId: string, node: YNode) {
      if (alive && options.selected() === sessionId) header = { sessionId, node };
    },
  };
}
export type Resources = ReturnType<typeof createResources>;
