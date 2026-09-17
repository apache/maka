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

import { useWorkbarServices } from '../services-context.js';
import { lazy, Suspense, useState, useEffect, useRef, type ReactNode } from 'react';
import { Composer, useUiLocale, type ChatModelChoice } from '@maka/ui';
import {
  ICON_SIZE,
  Activity,
  X,
  Clipboard,
  FileDiff,
  FolderOpen,
  Globe,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Terminal,
} from '@maka/ui/icons';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Kbd } from '@astryxdesign/core/Kbd';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import type { SessionSummary } from '@maka/core/session';
import type { WorkBoardItem, WorkBoardLinkedSession } from '@maka/core/work-board';
import { QuoteCompanionPanel } from '../tools/side-chat/quote-companion-panel';
import {
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
  type SessionWorkbarPanelsState,
  type SessionWorkbarPlacement,
  terminalRefFromWorkbarTab,
  reduceWorkbarPanels,
  projectWorkbarPanelsForSession,
} from '../model/workbar-tabs';
import {
  workbarToolsForWorkspace,
  workbarToolDefinition,
  type WorkbarToolDefinition,
} from '../model/workbar-tool-definitions';
import { WorkbarEdgeToggle } from '../../../application/contracts/workbar-edge-toggle.js';
import { WorkBoardPanel } from '../../../work-board-panel.js';
import { getShellCopy } from '../../../locales/shell-copy.js';
import { getDesktopConversationCopy } from '../../../locales/conversation-copy.js';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  QuoteCompanionPanelState,
} from '../tools/side-chat/quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from '../tools/side-chat/quote-companion-visibility';

const ArtifactPane = lazy(() =>
  import('../tools/artifacts/artifact-pane').then((module) => ({ default: module.ArtifactPane })),
);
const BrowserPanel = lazy(() =>
  import('../tools/browser/browser-panel').then((module) => ({ default: module.BrowserPanel })),
);
const SessionInspectorPanel = lazy(() =>
  import('../../../application/contracts/session-inspector/session-inspector-panel.js').then((module) => ({
    default: module.SessionInspectorPanel,
  })),
);
const SessionReviewPanel = lazy(() =>
  import('../tools/review/session-review-panel').then((module) => ({
    default: module.SessionReviewPanel,
  })),
);
const SessionTerminalPanel = lazy(() =>
  import('../tools/terminal/session-terminal-panel').then((module) => ({
    default: module.SessionTerminalPanel,
  })),
);

function WorkbarPanelLoading(props: { label: string }) {
  return (
    <div className="maka-workbar-panel-loading">
      <Spinner size="sm" shade="subtle" label={props.label} />
    </div>
  );
}

function WorkbarPanel(props: {
  id?: string;
  active: boolean;
  collapsed?: boolean;
  placement: SessionWorkbarPlacement;
  overlay?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Section
      id={props.id}
      variant="transparent"
      padding={0}
      hidden={!props.active}
      data-placement={props.placement}
      data-overlay={props.overlay || undefined}
      data-collapsed={props.collapsed || undefined}
      className={
        props.className
          ? `maka-session-workbar-panel ${props.className}`
          : 'maka-session-workbar-panel'
      }
    >
      {props.children}
    </Section>
  );
}

function TabCount(props: { count: number }) {
  return <Badge variant="neutral" label={props.count} data-maka-contract="session-workbar-count" />;
}

/**
 * The one place a tool's semantic icon name becomes a glyph.
 * `workbar-tool-definitions.ts` names the icon; nothing else picks one.
 */
const FACE_ICON = {
  activity: Activity,
  'file-diff': FileDiff,
  folder: FolderOpen,
  globe: Globe,
  'list-todo': Clipboard,
  'message-circle-question': MessageCircleQuestion,
  terminal: Terminal,
} as const satisfies Record<WorkbarToolDefinition['icon'], typeof Activity>;

function faceIcon(kind: SessionWorkbarTabKind) {
  return FACE_ICON[workbarToolDefinition(kind).icon];
}

type WorkbarCopy = ReturnType<typeof getDesktopConversationCopy>['workbar'];

