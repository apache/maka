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

import { cleanup, computed, effect, signal, untracked, type ViewRef } from 'nsh';
import type { ResourceUpdate } from '../../../../packages/plugin-sdk/src/index.js';
import type {
  WorkspaceFocusTarget,
  WorkspacePullRequestTarget,
  WorkspaceSourceItem,
} from '../../../../packages/plugin-sdk/src/workspace-view.js';
import {
  createCurrentDiff,
  currentDiffTargetKey,
  type CurrentDiffModel,
  type CurrentDiffTarget,
} from '../../../../products/maka/workbench/app/currentDiffState';
import {
  createCurrentFile,
  type CurrentFileModel,
  type FileCodeNavigation,
} from '../../../../products/maka/workbench/app/CurrentFile';
import type { DiffReviewBridge } from '../../../../products/maka/workbench/app/CurrentDiff';
import type { Host } from '../../../../products/maka/workbench/app/host';
import type { ImagePreview } from '../../../../products/maka/workbench/app/ImageThumbnail';
import type { ViewerImage } from '../../../../products/maka/workbench/app/ImageViewer';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  type CodeDefinitionResult as AgentCodeDefinitionResult,
  type CodeHoverResult as AgentCodeHoverResult,
  type CodeLocation as AgentCodeLocation,
  type CodeReferencesResult as AgentCodeReferencesResult,
  createReviewStore,
  formatPrKey,
  type GitHubReplyCommentResult,
  parentPathOf,
  relativizeWorkspaceFileUrl,
  type ReviewNote,
} from '../../../../products/maka/workbench/app/reviewState';
import { settingsValue } from '../../../../products/maka/workbench/app/settingsOperations';
import {
  completed,
  createTerminals,
  type TerminalModel,
  terminalRunning,
} from '../../../../products/maka/workbench/app/terminalState';
import { errorText, UiError } from '../../../../products/maka/workbench/app/text';
import {
  createWorkspaceFiles,
  type WorkspaceFileAnchor,
  type WorkspaceFileTarget,
} from '../../../../products/maka/workbench/app/workspaceFileState';

export type ResourceSection = 'launchpad' | 'files' | 'changes' | 'terminals' | 'agent-terminals';

export type StageSectionTab = 'launchpad' | 'files' | 'changes' | 'terminals';

export type ResourceTab = {
  instance: number;
  identity: string;
  sessionId: string;
  title: string;
} & (
  | { kind: 'file'; model: CurrentFileModel }
  | { kind: 'diff'; model: CurrentDiffModel }
  | { kind: 'image'; image: ImagePreview }
  | { kind: 'terminal'; model: TerminalModel }
  | {
      kind: 'pr';
      repo?: { host: string; owner: string; repo: string };
      number: number;
    }
);

type ImageViewerState = { tab: ResourceTab; image: ViewerImage; close(): void };

type NavStep =
  | { kind: 'section'; section: 'launchpad' | 'files' | 'changes' }
  | { kind: 'file'; target: WorkspaceFileTarget }
  | { kind: 'diff'; target: CurrentDiffTarget }
  | { kind: 'pr'; target: WorkspacePullRequestTarget };

