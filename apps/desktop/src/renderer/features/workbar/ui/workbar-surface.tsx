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
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import {
  SessionTodoPanel,
  sessionTodoActiveCount,
  IconButton,
  Composer,
  useUiLocale,
  type ChatModelChoice,
} from '@maka/ui';
import {
  ICON_SIZE,
  Activity,
  Clipboard,
  FolderOpen,
  GitBranch,
  Globe,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Terminal,
  X,
} from '@maka/ui/icons';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { ContextMenu } from '@astryxdesign/core/ContextMenu';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Kbd } from '@astryxdesign/core/Kbd';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import type { SessionSummary } from '@maka/core/session';
import { QuoteCompanionPanel } from '../tools/side-chat/quote-companion-panel';
import {
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
  type SessionWorkbarPanelsState,
  type SessionWorkbarPlacement,
  type SessionWorkbarTabsState,
  sessionWorkbarTabsExcept,
  sessionWorkbarTabsToRight,
  terminalRefFromWorkbarTab,
} from '../model/workbar-tabs';
import {
  WORKBAR_TOOL_DEFINITIONS,
  workbarToolDefinition,
  type WorkbarToolDefinition,
} from '../model/workbar-tool-definitions';
import { useSessionTodo } from '../tools/tasks/use-session-todo';
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

type WorkbarCopy = ReturnType<typeof getDesktopConversationCopy>['workbar'];

export interface WorkbarSurfaceProps {
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
  onReorderTab: (
    placement: SessionWorkbarPlacement,
    tabId: string,
    targetTabId: string,
  ) => void;
  onMoveTab: (
    placement: SessionWorkbarPlacement,
    tabId: string,
    direction: 'left' | 'right',
  ) => void;
  onMoveTabToPanel: (tabId: string, target: SessionWorkbarPlacement) => void;
  onPinTab: (tabId: string) => void;
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
}

interface WorkbarSurfaceRenderContext {
  active: boolean;
  copy: WorkbarCopy;
  placement: SessionWorkbarPlacement;
  props: WorkbarSurfaceProps;
  sessionTodo: ReturnType<typeof useSessionTodo>;
  setArtifactCount: (count: number) => void;
  tab: SessionWorkbarTab;
}

interface WorkbarSurfaceDescriptor<Kind extends SessionWorkbarTabKind> {
  readonly kind: Kind;
  readonly icon: typeof Activity;
  readonly label: (
    tab: SessionWorkbarTab,
    tabs: readonly SessionWorkbarTab[],
    copy: WorkbarCopy,
  ) => string;
  readonly launcherLabel: (copy: WorkbarCopy) => string;
  readonly launcherDescription: (copy: WorkbarCopy) => string;
  readonly panelClassName?: string;
  readonly render: (context: WorkbarSurfaceRenderContext) => ReactNode;
}

type WorkbarSurfaceDescriptorsByKind = {
  readonly [Kind in SessionWorkbarTabKind]: WorkbarSurfaceDescriptor<Kind>;
};

const WORKBAR_ICON_BY_NAME = {
  activity: Activity,
  clipboard: Clipboard,
  folder: FolderOpen,
  'git-branch': GitBranch,
  globe: Globe,
  'list-todo': ListTodo,
  'message-circle-question': MessageCircleQuestion,
  terminal: Terminal,
} satisfies Record<WorkbarToolDefinition['icon'], typeof Activity>;

function defineWorkbarSurfaceDescriptor<Kind extends SessionWorkbarTabKind>(
  kind: Kind,
  descriptor: Omit<WorkbarSurfaceDescriptor<Kind>, 'icon' | 'kind'>,
): WorkbarSurfaceDescriptor<Kind> {
  return {
    ...descriptor,
    kind,
    icon: WORKBAR_ICON_BY_NAME[workbarToolDefinition(kind).icon],
  };
}

function WorkbarPanelLoading(props: { label: string }) {
  return (
    <div className="maka-workbar-panel-loading">
      <Spinner size="sm" shade="subtle" label={props.label} />
    </div>
  );
}