/** A face's own name, before any per-instance numbering. */
function faceLabel(kind: SessionWorkbarTabKind, copy: WorkbarCopy): string {
  switch (kind) {
    case 'review':
      return copy.review;
    case 'terminal':
      return copy.terminal;
    case 'work-board':
      return copy.workBoard;
    case 'browser':
      return copy.browser;
    case 'files':
      return copy.files;
    case 'inspector':
      return copy.inspector;
    case 'side-chat':
      return copy.sideChat;
  }
}

function tabLabel(
  tab: SessionWorkbarTab,
  tabs: readonly SessionWorkbarTab[],
  copy: WorkbarCopy,
): string {
  switch (tab.kind) {
    case 'terminal':
      return tab.ordinal && tab.ordinal > 1
        ? copy.terminalNumbered(tab.ordinal)
        : copy.terminal;
    case 'side-chat':
      {
        if (tab.title?.trim()) return tab.title.trim();
        const index =
          tab.ordinal ??
          tabs.filter((candidate) => candidate.kind === 'side-chat').findIndex(
            (candidate) => candidate.id === tab.id,
          ) + 1;
        return index <= 1 ? copy.sideChat : copy.sideChatNumbered(index);
      }
    default:
      return faceLabel(tab.kind, copy);
  }
}

function tabIcon(tab: SessionWorkbarTab, running: boolean): ReactNode {
  if (running) {
    return (
      <Loader2
        size={ICON_SIZE.control}
        aria-hidden="true"
        className="maka-workbar-tab-spinner"
      />
    );
  }
  const FaceIcon = faceIcon(tab.kind);
  return <FaceIcon size={ICON_SIZE.control} aria-hidden="true" />;
}

