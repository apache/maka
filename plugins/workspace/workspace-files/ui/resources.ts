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

import { tr } from '../../../../products/maka/workbench/app/locale';
import { cleanup, effect, signal, untracked } from 'nsh';
import type { ViewRef } from 'nsh';
import {
  createWorkspaceFiles,
  type WorkspaceFileTarget,
} from '../../../../products/maka/workbench/app/workspaceFileState';
import {
  createCurrentFile,
  type CurrentFileModel,
} from '../../../../products/maka/workbench/app/CurrentFile';
import type { ImagePreview } from '../../../../products/maka/workbench/app/ImageThumbnail';
import type { ViewerImage } from '../../../../products/maka/workbench/app/ImageViewer';
import {
  createTerminals,
  type TerminalModel,
} from '../../../../products/maka/workbench/app/terminalState';
import type { ResourceUpdate } from '../../../../packages/plugin-sdk/src/index.js';
import type { WorkspaceFocusTarget } from '../../../../packages/plugin-sdk/src/workspace-view.js';
import type { Host } from '../../../../products/maka/workbench/app/host';
import { errorText, UiError } from '../../../../products/maka/workbench/app/text';

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
export function createResources(
  host: Host,
  options: {
    sessions(): readonly string[];
    blocked(): boolean;
    report(reason: unknown): void;
  },
) {
  const shown = signal(false);
  const tabs = signal<ResourceTab[]>([]);
  const active = signal<number | 'files' | 'terminals'>('files');
  const focusRequest = signal(false);
  const instance = signal(0);
  const imageViewer = signal<ImageViewerState | null>(null);
  let nextInstance = 0;
  const session = signal<string | null>(null);
  let pendingLink: { sessionId: string } | null = null;
  let alive = true;
  let root: ViewRef | undefined;
  const headers = new Map<string, WorkspaceFocusTarget>();
  let opener: (() => boolean) | undefined;
  const dispose = (tab: ResourceTab) => {
    if (tab.kind !== 'image') tab.model.dispose();
  };
  const adopt = (selected: string | null) => {
    pendingLink = null;
    if (selected !== session()) {
      imageViewer.set(null);
      tabs().forEach(dispose);
      tabs.set([]);
      shown.set(false);
      active.set('files');
      focusRequest.set(false);
      instance.set(instance() + 1);
      session.set(selected);
      opener = undefined;
    }
  };
  effect(() => {
    const sessions = options.sessions();
    untracked(() => {
      if (session() !== null && !sessions.includes(session()!)) adopt(null);
      if (pendingLink && !sessions.includes(pendingLink.sessionId)) pendingLink = null;
      for (const id of headers.keys()) if (!sessions.includes(id)) headers.delete(id);
    });
  });
  const admits = (sessionId: string) =>
    alive && !options.blocked() && options.sessions().includes(sessionId);
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
    adopt(sessionId);
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
      model: createCurrentFile(host, target),
    }));
    if (restoreFocus) {
      const fallback = headerOpener(target.sessionId);
      opener = () => restoreFocus() || fallback();
    }
  };
  const headerOpener = (sessionId: string) => {
    const original = headers.get(sessionId);
    return () => {
      if (
        !alive ||
        !options.sessions().includes(sessionId) ||
        !original ||
        headers.get(sessionId) !== original
      )
        return false;
      original.focus();
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
  const openLink = async (sessionId: string, target: string, restoreFocus: () => boolean) => {
    if (!admits(sessionId)) return;
    const request = { sessionId };
    pendingLink = request;
    try {
      const link = await host.openLink(target);
      if (link && pendingLink === request && admits(sessionId)) {
        openFile({ sessionId, ...link, title: host.pathLabel(link.path) }, restoreFocus);
      }
    } catch (reason) {
      if (admits(sessionId))
        options.report(new UiError('Could not open link: {reason}', { reason: errorText(reason) }));
    } finally {
      if (pendingLink === request) pendingLink = null;
    }
  };
  const inventory = (target: { sessionId: string; kind: 'files' | 'terminals' }) => {
    if (!admits(target.sessionId)) return;
    adopt(target.sessionId);
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
    pendingLink = null;
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
        if (!alive || imageViewer() !== state || session() !== tab.sessionId) return;
        imageViewer.set(null);
        if (!restoreFocus()) focusRequest.set(true);
      },
    };
    imageViewer.set(state);
  };
  const terminals = createTerminals(host, {
    sessionId: session,
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
  const files = createWorkspaceFiles(host, {
    sessionId: session,
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
    openLink,
    openImageViewer,
    imageViewer,
    select,
    closeTab,
    hide,
    close,
    instance,
    sessionId: session,
    activeTab: () => tabs().find((tab) => tab.instance === active()),
    attach(node: ViewRef) {
      root = node;
    },
    root: () => root,
    focusRequest,
    focusHandled: () => focusRequest.set(false),
    attachOpener(sessionId: string, node: WorkspaceFocusTarget) {
      if (alive && options.sessions().includes(sessionId)) headers.set(sessionId, node);
    },
  };
}
export type Resources = ReturnType<typeof createResources>;
