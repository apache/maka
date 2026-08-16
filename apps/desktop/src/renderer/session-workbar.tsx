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
  TaskLedgerPanel,
  deriveTaskLedgerPanelModel,
  IconButton,
  useUiLocale,
  type ChatModelChoice,
  type Composer,
} from '@maka/ui';
import {
  ICON_SIZE,
  Activity,
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
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import type { SessionSummary } from '@maka/core/session';
import { QuoteCompanionPanel } from './quote-companion-panel';
import {
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
  type SessionWorkbarPanelsState,
  type SessionWorkbarPlacement,
  type SessionWorkbarTabsState,
  sessionWorkbarTabsExcept,
  sessionWorkbarTabsToRight,
  terminalRefFromWorkbarTab,
} from './session-workbar-tabs';
import { useSessionTasks } from './use-session-tasks';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  QuoteCompanionPanelState,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';

const ArtifactPane = lazy(() =>
  import('./artifact-pane').then((module) => ({ default: module.ArtifactPane })),
);
const BrowserPanel = lazy(() =>
  import('./browser-panel').then((module) => ({ default: module.BrowserPanel })),
);
const SessionInspectorPanel = lazy(() =>
  import('./session-inspector-panel').then((module) => ({
    default: module.SessionInspectorPanel,
  })),
);
const SessionReviewPanel = lazy(() =>
  import('./session-review-panel').then((module) => ({
    default: module.SessionReviewPanel,
  })),
);
const SessionTerminalPanel = lazy(() =>
  import('./session-terminal-panel').then((module) => ({
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

function tabLabel(
  tab: SessionWorkbarTab,
  tabs: readonly SessionWorkbarTab[],
  copy: ReturnType<typeof getDesktopConversationCopy>['workbar'],
): string {
  switch (tab.kind) {
    case 'review':
      return copy.review;
    case 'terminal':
      return tab.ordinal && tab.ordinal > 1
        ? copy.terminalNumbered(tab.ordinal)
        : copy.terminal;
    case 'tasks':
      return copy.tasks;
    case 'browser':
      return copy.browser;
    case 'files':
      return copy.files;
    case 'inspector':
      return copy.inspector;
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
  }
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
  const Icon =
    tab.kind === 'review'
      ? GitBranch
      : tab.kind === 'terminal'
        ? Terminal
        : tab.kind === 'tasks'
          ? ListTodo
          : tab.kind === 'browser'
            ? Globe
            : tab.kind === 'files'
              ? FolderOpen
              : tab.kind === 'inspector'
                ? Activity
                : MessageCircleQuestion;
  return <Icon size={ICON_SIZE.control} aria-hidden="true" className="maka-workbar-tab-icon" />;
}

function WorkbarTabStrip(props: {
  placement: SessionWorkbarPlacement;
  tabs: readonly SessionWorkbarTab[];
  activeTabId: string | null;
  taskCount: number;
  artifactCount: number;
  preparingSideChatPanelIds?: ReadonlySet<string>;
  activeSideChatPanelIds?: ReadonlySet<string>;
  onActivate: (tabId: string) => void;
  onClose: (tab: SessionWorkbarTab) => void;
  onCloseTabs: (tabs: readonly SessionWorkbarTab[]) => void;
  onReorder: (tabId: string, targetTabId: string) => void;
  onMove: (tabId: string, direction: 'left' | 'right') => void;
  onMoveToPanel: (tabId: string, target: SessionWorkbarPlacement) => void;
  onPin: (tabId: string) => void;
  onOpenLauncher: () => void;
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
  const busyTabIds = new Set(
    props.tabs
      .filter(
        (tab) =>
          tab.kind === 'side-chat' &&
          props.preparingSideChatPanelIds?.has(
            tab.id.slice('side-chat:'.length),
          ) === true,
      )
      .map((tab) => tab.id),
  );
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
                busy={
                  busyTabIds.has(tab.id)
                }
                running={
                  tab.kind === 'side-chat' &&
                  props.activeSideChatPanelIds?.has(
                    tab.id.slice('side-chat:'.length),
                  ) === true
                }
                busyTabIds={busyTabIds}
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
    </div>
  );
}

function SortableWorkbarTab(props: {
  placement: SessionWorkbarPlacement;
  tab: SessionWorkbarTab;
  index: number;
  tabs: readonly SessionWorkbarTab[];
  selected: boolean;
  busy: boolean;
  running: boolean;
  busyTabIds: ReadonlySet<string>;
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
  } = useSortable({ id: props.tab.id, disabled: props.busy });
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
  ).filter((tab) => !props.busyTabIds.has(tab.id));
  const tabsToRight = sessionWorkbarTabsToRight(
    {
      tabs: [...props.tabs],
      activeTabId: props.tab.id,
      launcherOpen: false,
      activationHistory: [props.tab.id],
    },
    props.tab.id,
  ).filter((tab) => !props.busyTabIds.has(tab.id));

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
          isDisabled: props.busy || props.index === 0,
          onClick: () => props.onMove(props.tab.id, 'left'),
        },
        {
          label: copy.moveRight,
          isDisabled: props.busy || props.index === props.tabs.length - 1,
          onClick: () => props.onMove(props.tab.id, 'right'),
        },
        {
          label:
            props.placement === 'right'
              ? copy.moveToBottom
              : copy.moveToRight,
          isDisabled: props.busy,
          onClick: () =>
            props.onMoveToPanel(
              props.tab.id,
              props.placement === 'right' ? 'bottom' : 'right',
            ),
        },
        { type: 'divider' },
        {
          label: copy.close,
          isDisabled: props.busy,
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
        data-preparing={props.busy || undefined}
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
          aria-busy={props.busy || props.running || undefined}
          tabIndex={props.selected ? 0 : -1}
          className="maka-workbar-tab-select"
          onClick={() => props.onActivate(props.tab.id)}
          {...listeners}
          onKeyDown={(event) => props.onKeyDown(props.tab.id, event)}
          onDoubleClick={() => {
            if (props.tab.preview) props.onPin(props.tab.id);
          }}
          icon={tabIcon(props.tab, props.busy || props.running)}
          endContent={props.count !== undefined ? <TabCount count={props.count} /> : undefined}
        >
          <span
            className="maka-workbar-tab-label"
            title={props.tab.preview ? `${label} · ${copy.pinTabHint}` : label}
          >
            {label}
          </span>
        </Button>
        {!props.busy ? (
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
        ) : null}
      </div>
    </ContextMenu>
  );
}

function WorkbarLauncher(props: {
  onOpen: (kind: SessionWorkbarTabKind) => void;
  sideChatAvailable: boolean;
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  const actions: Array<{
    kind: SessionWorkbarTabKind;
    label: string;
    description: string;
    icon: typeof Activity;
    shortcut?: string;
    disabled?: boolean;
  }> = [
    {
      kind: 'side-chat',
      label: copy.sideChat,
      description: copy.launcher.sideChat,
      icon: MessageCircleQuestion,
      shortcut: 'mod+alt+s',
      disabled: !props.sideChatAvailable,
    },
    {
      kind: 'review',
      label: copy.review,
      description: copy.launcher.review,
      icon: GitBranch,
      shortcut: 'ctrl+shift+g',
    },
    {
      kind: 'terminal',
      label: copy.terminal,
      description: copy.launcher.terminal,
      icon: Terminal,
      shortcut: 'ctrl+`',
    },
    {
      kind: 'browser',
      label: copy.browser,
      description: copy.launcher.browser,
      icon: Globe,
      shortcut: 'mod+t',
    },
    {
      kind: 'files',
      label: copy.files,
      description: copy.launcher.files,
      icon: FolderOpen,
      shortcut: 'mod+p',
    },
    {
      kind: 'tasks',
      label: copy.tasks,
      description: copy.launcher.tasks,
      icon: ListTodo,
    },
    {
      kind: 'inspector',
      label: copy.inspector,
      description: copy.launcher.inspector,
      icon: Activity,
    },
  ];
  return (
    <div className="maka-workbar-launcher">
      <List
        className="maka-workbar-launcher-list"
        density="compact"
        header={<Heading level={4}>{copy.openTools}</Heading>}
      >
        {actions.map((action) => (
          <ListItem
            key={action.kind}
            startContent={<Icon icon={action.icon} size="sm" color="secondary" />}
            label={action.label}
            description={action.description}
            endContent={
              action.shortcut ? (
                <Kbd keys={action.shortcut} />
              ) : undefined
            }
            isDisabled={action.disabled}
            onClick={() => props.onOpen(action.kind)}
          />
        ))}
      </List>
    </div>
  );
}

export function SessionWorkbar(props: {
  sessionId: string;
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
  onPreparingStateChange?: (panelId: string, preparing: boolean) => void;
  onInitialPromptStarted?: (panelId: string) => void;
  onPromptAccepted?: (panelId: string, prompt: string) => void;
  onActivityStateChange?: (panelId: string, active: boolean) => void;
  preparingSideChatPanelIds?: ReadonlySet<string>;
  activeSideChatPanelIds?: ReadonlySet<string>;
  sourceSession?: SessionSummary;
  modelChoices?: readonly ChatModelChoice[];
  mentionSkills?: ComponentProps<typeof Composer>['mentionSkills'];
  onSearchMentionFiles?: ComponentProps<typeof Composer>['onSearchMentionFiles'];
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workbar;
  const sessionTasks = useSessionTasks(props.sessionId);
  const taskCount = deriveTaskLedgerPanelModel(sessionTasks.tasks).activeCount;
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
          placement === 'right' ? !props.rightCollapsed : props.bottomOpen;
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
            <Toolbar
              className="maka-session-workbar-toolbar"
              label={copy.sectionsAriaLabel}
              size="sm"
              startContent={
                <WorkbarTabStrip
                  tabs={panel.tabs}
                  activeTabId={showingLauncher ? null : panel.activeTabId}
                  preparingSideChatPanelIds={props.preparingSideChatPanelIds}
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
                />
              }
            />
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
        } else if (tab.kind === 'tasks') {
          content = (
            <TaskLedgerPanel
              tasks={sessionTasks.tasks}
              loading={sessionTasks.loading}
              error={sessionTasks.error}
              onRetry={sessionTasks.retry}
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
                mentionSkills={props.mentionSkills}
                onSearchMentionFiles={props.onSearchMentionFiles}
                onQuotesConsumed={props.onQuotesConsumed ?? (() => {})}
                onRemoveQuote={props.onRemoveQuote}
                onForkVisibilityChange={props.onForkVisibilityChange}
                onContentStateChange={props.onContentStateChange}
                onPreparingStateChange={props.onPreparingStateChange}
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
            active={active}
            placement={placement}
            overlay
            preview={tab.preview}
            onPin={() => props.onPinTab(tab.id)}
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