function WorkbarFaceMenu(props: {
  tabs: readonly SessionWorkbarTab[];
  sideChatAvailable: boolean;
  onOpen: (kind: SessionWorkbarTabKind) => void;
  tools: readonly WorkbarToolDefinition[];
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  const { popupMenu } = useWorkbarServices();
  const [open, setOpen] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return (
    <Button
      variant="ghost" size="sm" isIconOnly label={copy.openTab}
      icon={<Plus size={ICON_SIZE.control} aria-hidden />}
      aria-haspopup="menu" aria-expanded={open}
      onClick={(event) => {
        if (open) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        setOpen(true);
        void popupMenu({ x: bounds.left, y: bounds.bottom, items: props.tools.map((tool) => ({
          id: tool.kind, label: faceLabel(tool.kind, copy),
          checked: props.tabs.some((tab) => tab.kind === tool.kind),
          enabled: tool.kind !== 'side-chat' || props.sideChatAvailable,
        })) }).then((selected) => {
          if (!mounted.current) return;
          const tool = props.tools.find((tool) => tool.kind === selected);
          if (tool && (tool.kind !== 'side-chat' || props.sideChatAvailable)) props.onOpen(tool.kind);
        }).catch(console.error).finally(() => { if (mounted.current) setOpen(false); });
      }}
    />
  );
}

function WorkbarTabStrip(props: {
  placement: SessionWorkbarPlacement;
  tabs: readonly SessionWorkbarTab[];
  activeTabId: string | null;
  artifactCount: number;
  sideChatAvailable: boolean;
  activeSideChatPanelIds?: ReadonlySet<string>;
  onActivate: (tabId: string) => void;
  onClose: (tab: SessionWorkbarTab) => void;
  onOpenKind: (kind: SessionWorkbarTabKind) => void;
  tools: readonly WorkbarToolDefinition[];
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  return (
    // TabList sits in a `min-width: 0` flex item on purpose. A flex item
    // defaults to `min-width: auto`, so a strip without the reset refuses to
    // shrink: it spills past the panel and pushes [+] and the collapse toggle
    // off the edge instead of scrolling.
    <div className="maka-workbar-tab-strip">
      <div className="maka-workbar-tab-list">
        {props.tabs.length > 0 ? (
          // No `hasDivider`: the rail is the bar's, so it can run the full row
          // instead of stopping where the tabs do. See `shell.css`.
          <TabList
            size="sm"
            role="tablist"
            aria-label={copy.sectionsAriaLabel}
            value={props.activeTabId ?? props.tabs[0]!.id}
            onChange={(next) => props.onActivate(String(next))}
          >
            {props.tabs.map((tab) => {
              const running =
                tab.kind === 'side-chat' &&
                props.activeSideChatPanelIds?.has(
                  tab.id.slice('side-chat:'.length),
                ) === true;
              const count = tab.kind === 'files' ? props.artifactCount : undefined;
              return (
                <Tab
                  key={tab.id}
                  data-maka-assistant-exclude={tab.kind === 'browser' || tab.kind === 'terminal' ? tab.kind : undefined}
                  value={tab.id}
                  label={tabLabel(tab, props.tabs, copy)}
                  panelId={`maka-workbar-panel-${tab.id}`}
                  icon={tabIcon(tab, running)}
                  aria-keyshortcuts="Delete"
                  aria-description={copy.closeTabHint}
                  onKeyDown={(event) => {
                    if (event.key !== 'Delete') return;
                    event.preventDefault();
                    event.stopPropagation();
                    const button = event.currentTarget;
                    const toolbar = button.closest('[role="toolbar"]');
                    props.onClose(tab);
                    requestAnimationFrame(() => {
                      if (!button.isConnected) (toolbar?.querySelector('[role="tab"][aria-selected="true"], button') as HTMLElement | null)?.focus();
                    });
                  }}
                  endContent={<>
                    {count !== undefined && <TabCount count={count} />}
                    <span className="maka-workbar-tab-close" aria-hidden="true" title={copy.closeTab(tabLabel(tab, props.tabs, copy))}
                      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                      onClick={(event) => { event.stopPropagation(); props.onClose(tab); }}>
                      <X size={12} />
                    </span>
                  </>}
                />
              );
            })}
          </TabList>
        ) : null}
      </div>
      <WorkbarFaceMenu
        tabs={props.tabs}
        sideChatAvailable={props.sideChatAvailable}
        onOpen={props.onOpenKind}
        tools={props.tools}
      />
    </div>
  );
}

function WorkbarLauncher(props: {
  tools: readonly WorkbarToolDefinition[];
  onOpen: (kind: SessionWorkbarTabKind) => void;
  sideChatAvailable: boolean;
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  // The list is the tool registry, in registry order — icons and shortcuts
  // included. This is the one place a face's shortcut is shown, so it is also
  // where the shortcuts are learned.
  return (
    <div className="maka-workbar-launcher">
      <div className="maka-workbar-launcher-frame">
        <List
          className="maka-workbar-launcher-list"
          density="compact"
          header={<Heading level={4}>{copy.openTools}</Heading>}
        >
          {props.tools.map((definition) => (
            <ListItem
              key={definition.kind}
              data-maka-assistant-exclude={definition.kind === 'browser' || definition.kind === 'terminal' ? definition.kind : undefined}
              startContent={
                <Icon icon={FACE_ICON[definition.icon]} size="sm" color="secondary" />
              }
              label={faceLabel(definition.kind, copy)}
              description={copy.launcher[launcherCopyKey(definition.kind)]}
              endContent={
                definition.shortcut ? <Kbd keys={definition.shortcut} /> : undefined
              }
              isDisabled={definition.kind === 'side-chat' && !props.sideChatAvailable}
              onClick={() => props.onOpen(definition.kind)}
            />
          ))}
        </List>
      </div>
    </div>
  );
}

function launcherCopyKey(
  kind: SessionWorkbarTabKind,
): keyof WorkbarCopy['launcher'] {
  return kind === 'side-chat'
    ? 'sideChat'
    : kind === 'work-board'
      ? 'workBoard'
      : kind;
}

export function WorkbarSurface(props: {
  workspace?: 'session' | 'workhub';
  sessionId?: string;
  projectId?: string | null;
  projectAliases?: readonly string[];
  hidden: boolean;
  onDismissPanel: (placement: SessionWorkbarPlacement) => void;
  onToggleRightPanel(): void;
  panelsState: SessionWorkbarPanelsState;
  rightCollapsed: boolean;
  bottomOpen: boolean;
  onActivateTab: (placement: SessionWorkbarPlacement, tabId: string) => void;
  onCloseTab: (placement: SessionWorkbarPlacement, tab: SessionWorkbarTab) => void;
  onOpenLauncher: (placement: SessionWorkbarPlacement) => void;
  onRequestOpenTab: (
    placement: SessionWorkbarPlacement,
    kind: SessionWorkbarTabKind,
  ) => void;
  quotes?: readonly QuoteCompanionPanelState[];
  onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  onContentStateChange?: (panelId: string, hasContent: boolean) => void;
  onInitialPromptStarted?: (panelId: string) => void;
  onPromptAccepted?: (panelId: string, prompt: string) => void;
  onActivityStateChange?: (panelId: string, active: boolean) => void;
  activeSideChatPanelIds?: ReadonlySet<string>;
  sourceSession?: SessionSummary;
  modelChoices?: readonly ChatModelChoice[];
  onStartWorkBoardTask?: (item: WorkBoardItem) => void;
  resolveWorkBoardStartTask?: (item: WorkBoardItem) => { ok: boolean; message?: string };
  onOpenWorkBoardSession?: (link: WorkBoardLinkedSession) => void;
  workBoardStartTaskEnabled?: boolean;
  confirmBypass: () => Promise<boolean>;
}) {
  const { inspector } = useWorkbarServices();
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).workbar;
  const tools = workbarToolsForWorkspace(props.workspace);
  const [artifactCount, setArtifactCount] = useState({ sessionId: props.sessionId, count: 0 });
  const allowedPanels = (['right', 'bottom'] as const).reduce((panels, placement) => {
    const tabIds = panels[placement].tabs.filter((tab) => !tools.some((tool) => tool.kind === tab.kind)).map((tab) => tab.id);
    return tabIds.length ? reduceWorkbarPanels(panels, { type: 'close', placement, tabIds }) : panels;
  }, props.panelsState);
  const visiblePanels = projectWorkbarPanelsForSession(
    allowedPanels, props.sessionId,
    new Set(props.quotes?.map((quote) => `side-chat:${quote.id}`)),
  );
  const placements: SessionWorkbarPlacement[] = ['right', 'bottom'];
  const positionedTabs = placements.flatMap((placement) =>
    allowedPanels[placement].tabs.map((tab) => ({ placement, tab })),
  );

  return (
    <div className="maka-workbar-workspace-contents">
      {!props.hidden && props.sessionId && <WorkbarEdgeToggle label={getShellCopy(locale).chrome[props.rightCollapsed ? 'expandWorkbar' : 'collapseWorkbar']} collapsed={props.rightCollapsed} onToggle={props.onToggleRightPanel} />}
      {placements.map((placement) => {
        const panel = visiblePanels[placement];
        const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
        const showingLauncher = panel.launcherOpen || !activeTab;
        const collapsed =
          placement === 'right' ? props.rightCollapsed : !props.bottomOpen;
        return (
          <Card
            key={placement}
            variant="transparent"
            padding={0}
            height="100%"
            className="maka-session-workbar maka-session-workbar-frame"
            data-placement={placement}
            data-collapsed={collapsed || undefined}
            hidden={props.hidden}
            data-maka-contract={`session-workbar-${placement}`}
            role="complementary"
            aria-label={copy.ariaLabel}
          >
            <div
              className="maka-session-workbar-toolbar"
              role="toolbar"
              aria-label={copy.sectionsAriaLabel}
            >
              <WorkbarTabStrip
                key={`${props.sessionId}:${props.workspace}`}
                tabs={panel.tabs}
                activeTabId={showingLauncher ? null : panel.activeTabId}
                activeSideChatPanelIds={props.activeSideChatPanelIds}
                artifactCount={artifactCount.sessionId === props.sessionId ? artifactCount.count : 0}
                sideChatAvailable={props.sourceSession !== undefined}
                onActivate={(tabId) => props.onActivateTab(placement, tabId)}
                onOpenKind={(kind) => props.onRequestOpenTab(placement, kind)}
                onClose={(tab) => props.onCloseTab(placement, tab)}
                tools={tools}
                placement={placement}
              />
            </div>
            <WorkbarPanel active={showingLauncher} placement={placement}>
              <WorkbarLauncher
                tools={tools}
                onOpen={(kind) => props.onRequestOpenTab(placement, kind)}
                sideChatAvailable={props.sourceSession !== undefined}
              />
            </WorkbarPanel>
          </Card>
        );
      })}
      {positionedTabs.map(({ placement, tab }) => {
        const panel = visiblePanels[placement];
        const activeTab = panel.tabs.find((candidate) => candidate.id === panel.activeTabId);
        const showingLauncher = panel.launcherOpen || !activeTab;
        const panelVisible =
          placement === 'right' ? !props.rightCollapsed : props.bottomOpen;
        const selected = !showingLauncher && activeTab?.id === tab.id;
        const active = panelVisible && selected;
        let content: ReactNode = null;
        if (tab.kind !== 'terminal' && !props.sessionId) return null;
        if (tab.kind === 'review') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.review} />}>
              <SessionReviewPanel
                key={props.sessionId}
                sessionId={props.sessionId!}
                active={!props.hidden && active}
              />
            </Suspense>
          );
        } else if (tab.kind === 'terminal') {
          const terminalRef = terminalRefFromWorkbarTab(tab);
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.terminal} />}>
              <SessionTerminalPanel
                sessionId={tab.ownerSessionId ?? props.sessionId!}
                terminalRef={terminalRef}
                active={!props.hidden && active}
              />
            </Suspense>
          );
        } else if (tab.kind === 'work-board') {
          content = (
            <WorkBoardPanel
              projectId={props.projectId ?? null}
              projectAliases={props.projectAliases}
              onStartTask={props.onStartWorkBoardTask}
              resolveStartTask={props.resolveWorkBoardStartTask}
              onOpenLinkedSession={props.onOpenWorkBoardSession}
              startTaskEnabled={props.workBoardStartTaskEnabled}
            />
          );
        } else if (tab.kind === 'browser') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.browser} />}>
              <BrowserPanel
                key={props.sessionId}
                sessionId={props.sessionId!}
                hidden={props.hidden || !active}
              />
            </Suspense>
          );
        } else if (tab.kind === 'files') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.files} />}>
              <ArtifactPane
                key={props.sessionId}
                sessionId={props.sessionId!}
                refreshEnabled={!props.hidden && panelVisible}
                onCountChange={(count) => setArtifactCount((current) =>
                  current.sessionId === props.sessionId && current.count === count
                    ? current : { sessionId: props.sessionId, count })}
                onDismiss={() => props.onDismissPanel(placement)}
              />
            </Suspense>
          );
        } else if (tab.kind === 'inspector') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.inspector} />}>
              <SessionInspectorPanel
                inspector={inspector}
                copy={getDesktopConversationCopy(locale).inspector}
                key={props.sessionId}
                sessionId={props.sessionId!}
                active={!props.hidden && active}
              />
            </Suspense>
          );
        } else {
          const panelId = tab.id.slice('side-chat:'.length);
          const quote = props.quotes?.find((candidate) => candidate.id === panelId);
          if (quote) {
            content = (
              <QuoteCompanionPanel
                panelId={quote.id}
                active={!props.hidden && active}
                quotes={quote.quotes}
                initialPrompt={quote.initialPrompt}
                sourceSession={props.sourceSession}
                modelChoices={props.modelChoices ?? []}
                confirmBypass={props.confirmBypass}
                onQuotesConsumed={props.onQuotesConsumed ?? (() => {})}
                onRemoveQuote={props.onRemoveQuote}
                onForkVisibilityChange={props.onForkVisibilityChange}
                onContentStateChange={props.onContentStateChange}
                onInitialPromptStarted={props.onInitialPromptStarted}
                onPromptAccepted={props.onPromptAccepted}
                onActivityStateChange={props.onActivityStateChange}
              />
            );
          }
        }
        return content ? (
          <WorkbarPanel
            key={tab.id}
            id={`maka-workbar-panel-${tab.id}`}
            active={selected && !props.hidden}
            collapsed={!panelVisible}
            placement={placement}
            overlay
            className={
              tab.kind === 'side-chat' ? 'maka-quote-workbar-panel' : undefined
            }
          >
            {content}
          </WorkbarPanel>
        ) : null;
      })}
    </div>
  );
}
