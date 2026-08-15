import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { formatCompactTimestamp } from '@maka/core/relative-time';
import {
  ICON_SIZE,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  FolderGit2,
  FolderOpen,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  SquarePen,
  Trash2,
} from './icons.js';
import { Badge } from '@astryxdesign/core/Badge';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';
import { VStack } from '@astryxdesign/core/Stack';
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { describeBlockedReason, presentSessionStatus } from './session-status-presentation.js';
import { SessionRenameDialog, type SessionRenameTarget } from './session-rename-dialog.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { getShellControlsCopy } from './shell-controls-copy.js';

type SessionRowActionId = 'flag' | 'archive' | 'rename' | 'delete';
type ProjectRowActionId = 'new' | 'relink' | 'rename' | 'archive' | 'restore';
type SessionHistoryGroupVariant = 'conversation' | 'project';

export interface SessionRowActions {
  onToggleFlag(sessionId: string, next: boolean): void | Promise<void>;
  onArchive(sessionId: string): void | Promise<void>;
  onUnarchive(sessionId: string): void | Promise<void>;
  onRename(sessionId: string, name: string): void | Promise<void>;
  onDelete(sessionId: string): void | Promise<void>;
}

export interface ProjectRowActions {
  onNew(projectId: string): void | Promise<void>;
  onRename(projectId: string, name: string): void | Promise<void>;
  onArchive(projectId: string): void | Promise<void>;
  onRestore(projectId: string): void | Promise<void>;
  onRelink?(projectId: string): void | Promise<void>;
}

export interface SessionHistoryGroup {
  id: string;
  label: string;
  sessions: SessionSummary[];
  project?: ProjectRecord;
}

export function SessionHistoryList(props: {
  sessions: SessionSummary[];
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  groups?: ReadonlyArray<SessionHistoryGroup>;
  worktreeSessionIds?: ReadonlySet<string>;
  projectActions?: ProjectRowActions;
  groupVariant?: SessionHistoryGroupVariant;
  /** Optional section chrome (title + end actions) wrapping the history. */
  heading?: string;
  headingEnd?: ReactNode;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
  /**
   * Creates a new task from a group header's trailing trigger (time grouping
   * only). Same handler as the rail's top-level 新任务 row: a session created
   * here lands where any new session lands; the trigger is a proximity entry,
   * not a different creation path. Absent = no trigger.
   */
  onNewTask?(): void;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const sessionListTitle = props.heading ?? copy.title;

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.matches('input, textarea, [contenteditable="true"]')) return;
    const row = active.closest<HTMLElement>(
      '[data-maka-contract="session-row"], [data-session-id]',
    );
    const sessionId =
      row?.dataset.sessionId ??
      row?.querySelector<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    if (sessionId && props.rowActions) {
      event.preventDefault();
      void props.rowActions.onDelete(sessionId);
    }
  }

  const body = (
    <SessionListGroups
      groups={
        props.groups
          ? props.groups.map((g) => ({
              key: g.id,
              label: g.label,
              sessions: g.sessions,
              project: g.project,
            }))
          : groupSessionsForHistory(props.sessions, locale).map((g) => ({
              key: g.id,
              label: g.label,
              sessions: g.sessions,
            }))
      }
      groupVariant={props.groupVariant ?? 'conversation'}
      activeId={props.activeId}
      streamingSessionIds={props.streamingSessionIds}
      staleSessionIds={props.staleSessionIds}
      worktreeSessionIds={props.worktreeSessionIds}
      onSelectSession={props.onSelectSession}
      rowActions={props.rowActions}
      projectActions={props.projectActions}
      onNewTask={props.onNewTask}
    />
  );

  // Outer SideNav is the sole navigation landmark; this is scroll content only.
  return (
    <div className="maka-session-list" role="group" aria-label={sessionListTitle} onKeyDown={handleListKeyDown}>
      {props.heading ? (
        <SideNavSection
          title={props.heading}
          endContent={props.headingEnd}
          className="maka-session-heading-section"
        >
          {body}
        </SideNavSection>
      ) : (
        body
      )}
    </div>
  );
}