function WorkbarPanel(props: {
  active: boolean;
  placement: SessionWorkbarPlacement;
  overlay?: boolean;
  preview?: boolean;
  onPin?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const pinPreview = (target: EventTarget | null) => {
    if (!props.preview) return;
    if (
      target instanceof Element &&
      target.closest('[data-tab-preview-pin-exempt]')
    ) {
      return;
    }
    props.onPin?.();
  };
  return (
    <Section
      variant="transparent"
      padding={0}
      hidden={!props.active}
      data-placement={props.placement}
      data-overlay={props.overlay || undefined}
      data-preview={props.preview || undefined}
      onPointerDownCapture={(event) => pinPreview(event.target)}
      onKeyDownCapture={(event) => pinPreview(event.target)}
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

const WORKBAR_SURFACE_DESCRIPTOR_BY_KIND: WorkbarSurfaceDescriptorsByKind = {
  'side-chat': defineWorkbarSurfaceDescriptor('side-chat', {
    label: (tab, tabs, copy) => {
      if (tab.title?.trim()) return tab.title.trim();
      const index =
        tab.ordinal ??
        tabs.filter((candidate) => candidate.kind === 'side-chat').findIndex(
          (candidate) => candidate.id === tab.id,
        ) + 1;
      return index <= 1 ? copy.sideChat : copy.sideChatNumbered(index);
    },
    launcherLabel: (copy) => copy.sideChat,
    launcherDescription: (copy) => copy.launcher.sideChat,
    panelClassName: 'maka-quote-workbar-panel',
    render: ({ active, props, tab }) => {
      const panelId = tab.id.slice('side-chat:'.length);
      const quote = props.quotes?.find((candidate) => candidate.id === panelId);
      if (!quote) return null;
      return (
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
    },
  }),
  review: defineWorkbarSurfaceDescriptor('review', {
    label: (_tab, _tabs, copy) => copy.review,
    launcherLabel: (copy) => copy.review,
    launcherDescription: (copy) => copy.launcher.review,
    render: ({ active, copy, props }) => (
      <Suspense fallback={<WorkbarPanelLoading label={copy.review} />}>
        <SessionReviewPanel
          sessionId={props.sessionId}
          active={!props.hidden && active}
        />
      </Suspense>
    ),
  }),
  terminal: defineWorkbarSurfaceDescriptor('terminal', {
    label: (tab, _tabs, copy) =>
      tab.ordinal && tab.ordinal > 1
        ? copy.terminalNumbered(tab.ordinal)
        : copy.terminal,
    launcherLabel: (copy) => copy.terminal,
    launcherDescription: (copy) => copy.launcher.terminal,
    render: ({ active, copy, props, tab }) => (
      <Suspense fallback={<WorkbarPanelLoading label={copy.terminal} />}>
        <SessionTerminalPanel
          sessionId={tab.ownerSessionId ?? props.sessionId}
          terminalRef={terminalRefFromWorkbarTab(tab)}
          active={!props.hidden && active}
        />
      </Suspense>
    ),
  }),
  browser: defineWorkbarSurfaceDescriptor('browser', {
    label: (_tab, _tabs, copy) => copy.browser,
    launcherLabel: (copy) => copy.browser,
    launcherDescription: (copy) => copy.launcher.browser,
    render: ({ active, copy, props }) => (
      <Suspense fallback={<WorkbarPanelLoading label={copy.browser} />}>
        <BrowserPanel
          sessionId={props.sessionId}
          hidden={props.hidden || !active}
        />
      </Suspense>
    ),
  }),
  files: defineWorkbarSurfaceDescriptor('files', {
    label: (_tab, _tabs, copy) => copy.files,
    launcherLabel: (copy) => copy.files,
    launcherDescription: (copy) => copy.launcher.files,
    render: ({ copy, placement, props, setArtifactCount }) => (
      <Suspense fallback={<WorkbarPanelLoading label={copy.files} />}>
        <ArtifactPane
          sessionId={props.sessionId}
          onCountChange={setArtifactCount}
          onDismiss={() => props.onDismissPanel(placement)}
        />
      </Suspense>
    ),
  }),
  tasks: defineWorkbarSurfaceDescriptor('tasks', {
    label: (_tab, _tabs, copy) => copy.tasks,
    launcherLabel: (copy) => copy.tasks,
    launcherDescription: (copy) => copy.launcher.tasks,
    render: ({ sessionTodo }) => (
      <SessionTodoPanel
        items={sessionTodo.items}
        loading={sessionTodo.loading}
        error={sessionTodo.error}
        onRetry={sessionTodo.retry}
      />
    ),
  }),
  'work-board': defineWorkbarSurfaceDescriptor('work-board', {
    label: (_tab, _tabs, copy) => copy.workBoard,
    launcherLabel: (copy) => copy.workBoard,
    launcherDescription: (copy) => copy.launcher.workBoard,
    render: ({ props }) => (
      <WorkBoardPanel
        projectId={props.projectId ?? null}
        projectAliases={props.projectAliases}
      />
    ),
  }),
  inspector: defineWorkbarSurfaceDescriptor('inspector', {
    label: (_tab, _tabs, copy) => copy.inspector,
    launcherLabel: (copy) => copy.inspector,
    launcherDescription: (copy) => copy.launcher.inspector,
    render: ({ active, copy, props }) => (
      <Suspense fallback={<WorkbarPanelLoading label={copy.inspector} />}>
        <SessionInspectorPanel
          sessionId={props.sessionId}
          active={!props.hidden && active}
        />
      </Suspense>
    ),
  }),
};

type RegisteredWorkbarSurfaceDescriptor =
  (typeof WORKBAR_SURFACE_DESCRIPTOR_BY_KIND)[SessionWorkbarTabKind];

const WORKBAR_SURFACE_DESCRIPTORS: readonly RegisteredWorkbarSurfaceDescriptor[] =
  WORKBAR_TOOL_DEFINITIONS.map(
    (definition) => WORKBAR_SURFACE_DESCRIPTOR_BY_KIND[definition.kind],
  );

function workbarSurfaceDescriptor(
  kind: SessionWorkbarTabKind,
): RegisteredWorkbarSurfaceDescriptor {
  return WORKBAR_SURFACE_DESCRIPTOR_BY_KIND[kind];
}

function tabLabel(
  tab: SessionWorkbarTab,
  tabs: readonly SessionWorkbarTab[],
  copy: WorkbarCopy,
): string {
  return workbarSurfaceDescriptor(tab.kind).label(tab, tabs, copy);
}

function tabIcon(tab: SessionWorkbarTab, active: boolean): ReactNode {
  if (active) {
    return (
      <Loader2
        size={ICON_SIZE.control}
        aria-hidden="true"
        className="maka-workbar-tab-icon maka-workbar-tab-spinner"
      />
    );
  }
  const Icon = workbarSurfaceDescriptor(tab.kind).icon;
  return <Icon size={ICON_SIZE.control} aria-hidden="true" className="maka-workbar-tab-icon" />;
}

function WorkbarTabStrip(props: {
  placement: SessionWorkbarPlacement;
  tabs: readonly SessionWorkbarTab[];
  activeTabId: string | null;
  taskCount: number;
  artifactCount: number;
  activeSideChatPanelIds?: ReadonlySet<string>;
  onActivate: (tabId: string) => void;
  onClose: (tab: SessionWorkbarTab) => void;
  onCloseTabs: (tabs: readonly SessionWorkbarTab[]) => void;
  onReorder: (tabId: string, targetTabId: string) => void;
  onMove: (tabId: string, direction: 'left' | 'right') => void;
  onMoveToPanel: (tabId: string, target: SessionWorkbarPlacement) => void;
  onPin: (tabId: string) => void;
  onOpenLauncher: () => void;
  onCollapseRightPanel?: () => void;
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  const tabListRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const targetId = event.over ? String(event.over.id) : null;
    if (targetId && targetId !== activeId) props.onReorder(activeId, targetId);
  };
  const handleTabKeyDown = (
    tabId: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const currentIndex = props.tabs.findIndex((tab) => tab.id === tabId);
    if (currentIndex < 0) return;
    const targetIndex =
      event.key === 'ArrowLeft'
        ? Math.max(0, currentIndex - 1)
        : event.key === 'ArrowRight'
          ? Math.min(props.tabs.length - 1, currentIndex + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? props.tabs.length - 1
              : -1;
    const target = props.tabs[targetIndex];
    if (!target || target.id === tabId) return;
    event.preventDefault();
    props.onActivate(target.id);
    window.requestAnimationFrame(() => {
      tabListRef.current
        ?.querySelector<HTMLElement>(
          `[data-workbar-tab-id="${CSS.escape(target.id)}"] [role="tab"]`,
        )
        ?.focus();
    });
  };
  useEffect(() => {
    const tabList = tabListRef.current;
    if (!tabList || !props.activeTabId) return;
    let frame = 0;
    const revealActiveTab = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const activeTab = tabList.querySelector<HTMLElement>(
          `[data-workbar-tab-id="${CSS.escape(props.activeTabId ?? '')}"]`,
        );
        if (!activeTab) return;
        const listBox = tabList.getBoundingClientRect();
        const tabBox = activeTab.getBoundingClientRect();
        if (tabBox.left < listBox.left) {
          tabList.scrollLeft -= listBox.left - tabBox.left;
        } else if (tabBox.right > listBox.right) {
          tabList.scrollLeft += tabBox.right - listBox.right;
        }
      });
    };
    revealActiveTab();
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(tabList);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [props.activeTabId, props.tabs.length]);
  return (
    <div className="maka-workbar-tab-strip">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={props.tabs.map((tab) => tab.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div
            ref={tabListRef}
            className="maka-workbar-tab-list"
            role="tablist"
            aria-label={copy.sectionsAriaLabel}
          >
            {props.tabs.map((tab, index) => (
              <SortableWorkbarTab
                key={tab.id}
                tab={tab}
                index={index}
                tabs={props.tabs}
                selected={tab.id === props.activeTabId}
                running={
                  tab.kind === 'side-chat' &&
                  props.activeSideChatPanelIds?.has(
                    tab.id.slice('side-chat:'.length),
                  ) === true
                }
                count={
                  tab.kind === 'tasks'
                    ? props.taskCount
                    : tab.kind === 'files'
                      ? props.artifactCount
                      : undefined
                }
                onActivate={props.onActivate}
                onClose={props.onClose}
                onCloseTabs={props.onCloseTabs}
                onMove={props.onMove}
                placement={props.placement}
                onMoveToPanel={props.onMoveToPanel}
                onPin={props.onPin}
                onKeyDown={handleTabKeyDown}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <Tooltip content={copy.openTab}>
        <IconButton
          label={copy.openTab}
          icon={<Plus size={ICON_SIZE.control} aria-hidden />}
          variant="ghost"
          size="sm"
          className="maka-workbar-new-tab"
          onClick={props.onOpenLauncher}
        />
      </Tooltip>
      {props.placement === 'right' && props.onCollapseRightPanel ? (
        <WorkbarToggle
          collapsed={false}
          className="maka-workbar-panel-toggle"
          onToggle={props.onCollapseRightPanel}
        />
      ) : null}
    </div>
  );
}

function SortableWorkbarTab(props: {
  placement: SessionWorkbarPlacement;
  tab: SessionWorkbarTab;
  index: number;
  tabs: readonly SessionWorkbarTab[];
  selected: boolean;
  running: boolean;
  count?: number;
  onActivate: (tabId: string) => void;
  onClose: (tab: SessionWorkbarTab) => void;
  onCloseTabs: (tabs: readonly SessionWorkbarTab[]) => void;
  onMove: (tabId: string, direction: 'left' | 'right') => void;
  onMoveToPanel: (tabId: string, target: SessionWorkbarPlacement) => void;
  onPin: (tabId: string) => void;
  onKeyDown: (
    tabId: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  const label = tabLabel(props.tab, props.tabs, copy);
  const {
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: props.tab.id });
  const style = {
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, 0, 0)`
      : undefined,
    transition,
  } satisfies CSSProperties;
  const otherTabs = sessionWorkbarTabsExcept(
    {
      tabs: [...props.tabs],
      activeTabId: props.tab.id,
      launcherOpen: false,
      activationHistory: [props.tab.id],
    },
    props.tab.id,
  );
  const tabsToRight = sessionWorkbarTabsToRight(
    {
      tabs: [...props.tabs],
      activeTabId: props.tab.id,
      launcherOpen: false,
      activationHistory: [props.tab.id],
    },
    props.tab.id,
  );

  return (
    <ContextMenu
      className="maka-workbar-tab-context"
      label={copy.tabMenu(label)}
      size="sm"
      items={[
        ...(props.tab.preview
          ? [
              {
                label: copy.pinTab,
                onClick: () => props.onPin(props.tab.id),
              },
              { type: 'divider' as const },
            ]
          : []),
        {
          label: copy.moveLeft,
          isDisabled: props.index === 0,
          onClick: () => props.onMove(props.tab.id, 'left'),
        },
        {
          label: copy.moveRight,
          isDisabled: props.index === props.tabs.length - 1,
          onClick: () => props.onMove(props.tab.id, 'right'),
        },
        {
          label:
            props.placement === 'right'
              ? copy.moveToBottom
              : copy.moveToRight,
          onClick: () =>
            props.onMoveToPanel(
              props.tab.id,
              props.placement === 'right' ? 'bottom' : 'right',
            ),
        },
        { type: 'divider' },
        {
          label: copy.close,
          onClick: () => props.onClose(props.tab),
        },
        {
          label: copy.closeOthers,
          isDisabled: otherTabs.length === 0,
          onClick: () => props.onCloseTabs(otherTabs),
        },
        {
          label: copy.closeToRight,
          isDisabled: tabsToRight.length === 0,
          onClick: () => props.onCloseTabs(tabsToRight),
        },
      ]}
    >
      <div
        ref={setNodeRef}
        className="maka-workbar-tab"
        data-workbar-tab-id={props.tab.id}
        data-active={props.selected || undefined}
        data-dragging={isDragging || undefined}
        data-running={props.running || undefined}
        data-preview={props.tab.preview || undefined}
        style={style}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          role="tab"
          label={
            props.count !== undefined
              ? `${label}, ${props.count}`
              : label
          }
          aria-selected={props.selected}
          aria-busy={props.running || undefined}
          tabIndex={props.selected ? 0 : -1}
          className="maka-workbar-tab-select"
          onClick={() => props.onActivate(props.tab.id)}
          {...listeners}
          onKeyDown={(event) => props.onKeyDown(props.tab.id, event)}
          onDoubleClick={() => {
            if (props.tab.preview) props.onPin(props.tab.id);
          }}
          icon={tabIcon(props.tab, props.running)}
          endContent={props.count !== undefined ? <TabCount count={props.count} /> : undefined}
        >
          <span
            className="maka-workbar-tab-label"
            title={props.tab.preview ? `${label} · ${copy.pinTabHint}` : label}
          >
            {label}
          </span>
        </Button>
        <Tooltip content={copy.closeTab(label)}>
          <IconButton
            label={copy.closeTab(label)}
            icon={<X size={ICON_SIZE.meta} aria-hidden />}
            variant="ghost"
            size="sm"
            className="maka-workbar-tab-close"
            onClick={() => props.onClose(props.tab)}
          />
        </Tooltip>
      </div>
    </ContextMenu>
  );
}

function WorkbarLauncher(props: {
  onOpen: (kind: SessionWorkbarTabKind) => void;
  sideChatAvailable: boolean;
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  return (
    <div className="maka-workbar-launcher">
      <div className="maka-workbar-launcher-frame">
        <List
          className="maka-workbar-launcher-list"
          density="compact"
          header={<Heading level={4}>{copy.openTools}</Heading>}
        >
          {WORKBAR_SURFACE_DESCRIPTORS.map((descriptor) => {
            const definition = workbarToolDefinition(descriptor.kind);
            const shortcut =
              'shortcut' in definition ? definition.shortcut : undefined;
            return (
              <ListItem
                key={descriptor.kind}
                startContent={<Icon icon={descriptor.icon} size="sm" color="secondary" />}
                label={descriptor.launcherLabel(copy)}
                description={descriptor.launcherDescription(copy)}
                endContent={
                  shortcut ? (
                    <Kbd keys={shortcut} />
                  ) : undefined
                }
                isDisabled={descriptor.kind === 'side-chat' && !props.sideChatAvailable}
                onClick={() => props.onOpen(descriptor.kind)}
              />
            );
          })}
        </List>
      </div>
    </div>
  );
}

export function WorkbarSurface(props: WorkbarSurfaceProps) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).workbar;
  const sessionTodo = useSessionTodo(props.sessionId, {
    locale,
    loadFailed: copy.todoLoadFailed,
  });
  const taskCount = sessionTodoActiveCount(sessionTodo.items);
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
                taskCount={taskCount}
                artifactCount={artifactCount}
                onActivate={(tabId) => props.onActivateTab(placement, tabId)}
                onClose={(tab) => props.onCloseTab(placement, tab)}
                onCloseTabs={(tabs) => props.onCloseTabs(placement, tabs)}
                onReorder={(tabId, targetTabId) =>
                  props.onReorderTab(placement, tabId, targetTabId)
                }
                onMove={(tabId, direction) =>
                  props.onMoveTab(placement, tabId, direction)
                }
                onMoveToPanel={props.onMoveTabToPanel}
                onPin={props.onPinTab}
                placement={placement}
                onOpenLauncher={() => props.onOpenLauncher(placement)}
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
        const descriptor = workbarSurfaceDescriptor(tab.kind);
        const content = descriptor.render({
          active,
          copy,
          placement,
          props,
          sessionTodo,
          setArtifactCount,
          tab,
        });
        return content ? (
          <WorkbarPanel
            key={tab.id}
            active={active}
            placement={placement}
            overlay
            preview={tab.preview}
            onPin={() => props.onPinTab(tab.id)}
            className={descriptor.panelClassName}
          >
            {content}
          </WorkbarPanel>
        ) : null;
      })}
    </div>
  );
}
