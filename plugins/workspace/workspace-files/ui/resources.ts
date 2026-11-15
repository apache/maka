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
import { cleanup, computed, effect, signal, untracked } from 'nsh';
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
  completed,
  createTerminals,
  terminalRunning,
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
    directory(sessionId: string): string | undefined;
    report(reason: unknown): void;
  },
) {
  const shown = signal(false);
  const tabs = signal<ResourceTab[]>([]);
  const active = signal<number | 'files' | 'terminals' | 'agent-terminals'>('files');
  const focusRequest = signal(false);
  const instance = signal(0);
  const imageViewer = signal<ImageViewerState | null>(null);
  let nextInstance = 0;
  const session = signal<string | null>(null);
  let pendingPreview: { sessionId: string } | null = null;
  let alive = true;
  let root: ViewRef | undefined;
  const lastTerminal = new Map<string, string>();
  const headers = new Map<string, WorkspaceFocusTarget>();
  let opener: (() => boolean) | undefined;
  const dispose = (tab: ResourceTab) => {
    if (tab.kind !== 'image') tab.model.dispose();
  };
  const adopt = (selected: string | null) => {
    pendingPreview = null;
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
      if (pendingPreview && !sessions.includes(pendingPreview.sessionId)) pendingPreview = null;
      for (const id of headers.keys()) if (!sessions.includes(id)) headers.delete(id);
      for (const id of lastTerminal.keys()) if (!sessions.includes(id)) lastTerminal.delete(id);
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
    pendingPreview = null;
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
    pendingPreview = request;
    try {
      const link = await host.openLink(target);
      if (link && pendingPreview === request && admits(sessionId)) {
        openFile({ sessionId, ...link, title: host.pathLabel(link.path) }, restoreFocus);
      }
    } catch (reason) {
      if (admits(sessionId))
        options.report(
          new UiError('Could not open link: {reason}', {
            reason: errorText(reason, 'The link could not be opened'),
          }),
        );
    } finally {
      if (pendingPreview === request) pendingPreview = null;
    }
  };
  const inventory = (target: {
    sessionId: string;
    kind: 'files' | 'terminals' | 'agent-terminals';
  }) => {
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
    if (active() === tab.instance) {
      active.set(
        tab.kind === 'terminal'
          ? tab.model.agentOwned()
            ? 'agent-terminals'
            : 'terminals'
          : 'files',
      );
      focusRequest.set(true);
    }
  };
  const hide = () => {
    pendingPreview = null;
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
  const activeTab = () => tabs().find((tab) => tab.instance === active());
  const activeTerminal = () => {
    const tab = activeTab();
    return tab?.kind === 'terminal' ? tab.model : null;
  };
  const terminalSection = () => {
    const model = activeTerminal();
    if (model) return model.agentOwned() ? 'agent-terminals' : 'terminals';
    const value = active();
    return value === 'terminals' || value === 'agent-terminals' ? value : null;
  };
  const terminals = createTerminals(host, {
    sessionId: session,
    active: () => shown() && terminalSection() !== null,
    open(entry: ResourceUpdate, model: TerminalModel) {
      const agent = entry.initiator === 'agent';
      const identity = `terminal:${entry.result.ref}`;
      if (agent) {
        const previous = tabs().find(
          (tab) => tab.kind === 'terminal' && tab.model.agentOwned() && tab.identity !== identity,
        );
        if (previous) closeTab(previous);
      } else {
        lastTerminal.set(entry.sessionId, entry.result.ref);
      }
      open(entry.sessionId, identity, (instance) => ({
        kind: 'terminal',
        instance,
        identity,
        sessionId: entry.sessionId,
        title: entry.result.cmd || tr('Terminal'),
        model,
      }));
      if (!agent) {
        focusRequest.set(false);
        model.focusRequested.set(true);
      }
    },
  });
  const personalTerminals = computed(() =>
    terminals.entries().filter((row) => {
      const entry = row.value();
      return entry.initiator === 'user' && entry.result.mode === 'pty' && terminalRunning(entry);
    }),
  );
  const agentTerminals = computed(() =>
    terminals
      .entries()
      .filter((row) => row.value().initiator === 'agent')
      .toReversed(),
  );
  const showTerminal = (entry: ResourceUpdate) => {
    if (admits(entry.sessionId)) terminals.open(entry);
  };
  effect(() => {
    const closedShells = tabs().filter(
      (tab) =>
        tab.kind === 'terminal' && !tab.model.agentOwned() && !terminalRunning(tab.model.entry()),
    );
    const section = shown() && terminalSection();
    const shells = section === 'terminals' ? personalTerminals() : [];
    untracked(() => {
      for (const shell of closedShells) closeTab(shell);
      if (section !== 'terminals' || activeTerminal()) return;
      const id = session();
      if (!id) return;
      const previous = lastTerminal.get(id);
      const next = shells.find((row) => row.value().result.ref === previous) ?? shells.at(-1);
      if (next && next.value().sessionId === id) showTerminal(next.value());
    });
  });
  const openAgentTerminal = async (
    target: { sessionId: string; ref: string },
    restoreFocus: () => boolean,
  ) => {
    if (!admits(target.sessionId)) return;
    const request = { sessionId: target.sessionId };
    pendingPreview = request;
    try {
      const entry = completed(await host.query('terminal', 'read', target));
      if (pendingPreview !== request || !admits(target.sessionId)) return;
      if (
        entry.initiator !== 'agent' ||
        entry.sessionId !== target.sessionId ||
        entry.result.ref !== target.ref
      )
        throw new UiError('Agent terminal is unavailable.');
      adopt(target.sessionId);
      showTerminal(entry);
      const fallback = headerOpener(target.sessionId);
      opener = () => restoreFocus() || fallback();
    } catch (reason) {
      if (pendingPreview === request && admits(target.sessionId)) options.report(reason);
    } finally {
      if (pendingPreview === request) pendingPreview = null;
    }
  };
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
    terminalSection,
    activeTerminal,
    personalTerminals,
    runningAgentTerminals: computed(() =>
      agentTerminals().filter((row) => terminalRunning(row.value())),
    ),
    finishedAgentTerminals: computed(() =>
      agentTerminals().filter((row) => !terminalRunning(row.value())),
    ),
    showTerminal,
    openAgentTerminal,
    directory: () => {
      const id = session();
      return id ? options.directory(id) : undefined;
    },
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
    activeTab,
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