function SessionListGroups(props: {
  groups: ReadonlyArray<{
    key: string;
    label: string;
    sessions: SessionSummary[];
    project?: ProjectRecord;
  }>;
  groupVariant: SessionHistoryGroupVariant;
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  worktreeSessionIds?: ReadonlySet<string>;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
  projectActions?: ProjectRowActions;
  onNewTask?(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const newTaskCopy = getShellControlsCopy(useUiLocale()).navigation.groupNewTask;
  const [renameTarget, setRenameTarget] = useState<SessionRenameTarget | null>(null);
  /**
   * The control the rename was started from, so focus can go back to it.
   *
   * Astryx's Dialog restores focus on its own — to whatever was focused when it
   * opened — and that is exactly what fails here. A menu-launched dialog opens
   * one frame AFTER the menu closed, and the two race: measured frame by frame,
   * the dialog's capture lands on the menu item (frames 1-3) while the menu
   * hands focus back to the trigger on frame 4. Restoring to a node that has
   * since been unmounted is a no-op, so the edit ended on <body> and the next
   * Tab started at the top of the window — while the delete confirm one item
   * below in the same menu returns the trigger.
   *
   * The opener is passed in rather than captured here, because the component
   * that renders the menu is the only one that can name it without racing.
   */
  const renameOpenerRef = useRef<HTMLElement | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const startRename = useCallback((target: SessionRenameTarget, opener: HTMLElement | null) => {
    renameOpenerRef.current = opener;
    setRenameTarget(target);
  }, []);

  function closeRename() {
    setRenameTarget(null);
    const opener = renameOpenerRef.current;
    renameOpenerRef.current = null;
    // After the dialog has left the DOM, not before: while it is still open it
    // is a native modal, everything outside it is inert, and a `focus()` there
    // is refused outright — measured, the call ran and the row's trigger stayed
    // unfocused.
    if (opener) window.requestAnimationFrame(() => opener.focus());
  }

  function commitRename(target: SessionRenameTarget, name: string) {
    const rename =
      target.kind === 'project' ? props.projectActions?.onRename : props.rowActions?.onRename;
    if (!rename) return;
    void Promise.resolve(rename(target.id, name)).catch(() => {
      // AppShell owns visible rename failure feedback.
    });
  }

  // Linked subagent sessions open in the main chat column, not as nested
  // sidebar rows. The host passes only root/user sessions here.
  const renderSessionRow = useCallback(
    (session: SessionSummary): ReactNode => (
      <SessionNavRow
        key={session.id}
        session={session}
        active={session.id === props.activeId}
        streaming={props.streamingSessionIds?.has(session.id) ?? false}
        stale={props.staleSessionIds?.has(session.id) ?? false}
        worktree={props.worktreeSessionIds?.has(session.id) ?? false}
        onSelectSession={props.onSelectSession}
        actions={props.rowActions}
        onStartRename={startRename}
      />
    ),
    [
      startRename,
      props.activeId,
      props.onSelectSession,
      props.rowActions,
      props.staleSessionIds,
      props.streamingSessionIds,
      props.worktreeSessionIds,
    ],
  );

  // Keyed per target so the field seeds from the name that row carries now,
  // with nothing to synchronise while the dialog is open.
  const renameDialog = renameTarget ? (
    <SessionRenameDialog
      key={renameTarget.id}
      target={renameTarget}
      onOpenChange={(open) => {
        if (!open) closeRename();
      }}
      onRename={commitRename}
    />
  ) : null;

  if (props.groupVariant === 'project') {
    const activeGroups = props.groups.filter((group) => group.project?.archivedAt === undefined);
    const archivedGroups = props.groups.filter((group) => group.project?.archivedAt !== undefined);

    function renderProjectGroup(
      group: (typeof props.groups)[number],
    ): ReactNode {
      const project = group.project;
      return (
        <ProjectNavRow
          key={group.key}
          groupKey={group.key}
          label={group.label}
          project={project}
          sessions={group.sessions}
          projectActions={props.projectActions}
          onStartRename={(opener) => {
            if (project) {
              startRename({ kind: 'project', id: project.id, name: project.name }, opener);
            }
          }}
          renderSession={renderSessionRow}
        />
      );
    }

    return (
      <>
        {renameDialog}
        {activeGroups.map(renderProjectGroup)}
        {archivedGroups.length > 0 && (
          <SideNavItem
            label={copy.archivedProjects}
            collapsible={{
              isCollapsed: !archivedExpanded,
              onCollapsedChange: (collapsed) => setArchivedExpanded(!collapsed),
            }}
          >
            {/* Always mount children: Astryx derives collapsible chrome from
                !!children. Nulling on collapse removes the chevron and makes
                the controlled isCollapsed prop a no-op. */}
            {archivedGroups.map(renderProjectGroup)}
          </SideNavItem>
        )}
      </>
    );
  }

  // Group-header new-task trigger (time grouping). Same HANDLER as the
  // rail's top-level 新任务 SideNavItem, but a different NAME
  // (navigation.groupNewTask): reusing copy.newTask would give two controls
  // the same accessible name, a strict-mode collision for
  // getByRole('button', { name: '新任务' }) and an ambiguity for screen
  // readers. IconButton + Tooltip is the icon-only pattern
  // SessionSidebarFooter already uses; the compact 24px box and column
  // alignment belong to sidebar.css.
  const newTaskAction = props.onNewTask ? (
    <Tooltip content={newTaskCopy}>
      <IconButton
        className="maka-group-new-task-button"
        variant="ghost"
        size="sm"
        label={newTaskCopy}
        icon={<Plus size={ICON_SIZE.control} aria-hidden="true" />}
        onClick={() => void props.onNewTask?.()}
      />
    </Tooltip>
  ) : undefined;

  return (
    <>
      {renameDialog}
      {props.groups.map((group) => {
        const items = group.sessions.map((session) => renderSessionRow(session));
        if (!group.label) {
          return (
            <div key={group.key} className="maka-session-group">
              {items}
            </div>
          );
        }
        return (
          <SideNavSection
            key={group.key}
            title={group.label}
            endContent={newTaskAction}
            className="maka-session-group"
          >
            {items}
          </SideNavSection>
        );
      })}
    </>
  );
}

function ProjectNavRow(props: {
  groupKey: string;
  label: string;
  project?: ProjectRecord;
  sessions: SessionSummary[];
  projectActions?: ProjectRowActions;
  onStartRename(opener: HTMLElement | null): void;
  renderSession(session: SessionSummary): ReactNode;
}) {
  // Collapsible only when there is a real session subtree. An empty VStack is
  // still truthy children for Astryx (!!children) and fabricates a disclosure.
  const hasSessions = props.sessions.length > 0;
  const hasActions = props.project !== undefined && props.projectActions !== undefined;
  return (
    <div data-project-id={props.groupKey} className="maka-project-row">
      {props.project && props.projectActions ? (
        <ProjectItemActions
          key="actions"
          project={props.project}
          actions={props.projectActions}
          onStartRename={props.onStartRename}
          position={hasSessions ? 'before-disclosure' : 'trailing'}
        />
      ) : null}
      <SideNavItem
        key="navigation"
        label={props.label}
        icon={FolderOpen}
        collapsible={hasSessions ? { defaultIsCollapsed: false } : undefined}
        endContent={
          <ProjectItemMeta
            project={props.project}
            sessionCount={props.sessions.length}
            reserveAction={hasActions}
          />
        }
      >
        {/* Nest indent zeroed one level in sidebar.css (time-sort left edge). */}
        {hasSessions ? (
          <VStack gap={0.5}>{props.sessions.map((session) => props.renderSession(session))}</VStack>
        ) : undefined}
      </SideNavItem>
    </div>
  );
}

const SessionNavRow = memo(function SessionNavRow(props: {
  session: SessionSummary;
  active: boolean;
  streaming: boolean;
  stale: boolean;
  worktree: boolean;
  onSelectSession(sessionId: string): void;
  actions?: SessionRowActions;
  onStartRename(target: SessionRenameTarget, opener: HTMLElement | null): void;
}) {
  const locale = useUiLocale();
  const metaTitle = formatSessionMeta(props.session, locale);

  return (
    <div
      className="maka-session-row"
      data-maka-contract="session-row"
      data-session-id={props.session.id}
      data-stale={props.stale ? 'true' : undefined}
      title={metaTitle}
    >
      <SideNavItem
        label={props.session.name}
        size="md"
        isSelected={props.active}
        onClick={(event) => {
          if (event.detail > 1 && props.actions) {
            props.onStartRename(
              {
                kind: 'session',
                id: props.session.id,
                name: props.session.name,
              },
              // The row's own button: a double-click starts the rename from
              // the row itself, not from the actions menu.
              event.currentTarget as HTMLElement,
            );
            return;
          }
          props.onSelectSession(props.session.id);
        }}
        endContent={
          <SessionItemMeta
            session={props.session}
            active={props.active}
            streaming={props.streaming}
            stale={props.stale}
            worktree={props.worktree}
            reserveAction={props.actions !== undefined}
          />
        }
      />
      {props.actions && (
        <SessionItemActions
          session={props.session}
          actions={props.actions}
          onStartRename={props.onStartRename}
        />
      )}
    </div>
  );
});

function ProjectItemMeta(props: {
  project?: ProjectRecord;
  sessionCount: number;
  reserveAction: boolean;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  return (
    <span className="maka-session-row-end maka-project-item-end">
      {props.project && !props.project.available && (
        <AlertTriangle size={ICON_SIZE.meta} aria-label={copy.projectUnavailable} />
      )}
      <Badge variant="neutral" label={props.sessionCount} />
      {props.reserveAction ? (
        <span className="maka-session-row-trailing" aria-hidden="true" />
      ) : null}
    </span>
  );
}

function ProjectItemActions(props: {
  project: ProjectRecord;
  actions: ProjectRowActions;
  onStartRename(opener: HTMLElement | null): void;
  position: 'before-disclosure' | 'trailing';
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const trailingRef = useRef<HTMLSpanElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<ProjectRowActionId | null>(null);
  const mountedRef = useMountedRef();
  const pendingActionRef = useRef<ProjectRowActionId | null>(null);
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const project = props.project;
  const actions = props.actions;

  useEffect(
    () => () => {
      pendingActionRef.current = null;
    },
    [],
  );

  function runProjectAction(actionId: ProjectRowActionId, action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    void (async () => {
      try {
        await action();
      } catch {
        // AppShell owns visible project-action failure feedback.
      } finally {
        pendingActionRef.current = null;
        if (mountedRef.current) setPendingAction(null);
      }
    })();
  }

  // Projects keep a permanent MoreMenu. It is a sibling of SideNavItem so the
  // row's collapse button and the menu remain separate interactive controls.
  const menuItems = project.archivedAt !== undefined
    ? [
        {
          label: copy.projectRestore,
          icon: ArchiveRestore,
          onClick: () => runProjectAction('restore', () => actions.onRestore(project.id)),
        },
      ]
    : [
        ...(project.available
          ? [
              {
                label: copy.projectNewTask,
                icon: SquarePen,
                onClick: () => runProjectAction('new', () => actions.onNew(project.id)),
              },
            ]
          : actions.onRelink
            ? [
              {
                label: copy.projectRelink,
                icon: Plug,
                onClick: () => runProjectAction('relink', () => actions.onRelink!(project.id)),
              },
            ]
            : []),
        {
          label: copy.projectRename,
          icon: Pencil,
          onClick: () => {
            // Read now, while the trigger is still the thing the user is on:
            // by the time the intent runs the menu has closed and focus is
            // mid-handover.
            const opener = trailingRef.current?.querySelector<HTMLElement>('button') ?? null;
            pendingMenuIntentRef.current = () => props.onStartRename(opener);
          },
        },
        {
          label: copy.projectArchive,
          icon: Archive,
          onClick: () => runProjectAction('archive', () => actions.onArchive(project.id)),
        },
      ];

  return (
    <span className="maka-session-row-action" data-position={props.position} ref={trailingRef}>
      <MoreMenu
        size="sm"
        label={copy.projectActionsAriaLabel(project.name)}
        isDisabled={pendingAction !== null}
        isMenuOpen={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) return;
          const intent = pendingMenuIntentRef.current;
          pendingMenuIntentRef.current = null;
          if (intent) window.requestAnimationFrame(intent);
        }}
        items={menuItems}
      />
    </span>
  );
}

const SessionItemMeta = memo(function SessionItemMeta(props: {
  session: SessionSummary;
  active: boolean;
  streaming: boolean;
  stale: boolean;
  worktree: boolean;
  reserveAction: boolean;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).sessions;
  const statusDot = resolveSessionStatusDot(props.session, props.streaming, props.active, locale);

  // Signal (status/unread) and action (MoreMenu) are orthogonal — same as
  // project rows (badge + menu). No hover XOR state machine.
  const signal = statusDot ? (
    <StatusDot
      variant={statusDot.variant}
      label={statusDot.label}
      isPulsing={statusDot.isPulsing}
      tooltip={statusDot.tooltip}
      data-session-status={props.session.status}
    />
  ) : shouldShowSessionUnreadDot(props.session, props.streaming, props.active) ? (
    <StatusDot variant="accent" label={copy.unreadAriaLabel} data-session-status="unread" />
  ) : null;

  return (
    <span className="maka-session-row-end">
      {props.stale && (
        <Tooltip content={copy.staleTitle}>
          {/* `yellow`, not `warning`. Astryx keeps two archives: the semantic
              names paint a solid saturated fill (maka's `warning` is a flat
              #ffce2f that does not adapt to dark mode), the colour names paint
              a tint. This pill sits on every stale row in the rail, where the
              chrome it replaced was an 18% wash — a solid block on each row
              reads as an alert the state does not mean. */}
          <Badge
            variant="yellow"
            label={copy.stale}
            className="maka-list-row-stale-pill"
            /* The reason belongs in the name, not only in the Tooltip. `title`
               used to carry it, and a screen reader read it as the accessible
               description; Astryx's Tooltip points `aria-describedby` at a
               popover that is `display: none` until hovered, so off the mouse
               the description computes to empty. */
            aria-label={`${copy.staleAriaLabel}. ${copy.staleTitle}`}
          />
        </Tooltip>
      )}
      {props.worktree && (
        <FolderGit2
          size={ICON_SIZE.meta}
          aria-label={copy.worktreeAriaLabel}
          className="maka-session-worktree-icon"
        />
      )}
      {signal}
      <span className="maka-session-row-trailing" aria-hidden="true">
        {!props.reserveAction && !signal && <span className="maka-session-row-trailing-spacer" />}
      </span>
    </span>
  );
});

function SessionItemActions(props: {
  session: SessionSummary;
  actions: SessionRowActions;
  onStartRename(target: SessionRenameTarget, opener: HTMLElement | null): void;
}) {
  const trailingRef = useRef<HTMLSpanElement>(null);
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<SessionRowActionId | null>(null);
  const mountedRef = useMountedRef();
  const pendingActionRef = useRef<SessionRowActionId | null>(null);
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const actions = props.actions;

  useEffect(
    () => () => {
      pendingActionRef.current = null;
    },
    [],
  );

  function runRowAction(actionId: SessionRowActionId, action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    void (async () => {
      try {
        await action();
      } catch {
        // AppShell owns visible session-action failure feedback.
      } finally {
        pendingActionRef.current = null;
        if (mountedRef.current) setPendingAction(null);
      }
    })();
  }

  return (
    <span
      className="maka-session-row-action"
      ref={trailingRef}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <MoreMenu
        size="sm"
        label={copy.actionsAriaLabel}
        isDisabled={pendingAction !== null}
        isMenuOpen={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) return;
          const intent = pendingMenuIntentRef.current;
          pendingMenuIntentRef.current = null;
          if (intent) window.requestAnimationFrame(intent);
        }}
        items={[
          {
            label: props.session.isFlagged ? copy.unpin : copy.pin,
            icon: props.session.isFlagged ? PinOff : Pin,
            onClick: () =>
              runRowAction('flag', () =>
                actions.onToggleFlag(props.session.id, !props.session.isFlagged),
              ),
          },
          {
            label: copy.rename,
            icon: Pencil,
            onClick: () => {
              // Read now, while the trigger is still the thing the user is on:
              // by the time the intent runs the menu has closed and focus is
              // mid-handover.
              const opener = trailingRef.current?.querySelector<HTMLElement>('button') ?? null;
              pendingMenuIntentRef.current = () =>
                props.onStartRename(
                  {
                    kind: 'session',
                    id: props.session.id,
                    name: props.session.name,
                  },
                  opener,
                );
            },
          },
          {
            label: props.session.isArchived ? copy.unarchive : copy.archive,
            icon: props.session.isArchived ? ArchiveRestore : Archive,
            onClick: () =>
              runRowAction('archive', () =>
                props.session.isArchived
                  ? actions.onUnarchive(props.session.id)
                  : actions.onArchive(props.session.id),
              ),
          },
          { type: 'divider' },
          {
            label: copy.delete,
            icon: Trash2,
            onClick: () => {
              pendingMenuIntentRef.current = () =>
                runRowAction('delete', () => actions.onDelete(props.session.id));
            },
          },
        ]}
      />
    </span>
  );
}