// Window presentation state only. All resource authority remains in the
// original Host selector; no session, draft or backend data is duplicated here.
export function createResources(
  host: Host,
  options: {
    sessions(): readonly string[];
    blocked(): boolean;
    directory(sessionId: string): string | undefined;
    prompt?(sessionId: string, input: { text: string; mode: 'insert' | 'send' }): boolean;
    canPrompt?(): boolean;
    report(reason: unknown): void;
  },
) {
  const shown = signal(false);
  const fullscreen = signal(false);
  const openSections = signal<StageSectionTab[]>([]);
  const tabs = signal<ResourceTab[]>([]);
  const active = signal<number | ResourceSection>('launchpad');
  const focusRequest = signal(false);
  const instance = signal(0);
  const imageViewer = signal<ImageViewerState | null>(null);
  const reviewStore = createReviewStore();
  const navStack = signal<NavStep[]>([]);
  const navIndex = signal(-1);
  let navigatingHistory = false;
  let anchorNonce = 0;
  let nextInstance = 0;
  const session = signal<string | null>(null);
  let pendingPreview: { sessionId: string } | null = null;
  let alive = true;
  let root: ViewRef | undefined;
  const lastTerminal = new Map<string, string>();
  const headers = new Map<string, WorkspaceFocusTarget>();
  let opener: (() => boolean) | undefined;

  const dispose = (tab: ResourceTab) => {
    if (tab.kind !== 'image' && tab.kind !== 'pr') tab.model.dispose();
  };

  const ensureSectionTab = (section: StageSectionTab) => {
    if (!openSections().includes(section)) {
      openSections.set([...openSections(), section]);
    }
  };

  const resetHistory = () => {
    navStack.set([]);
    navIndex.set(-1);
  };

  const recordStep = (step: NavStep) => {
    if (navigatingHistory) return;
    const stack = navStack().slice(0, navIndex() + 1);
    const last = stack.at(-1);
    if (
      last &&
      last.kind === step.kind &&
      ((last.kind === 'section' && step.kind === 'section' && last.section === step.section) ||
        (last.kind === 'pr' && step.kind === 'pr' && last.target.number === step.target.number) ||
        (last.kind === 'file' &&
          step.kind === 'file' &&
          last.target.path.bytesBase64 === step.target.path.bytesBase64 &&
          last.target.anchor?.line === step.target.anchor?.line) ||
        (last.kind === 'diff' &&
          step.kind === 'diff' &&
          last.target.area === step.target.area &&
          last.target.path.bytesBase64 === step.target.path.bytesBase64))
    ) {
      return;
    }
    const next = [...stack, step].slice(-32);
    navStack.set(next);
    navIndex.set(next.length - 1);
  };

  const adopt = (selected: string | null) => {
    pendingPreview = null;
    if (selected !== session()) {
      imageViewer.set(null);
      fullscreen.set(false);
      openSections.set([]);
      tabs().forEach(dispose);
      tabs.set([]);
      resetHistory();
      shown.set(false);
      active.set('launchpad');
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
      reviewStore.pruneSessions(sessions);
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
    const chosen = tabs().find((t) => t.instance === target.instance);
    if (chosen?.kind === 'file') {
      recordStep({ kind: 'file', target: chosen.model.target });
    } else if (chosen?.kind === 'diff') {
      recordStep({ kind: 'diff', target: chosen.model.target });
    } else if (chosen?.kind === 'pr') {
      recordStep({
        kind: 'pr',
        target: {
          sessionId: chosen.sessionId,
          ...(chosen.repo ? { repo: chosen.repo } : {}),
          number: chosen.number,
          title: chosen.title,
        },
      });
    }
    reveal();
  };

  const openPullRequest = (target: WorkspacePullRequestTarget) => {
    if (!admits(target.sessionId)) return;
    const repoKey = target.repo
      ? `${target.repo.host.toLowerCase()}/${target.repo.owner}/${target.repo.repo}`
      : 'default';
    const identity = `pr:${repoKey}#${target.number}`;
    const initialTitle = target.title
      ? `#${target.number} ${target.title}`
      : `PR #${target.number}`;
    open(target.sessionId, identity, (instance) => ({
      kind: 'pr',
      instance,
      identity,
      sessionId: target.sessionId,
      title: initialTitle,
      ...(target.repo ? { repo: target.repo } : {}),
      number: target.number,
    }));
    recordStep({ kind: 'pr', target });
    opener = headerOpener(target.sessionId);
  };

  const updateTabTitle = (instanceId: number, nextTitle: string) => {
    const current = tabs();
    const found = current.find((t) => t.instance === instanceId);
    if (!found || found.title === nextTitle) return;
    tabs.set(current.map((t) => (t.instance === instanceId ? { ...t, title: nextTitle } : t)));
  };

  const open = (sessionId: string, identity: string, build: (instance: number) => ResourceTab) => {
    if (!admits(sessionId)) return undefined;
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
    return tab;
  };

  const openFile = (target: WorkspaceFileTarget, restoreFocus?: () => boolean) => {
    if (!admits(target.sessionId)) return;
    const stampedAnchor: WorkspaceFileAnchor | undefined = target.anchor
      ? { ...target.anchor, nonce: ++anchorNonce }
      : undefined;
    const enriched: WorkspaceFileTarget = stampedAnchor
      ? { ...target, anchor: stampedAnchor }
      : target;
    const tab = open(target.sessionId, `file:${target.path.bytesBase64}`, (instance) => ({
      kind: 'file',
      instance,
      identity: `file:${target.path.bytesBase64}`,
      sessionId: target.sessionId,
      title: target.title,
      model: createCurrentFile(host, enriched),
    }));
    if (tab?.kind === 'file' && stampedAnchor) {
      tab.model.setAnchor?.(stampedAnchor);
    }
    recordStep({ kind: 'file', target: enriched });
    if (restoreFocus) {
      const fallback = headerOpener(target.sessionId);
      opener = () => restoreFocus() || fallback();
    }
  };

  const openDiff = (target: CurrentDiffTarget, restoreFocus?: () => boolean) => {
    if (!admits(target.sessionId)) return;
    const stampedAnchor = target.anchor ? { ...target.anchor, nonce: ++anchorNonce } : undefined;
    const enriched: CurrentDiffTarget = stampedAnchor
      ? { ...target, anchor: stampedAnchor }
      : target;
    const identity = `diff:${currentDiffTargetKey(enriched)}`;
    const tab = open(target.sessionId, identity, (instance) => ({
      kind: 'diff',
      instance,
      identity,
      sessionId: target.sessionId,
      title: `${target.title} (${tr('Review')})`,
      model: createCurrentDiff(host, enriched),
    }));
    if (tab?.kind === 'diff' && stampedAnchor) {
      tab.model.setAnchor?.(stampedAnchor);
    }
    recordStep({ kind: 'diff', target: enriched });
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
      const normalized = relativizeWorkspaceFileUrl(target, options.directory(sessionId));
      const link = await host.openLink(normalized);
      if (link && pendingPreview === request && admits(sessionId)) {
        const anchor: WorkspaceFileAnchor | undefined =
          typeof link.line === 'number'
            ? {
                line: link.line,
                ...(typeof link.endLine === 'number' ? { endLine: link.endLine } : {}),
                ...(typeof link.column === 'number' ? { column: link.column } : {}),
              }
            : undefined;
        openFile(
          {
            sessionId,
            path: link.path,
            parent: link.parent,
            title: host.pathLabel(link.path),
            ...(anchor ? { anchor } : {}),
          },
          restoreFocus,
        );
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

  const inventory = (target: { sessionId: string; kind: ResourceSection }) => {
    if (!admits(target.sessionId)) return;
    adopt(target.sessionId);
    imageViewer.set(null);
    const stageSection: StageSectionTab =
      target.kind === 'agent-terminals' ? 'terminals' : target.kind;
    ensureSectionTab(stageSection);
    active.set(target.kind);
    if (target.kind === 'launchpad' || target.kind === 'files' || target.kind === 'changes') {
      recordStep({ kind: 'section', section: target.kind });
    }
    reveal();
  };

  const applyNavStep = (sessionId: string, step: NavStep) => {
    navigatingHistory = true;
    try {
      if (step.kind === 'section') {
        inventory({ sessionId, kind: step.section });
      } else if (step.kind === 'file') {
        openFile(step.target);
      } else if (step.kind === 'diff') {
        openDiff(step.target);
      } else if (step.kind === 'pr') {
        openPullRequest(step.target);
      }
    } finally {
      navigatingHistory = false;
    }
  };

  const canGoBack = computed(() => navIndex() > 0);
  const canGoForward = computed(() => navIndex() >= 0 && navIndex() + 1 < navStack().length);

  const goBack = () => {
    const sid = session();
    if (!sid || !canGoBack()) return;
    const nextIdx = navIndex() - 1;
    const step = navStack()[nextIdx];
    if (!step) return;
    navIndex.set(nextIdx);
    applyNavStep(sid, step);
  };

  const goForward = () => {
    const sid = session();
    if (!sid || !canGoForward()) return;
    const nextIdx = navIndex() + 1;
    const step = navStack()[nextIdx];
    if (!step) return;
    navIndex.set(nextIdx);
    applyNavStep(sid, step);
  };

  const hide = () => {
    pendingPreview = null;
    imageViewer.set(null);
    fullscreen.set(false);
    shown.set(false);
    focusRequest.set(false);
  };

  const pickFallbackActive = () => {
    const nonTerm = tabs().filter((t) => t.kind !== 'terminal');
    if (nonTerm.length > 0) return nonTerm.at(-1)!.instance;
    const secs = openSections();
    if (secs.length > 0) return secs.at(-1)!;
    return null;
  };

  const closeTab = (target: { sessionId: string; instance: number }) => {
    if (!admits(target.sessionId)) return;
    const tab = tabs().find((tab) => tab.instance === target.instance);
    if (!tab) return;
    if (imageViewer()?.tab === tab) imageViewer.set(null);
    dispose(tab);
    tabs.set(tabs().filter((candidate) => candidate !== tab));
    if (active() === tab.instance) {
      if (tab.kind === 'terminal') {
        ensureSectionTab('terminals');
        active.set(tab.model.agentOwned() ? 'agent-terminals' : 'terminals');
        focusRequest.set(true);
        return;
      }
      const fallback = pickFallbackActive();
      if (fallback !== null) {
        active.set(fallback);
        focusRequest.set(true);
      } else {
        hide();
        opener?.();
      }
    }
  };

  const closeSection = (target: { sessionId: string; section: StageSectionTab }) => {
    if (!admits(target.sessionId)) return;
    const nextSecs = openSections().filter((s) => s !== target.section);
    openSections.set(nextSecs);
    if (target.section === 'terminals') {
      const termTabs = tabs().filter((t) => t.kind === 'terminal');
      for (const t of termTabs) dispose(t);
      tabs.set(tabs().filter((t) => t.kind !== 'terminal'));
    }
    const cur = active();
    const wasActive =
      cur === target.section ||
      (target.section === 'terminals' && (cur === 'agent-terminals' || activeTerminal() !== null));
    if (wasActive) {
      const fallback = pickFallbackActive();
      if (fallback !== null) {
        active.set(fallback);
        focusRequest.set(true);
      } else {
        hide();
        opener?.();
      }
    }
  };

  const close = (target: { sessionId: string; instance: number }) => {
    if (!admits(target.sessionId) || target.instance !== instance()) return;
    hide();
    opener?.();
  };

  const openLaunchpad = (target: { sessionId: string }) => {
    if (admits(target.sessionId)) {
      inventory({ sessionId: target.sessionId, kind: 'launchpad' });
      opener = headerOpener(target.sessionId);
      focusRequest.set(true);
    }
  };

  const toggleStage = (target: { sessionId: string }) => {
    if (!admits(target.sessionId)) return;
    if (shown() && session() === target.sessionId) {
      hide();
      opener?.();
      return;
    }
    adopt(target.sessionId);
    if (openSections().length === 0 && tabs().filter((t) => t.kind !== 'terminal').length === 0) {
      ensureSectionTab('launchpad');
      active.set('launchpad');
    }
    opener = headerOpener(target.sessionId);
    reveal();
  };

  const openFiles = (target: { sessionId: string }) => {
    if (admits(target.sessionId)) {
      inventory({ ...target, kind: 'files' });
      opener = headerOpener(target.sessionId);
      focusRequest.set(true);
    }
  };

  const openChanges = (target: { sessionId: string; worktreePath?: string | null }) => {
    if (admits(target.sessionId)) {
      if (target.worktreePath !== undefined) {
        reviewStore.setActiveWorktree(target.sessionId, target.worktreePath);
      }
      inventory({ sessionId: target.sessionId, kind: 'changes' });
      opener = headerOpener(target.sessionId);
      focusRequest.set(true);
    }
  };

  const navigateToLocation = (sessionId: string, loc: AgentCodeLocation) => {
    openFile({
      sessionId,
      path: loc.path,
      parent: parentPathOf(loc.path),
      title: host.pathLabel(loc.path),
      anchor: {
        line: loc.range.start.line,
        endLine: loc.range.end.line,
        column: loc.range.start.column,
      },
    });
  };

  const jumpToNote = (note: ReviewNote) => {
    if (note.diffTarget) {
      openDiff({
        ...note.diffTarget,
        anchor: {
          side: note.side,
          line: note.startLine,
          endLine: note.endLine,
        },
      });
    } else if (note.area) {
      openDiff({
        sessionId: note.sessionId,
        area: note.area,
        path: note.path,
        title: note.pathLabel,
        anchor: {
          side: note.side,
          line: note.startLine,
          endLine: note.endLine,
        },
      });
    } else {
      openFile({
        sessionId: note.sessionId,
        path: note.path,
        parent: parentPathOf(note.path),
        title: note.pathLabel,
        anchor: {
          line: note.startLine,
          endLine: note.endLine,
        },
      });
    }
  };

  const canPrompt = () => (options.canPrompt ? options.canPrompt() : Boolean(options.prompt));

  const deliverPrompt = (sessionId: string, text: string, mode: 'insert' | 'send'): boolean => {
    if (!options.prompt) return false;
    return options.prompt(sessionId, { text, mode });
  };

  const runDefinitionLookup = async (
    sessionId: string,
    path: WorkspaceFileTarget['path'],
    position: { line: number; column: number },
    symbol?: string,
  ) => {
    reviewStore.setStatusMessage(
      sessionId,
      symbol ? tr('Looking up {symbol}…', { symbol }) : tr('Looking up symbol…'),
    );
    try {
      const res: AgentCodeDefinitionResult = await host.query('agent', 'codeDefinition', {
        sessionId,
        path,
        position,
        ...(symbol ? { symbol } : {}),
      });
      if (!res.symbol) {
        reviewStore.setStatusMessage(sessionId, tr('No symbol found at cursor.'));
        return;
      }
      if (res.locations.length === 0) {
        reviewStore.setStatusMessage(
          sessionId,
          tr('No definition found for {symbol}.', { symbol: res.symbol }),
        );
        return;
      }
      reviewStore.setStatusMessage(sessionId, '');
      if (res.locations.length === 1) {
        navigateToLocation(sessionId, res.locations[0]);
      } else {
        reviewStore.setSymbolBatch(sessionId, {
          kind: 'definitions',
          symbol: res.symbol,
          backend: res.backend,
          locations: res.locations,
          truncated: false,
          activeIndex: 0,
        });
        navigateToLocation(sessionId, res.locations[0]);
      }
    } catch (reason) {
      reviewStore.setStatusMessage(sessionId, '');
      options.report(reason);
    }
  };

  const runReferencesLookup = async (
    sessionId: string,
    path: WorkspaceFileTarget['path'],
    position: { line: number; column: number },
    symbol?: string,
  ) => {
    reviewStore.setStatusMessage(
      sessionId,
      symbol ? tr('Looking up {symbol}…', { symbol }) : tr('Looking up symbol…'),
    );
    try {
      const res: AgentCodeReferencesResult = await host.query('agent', 'codeReferences', {
        sessionId,
        path,
        position,
        ...(symbol ? { symbol } : {}),
        includeDeclaration: true,
      });
      if (!res.symbol) {
        reviewStore.setStatusMessage(sessionId, tr('No symbol found at cursor.'));
        return;
      }
      if (res.locations.length === 0) {
        reviewStore.setStatusMessage(
          sessionId,
          tr('No references found for {symbol}.', { symbol: res.symbol }),
        );
        return;
      }
      reviewStore.setStatusMessage(sessionId, '');
      reviewStore.setSymbolBatch(sessionId, {
        kind: 'references',
        symbol: res.symbol,
        backend: res.backend,
        locations: res.locations,
        truncated: res.truncated,
        activeIndex: -1,
      });
    } catch (reason) {
      reviewStore.setStatusMessage(sessionId, '');
      options.report(reason);
    }
  };

  const fileNavigation = (target: WorkspaceFileTarget): FileCodeNavigation => ({
    store: reviewStore,
    get canPrompt() {
      return canPrompt();
    },
    deliverPrompt: (text, mode) => deliverPrompt(target.sessionId, text, mode),
    async checkDefinition(position) {
      try {
        return await host.query('agent', 'codeDefinition', {
          sessionId: target.sessionId,
          path: target.path,
          position,
          hoverOnly: true,
        });
      } catch {
        return null;
      }
    },
    goToDefinition: (position) => runDefinitionLookup(target.sessionId, target.path, position),
    findReferences: (position) => runReferencesLookup(target.sessionId, target.path, position),
    async hover(position): Promise<AgentCodeHoverResult | null> {
      try {
        return await host.query('agent', 'codeHover', {
          sessionId: target.sessionId,
          path: target.path,
          position,
        });
      } catch {
        return null;
      }
    },
  });

  const diffReview = (target: CurrentDiffTarget): DiffReviewBridge => ({
    store: reviewStore,
    get canPrompt() {
      return canPrompt();
    },
    deliverPrompt: (text, mode) => deliverPrompt(target.sessionId, text, mode),
    openDiff: (next) => openDiff(next),
    async replyPrThread(repo, prNumber, threadId, body) {
      try {
        const { reply } = await host.control('githubReplyComment', {
          sessionId: target.sessionId,
          repo,
          number: prNumber,
          commentId: threadId,
          body,
        });
        const result = settingsValue(reply) as GitHubReplyCommentResult;
        if (result.kind === 'replied') {
          reviewStore.appendPrThreadReply(
            target.sessionId,
            formatPrKey(repo, prNumber),
            threadId,
            result.comment,
          );
          return null;
        }
        return result.message;
      } catch (err) {
        return err instanceof Error ? err.message : tr('Failed to post GitHub reply.');
      }
    },
    openFileAt(line) {
      openFile({
        sessionId: target.sessionId,
        path: target.path,
        parent: parentPathOf(target.path),
        title: target.title,
        anchor: { line },
      });
    },
    lookupSymbol(kind, symbol, line) {
      if (kind === 'definition') {
        return runDefinitionLookup(target.sessionId, target.path, { line, column: 0 }, symbol);
      }
      return runReferencesLookup(target.sessionId, target.path, { line, column: 0 }, symbol);
    },
    openLocation(loc) {
      navigateToLocation(target.sessionId, loc);
    },
  });

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
      ensureSectionTab('terminals');
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
    fullscreen,
    setFullscreen: (value: boolean) => {
      if (shown()) fullscreen.set(value);
      else fullscreen.set(false);
    },
    openSections,
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
    toggleStage,
    openLaunchpad,
    openPullRequest,
    updateTabTitle,
    activeWorktree: (sid: string) => reviewStore.activeWorktree(sid),
    selectWorktree(target: { sessionId: string; worktreePath: string | null }) {
      reviewStore.setActiveWorktree(target.sessionId, target.worktreePath);
    },
    sources(sid: string): readonly WorkspaceSourceItem[] {
      if (session() !== sid) return [];
      return tabs()
        .filter((t): t is Exclude<ResourceTab, { kind: 'terminal' }> => t.kind !== 'terminal')
        .map((t) => ({
          id: String(t.instance),
          title:
            t.kind === 'pr' ? t.title : t.title.split(/[\\/]/).filter(Boolean).at(-1) || t.title,
          detail: t.title,
          kind: t.kind,
          select: () => select({ sessionId: sid, instance: t.instance }),
        }));
    },
    openFiles,
    openChanges,
    openFile,
    openDiff,
    openImage,
    openLink,
    openImageViewer,
    imageViewer,
    select,
    closeTab,
    closeSection,
    hide,
    close,
    instance,
    sessionId: session,
    activeTab,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    reviewStore,
    canPrompt,
    deliverPrompt,
    navigateToLocation,
    jumpToNote,
    fileNavigation,
    diffReview,
    pathLabel: (path: WorkspaceFileTarget['path']) => host.pathLabel(path),
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
