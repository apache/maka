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

import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Composer, useUiLocale, type ChatModelChoice } from '@maka/ui';
import {
  ICON_SIZE,
  Activity,
  Check,
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
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Kbd } from '@astryxdesign/core/Kbd';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import type { SessionSummary } from '@maka/core/session';
import { QuoteCompanionPanel } from '../tools/side-chat/quote-companion-panel';
import {
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
  type SessionWorkbarPanelsState,
  type SessionWorkbarPlacement,
  terminalRefFromWorkbarTab,
} from '../model/workbar-tabs';
import {
  WORKBAR_TOOL_DEFINITIONS,
  workbarToolDefinition,
  type WorkbarToolDefinition,
} from '../model/workbar-tool-definitions';
import { WorkbarToggle } from './workbar-toggle';
import { WorkBoardPanel } from '../../../work-board-panel.js';
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
  import('../tools/inspector/session-inspector-panel').then((module) => ({
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

/**
 * The strip, and the one control that opens and closes faces.
 *
 * `Tab` renders `endContent` inside its own `<button>`, so a per-tab close
 * would nest a button in a button, and `TabList` warns when a `role="tablist"`
 * strip's direct children are not tabs. Opening and closing therefore share the
 * [+] menu: every face is listed, the open ones carry a checkmark, and picking
 * one toggles it. The menu holds no shortcuts — the launcher below lists every
 * face with its own, and that is where a shortcut is learned.
 */
function WorkbarFaceMenu(props: {
  tabs: readonly SessionWorkbarTab[];
  sideChatAvailable: boolean;
  onOpen: (kind: SessionWorkbarTabKind) => void;
  onCloseKind: (kind: SessionWorkbarTabKind) => void;
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  return (
    <DropdownMenu
      button={{
        variant: 'ghost',
        size: 'sm',
        isIconOnly: true,
        label: copy.openTab,
        icon: <Plus size={ICON_SIZE.control} aria-hidden />,
      }}
    >
      {WORKBAR_TOOL_DEFINITIONS.map((definition) => {
        const FaceIcon = FACE_ICON[definition.icon];
        const isOpen = props.tabs.some((tab) => tab.kind === definition.kind);
        return (
          <DropdownMenuItem
            key={definition.kind}
            label={faceLabel(definition.kind, copy)}
            icon={<FaceIcon size={ICON_SIZE.control} aria-hidden />}
            endContent={isOpen ? <Check size={ICON_SIZE.control} aria-hidden /> : undefined}
            isDisabled={definition.kind === 'side-chat' && !props.sideChatAvailable}
            hasCloseOnSelect={false}
            onClick={() =>
              isOpen
                ? props.onCloseKind(definition.kind)
                : props.onOpen(definition.kind)
            }
          />
        );
      })}
    </DropdownMenu>
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
  onOpenKind: (kind: SessionWorkbarTabKind) => void;
  onCloseKind: (kind: SessionWorkbarTabKind) => void;
  onCollapseRightPanel?: () => void;
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
                  value={tab.id}
                  label={tabLabel(tab, props.tabs, copy)}
                  panelId={`maka-workbar-panel-${tab.id}`}
                  icon={tabIcon(tab, running)}
                  endContent={count !== undefined ? <TabCount count={count} /> : undefined}
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
        onCloseKind={props.onCloseKind}
      />
      {props.placement === 'right' && props.onCollapseRightPanel ? (
        <WorkbarToggle
          collapsed={false}
          size="sm"
          className="maka-workbar-panel-toggle"
          onToggle={props.onCollapseRightPanel}
        />
      ) : null}
    </div>
  );
}

function WorkbarLauncher(props: {
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
          {WORKBAR_TOOL_DEFINITIONS.map((definition) => (
            <ListItem
              key={definition.kind}
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
  sessionId: string;
  projectId?: string | null;
  projectAliases?: readonly string[];
  hidden: boolean;
  onDismissPanel: (placement: SessionWorkbarPlacement) => void;
  panelsState: SessionWorkbarPanelsState;
  rightCollapsed: boolean;
  bottomOpen: boolean;
  onActivateTab: (placement: SessionWorkbarPlacement, tabId: string) => void;
  onCloseTab: (placement: SessionWorkbarPlacement, tab: SessionWorkbarTab) => void;
  onCloseTabs: (
    placement: SessionWorkbarPlacement,
    tabs: readonly SessionWorkbarTab[],
  ) => void;
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
  confirmBypass: () => Promise<boolean>;
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).workbar;
  const [artifactCount, setArtifactCount] = useState(0);
  const placements: SessionWorkbarPlacement[] = ['right', 'bottom'];
  const positionedTabs = placements.flatMap((placement) =>
    props.panelsState[placement].tabs.map((tab) => ({ placement, tab })),
  );

  return (
    <div className="maka-workbar-workspace-contents">
      {placements.map((placement) => {
        const panel = props.panelsState[placement];
        const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
        const showingLauncher = panel.launcherOpen || !activeTab;
        const visible =
          !props.hidden &&
          (placement === 'right' ? !props.rightCollapsed : props.bottomOpen);
        return (
          <Card
            key={placement}
            variant="transparent"
            padding={0}
            height="100%"
            className="maka-session-workbar maka-session-workbar-frame"
            data-placement={placement}
            data-collapsed={!visible || undefined}
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
                tabs={panel.tabs}
                activeTabId={showingLauncher ? null : panel.activeTabId}
                activeSideChatPanelIds={props.activeSideChatPanelIds}
                artifactCount={artifactCount}
                sideChatAvailable={props.sourceSession !== undefined}
                onActivate={(tabId) => props.onActivateTab(placement, tabId)}
                onOpenKind={(kind) => props.onRequestOpenTab(placement, kind)}
                onCloseKind={(kind) =>
                  props.onCloseTabs(
                    placement,
                    panel.tabs.filter((tab) => tab.kind === kind),
                  )
                }
                placement={placement}
                onCollapseRightPanel={
                  placement === 'right'
                    ? () => props.onDismissPanel('right')
                    : undefined
                }
              />
            </div>
            <WorkbarPanel active={visible && showingLauncher} placement={placement}>
              <WorkbarLauncher
                onOpen={(kind) => props.onRequestOpenTab(placement, kind)}
                sideChatAvailable={props.sourceSession !== undefined}
              />
            </WorkbarPanel>
          </Card>
        );
      })}
      {positionedTabs.map(({ placement, tab }) => {
        const panel = props.panelsState[placement];
        const activeTab = panel.tabs.find((candidate) => candidate.id === panel.activeTabId);
        const showingLauncher = panel.launcherOpen || !activeTab;
        const panelVisible =
          placement === 'right' ? !props.rightCollapsed : props.bottomOpen;
        const active =
          panelVisible && !showingLauncher && activeTab?.id === tab.id;
        let content: ReactNode = null;
        if (tab.kind === 'review') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.review} />}>
              <SessionReviewPanel
                sessionId={props.sessionId}
                active={!props.hidden && active}
              />
            </Suspense>
          );
        } else if (tab.kind === 'terminal') {
          const terminalRef = terminalRefFromWorkbarTab(tab);
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.terminal} />}>
              <SessionTerminalPanel
                sessionId={tab.ownerSessionId ?? props.sessionId}
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
            />
          );
        } else if (tab.kind === 'browser') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.browser} />}>
              <BrowserPanel
                sessionId={props.sessionId}
                hidden={props.hidden || !active}
              />
            </Suspense>
          );
        } else if (tab.kind === 'files') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.files} />}>
              <ArtifactPane
                sessionId={props.sessionId}
                onCountChange={setArtifactCount}
                onDismiss={() => props.onDismissPanel(placement)}
              />
            </Suspense>
          );
        } else if (tab.kind === 'inspector') {
          content = (
            <Suspense fallback={<WorkbarPanelLoading label={copy.inspector} />}>
              <SessionInspectorPanel
                sessionId={props.sessionId}
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
            active={active}
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