function resolveSessionStatusDot(
  session: SessionSummary,
  streaming: boolean,
  active: boolean,
  locale: UiLocale,
): { variant: StatusDotVariant; label: string; isPulsing?: boolean; tooltip?: string } | null {
  if (streaming) {
    const copy = getConversationCopy(locale).sessions;
    return {
      variant: 'accent',
      label: copy.respondingAriaLabel,
      isPulsing: true,
      tooltip: copy.respondingTitle,
    };
  }

  const status = session.status;
  if (status === 'active' && !active) {
    // Idle rows keep a quiet neutral dot (shell-side-nav pattern).
    return null;
  }
  if (status === 'active') return null;

  const { label, tone } = presentSessionStatus(status, locale);
  const blockedDetail =
    status === 'blocked' && session.blockedReason
      ? describeBlockedReason(session.blockedReason, locale)
      : null;
  return {
    variant: toneToStatusDotVariant(tone),
    label,
    isPulsing: status === 'running',
    tooltip: blockedDetail ? `${label} · ${blockedDetail}` : label,
  };
}

function toneToStatusDotVariant(
  tone: ReturnType<typeof presentSessionStatus>['tone'],
): StatusDotVariant {
  switch (tone) {
    case 'accent':
      return 'accent';
    case 'warning':
      return 'warning';
    case 'destructive':
      return 'error';
    case 'success':
      return 'success';
    case 'info':
      return 'accent';
    case 'muted':
    case 'neutral':
    default:
      return 'neutral';
  }
}

function shouldShowSessionUnreadDot(
  session: SessionSummary,
  streaming: boolean,
  active: boolean,
): boolean {
  if (active) return false;
  if (!session.hasUnread) return false;
  if (streaming) return false;
  return !SIDEBAR_UNREAD_SUPPRESSED_STATUSES.has(session.status);
}

const SIDEBAR_UNREAD_SUPPRESSED_STATUSES = new Set<string>([
  'running',
  'waiting_for_user',
  'blocked',
]);

interface SessionGroup {
  id: 'pinned' | 'unpinned';
  label: string;
  sessions: SessionSummary[];
}

function groupSessionsForHistory(sessions: SessionSummary[], locale: UiLocale): SessionGroup[] {
  const copy = getConversationCopy(locale).sessions;
  const ordered = [...sessions].sort((a, b) => {
    const timestampDelta = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
    return timestampDelta || a.id.localeCompare(b.id);
  });
  const pinned = ordered.filter((session) => session.isFlagged);
  const unpinned = ordered.filter((session) => !session.isFlagged);
  const groups: SessionGroup[] = [];
  if (pinned.length > 0) {
    groups.push({ id: 'pinned', label: copy.pinned, sessions: pinned });
  }
  if (unpinned.length > 0) {
    // Visible SideNavSection title so pinned / recent read as two zones
    // (empty label used to drop the section chrome and blur the boundary).
    groups.push({ id: 'unpinned', label: copy.recent, sessions: unpinned });
  }
  return groups;
}

function formatSessionMeta(session: SessionSummary, locale: UiLocale): string {
  if (!session.lastMessageAt) return getConversationCopy(locale).chat.noMessages;
  return formatCompactTimestamp(session.lastMessageAt, Date.now(), locale);
}
